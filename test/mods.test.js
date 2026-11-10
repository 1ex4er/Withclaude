import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { folderNameFor, ModManager } from '../agent/src/mods.js';
import { StateStore } from '../agent/src/state.js';

const log = { info() {}, warn() {}, error() {} };

// Папка сервера, SteamCMD-заглушка: "+workshop_download_item 221100 <id>" кладёт мод в кэш.
function setup(workshop) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lxmods-'));
  const serverDir = path.join(root, 'server');
  const steamDir = path.join(root, 'steamcmd');
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(steamDir, { recursive: true });
  const calls = [];
  const runImpl = async (_exe, args) => {
    calls.push(args);
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '+workshop_download_item') continue;
      const id = args[i + 2];
      const mod = workshop[id];
      if (!mod) continue;
      const dir = path.join(steamDir, 'steamapps', 'workshop', 'content', '221100', id);
      fs.mkdirSync(path.join(dir, 'addons'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
      // like SteamCMD: files that did not change in Workshop are left as they are
      const put = (file, content) => {
        if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content);
      };
      put(path.join(dir, 'meta.cpp'), `protocol = 1;\npublishedid = ${id};\nname = "${mod.name}";\n`);
      put(path.join(dir, 'addons', 'a.pbo'), mod.version);
      put(path.join(dir, 'keys', `${id}.bikey`), 'key');
    }
  };
  const state = new StateStore(path.join(root, 'state.json'));
  const mods = new ModManager({ serverDir, steamcmd: { path: path.join(steamDir, 'steamcmd.exe') }, steamUser: 'bot', log, state, runImpl });
  return { serverDir, mods, calls, state };
}

const settle = (mods) => mods.queue;

test('folder name from the Workshop title', () => {
  assert.equal(folderNameFor('STALKER NewHorizon Objects (Legacy)', '1'), '@STALKER NewHorizon Objects (Legacy)');
  assert.equal(folderNameFor('Мутанты', '3812171981'), '@3812171981');
  assert.equal(folderNameFor('Dabs  Framework!', '2'), '@Dabs Framework');
});

test('install by Workshop ID: new folder, keys, then refused as already installed', async () => {
  const { serverDir, mods } = setup({ 1559212036: { name: 'Community Framework', version: 'v1' } });
  const job = mods.install('1559212036');
  assert.equal(job.status, 'queued');
  await settle(mods);
  assert.equal(job.status, 'done', job.message);
  assert.equal(job.folder, '@Community Framework');
  assert.equal(fs.readFileSync(path.join(serverDir, '@Community Framework', 'addons', 'a.pbo'), 'utf8'), 'v1');
  assert.ok(fs.existsSync(path.join(serverDir, 'keys', '1559212036.bikey')));
  assert.throws(() => mods.install('1559212036'), /уже установлен/);
  assert.throws(() => mods.install('12ab'), /6–12 цифр/);
});

test('install into a given folder name (the one already in the mod list after a move)', async () => {
  const { serverDir, mods } = setup({ 2469798930: { name: 'STALKER: DayZone | Map Public', version: 'm1' } });
  const job = mods.install('2469798930', '@STALKER DayZone  Map Public');
  await settle(mods);
  assert.equal(job.status, 'done', job.message);
  assert.ok(fs.existsSync(path.join(serverDir, '@STALKER DayZone  Map Public', 'addons', 'a.pbo')));
  assert.throws(() => mods.install('2469798931', '@STALKER DayZone  Map Public'), /уже есть/);
  assert.throws(() => mods.install('2469798931', 'no-at'), /Недопустимое имя/);
});

test('a mod that does not download is an error job', async () => {
  const { mods, calls } = setup({});
  const job = mods.install('123456789');
  await settle(mods);
  assert.equal(job.status, 'error');
  assert.equal(calls.length, 2, 'one retry');
});

test('update one mod: server stopped -> copied now, running -> pending until the next start', async () => {
  const workshop = { 555555: { name: 'Map', version: 'v1' } };
  const { serverDir, mods } = setup(workshop);
  mods.install('555555');
  await settle(mods);
  const file = path.join(serverDir, '@Map', 'addons', 'a.pbo');

  workshop[555555].version = 'v2';
  await new Promise((r) => setTimeout(r, 20));
  const stopped = mods.updateOne('@Map', { serverRunning: async () => false });
  await settle(mods);
  assert.equal(stopped.status, 'done', stopped.message);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v2');

  workshop[555555].version = 'v3';
  const running = mods.updateOne('@Map', { serverRunning: async () => true });
  await settle(mods);
  assert.equal(running.status, 'pending');
  assert.equal(fs.readFileSync(file, 'utf8'), 'v2', 'not touched while the server runs');
  assert.deepEqual(mods.pending(), ['@Map']);
  assert.equal(mods.list({ mods: [], serverMods: [] })[0].pendingUpdate, true);

  await mods.applyPending();
  assert.equal(fs.readFileSync(file, 'utf8'), 'v3');
  assert.deepEqual(mods.pending(), []);
});

test('scheduled update: all workshop mods in one SteamCMD run, unchanged ones not copied', async () => {
  const workshop = { 111111: { name: 'A (Legacy)', version: 'a1' }, 222222: { name: 'Bravo', version: 'b1' } };
  const { serverDir, mods, calls } = setup(workshop);
  mods.install('111111');
  mods.install('222222');
  await settle(mods);
  fs.mkdirSync(path.join(serverDir, '@Local'));
  assert.deepEqual(mods.workshopOnly(['@A (Legacy)', '@Bravo', '@Local']), ['@A (Legacy)', '@Bravo']);

  workshop[222222].version = 'b2';
  calls.length = 0;
  await new Promise((r) => setTimeout(r, 20));
  const results = await mods.update(['@A (Legacy)', '@Bravo']);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('validate'));
  assert.deepEqual(
    results.map((r) => [r.folder, r.ok, r.changed]),
    [
      ['@A (Legacy)', true, false],
      ['@Bravo', true, true],
    ],
  );
  assert.equal(fs.readFileSync(path.join(serverDir, '@Bravo', 'addons', 'a.pbo'), 'utf8'), 'b2');
});

test('without SteamCMD settings the actions explain what is missing', () => {
  const mods = new ModManager({ serverDir: os.tmpdir(), steamcmd: null, steamUser: '', log });
  assert.equal(mods.configured, false);
  assert.throws(() => mods.install('123456'), /steamcmd\.path/);
});
