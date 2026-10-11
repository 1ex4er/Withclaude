import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ServerProcess } from '../agent/src/process.js';
import { StateStore } from '../agent/src/state.js';

const quiet = { info() {}, warn() {}, error() {} };
const fakeRcon = { connected: false, command: async () => { throw new Error('нет rcon'); }, close() {}, connect: async () => {} };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-proc-'));
  fs.mkdirSync(path.join(dir, '@CF'));
  const exe = 'fake-server.sh';
  fs.writeFileSync(path.join(dir, exe), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const cfg = {
    server: { dir, exe, config: 'serverDZ.cfg', port: 2302, profiles: 'profiles', bePath: 'battleye', extraArgs: ['-dologs'], mods: ['@CF'], serverMods: [], autoRestartOnCrash: true, stopTimeoutSec: 1 },
    schedule: { restarts: [], warnMinutes: [5], warnMessage: 'через {min}' },
  };
  return new ServerProcess({ cfg, state: new StateStore(path.join(dir, 'state.json')), rcon: fakeRcon, log: quiet });
}

test('строка запуска собирается из конфига и проверенных модов', () => {
  const s = setup();
  assert.deepEqual(s.buildArgs(), ['-config=serverDZ.cfg', '-port=2302', '-profiles=profiles', '-BEpath=battleye', '-dologs', '-mod=@CF']);
  assert.throws(() => s.setMods({ mods: ['@CF;-something'], serverMods: [] }), { code: 'bad_params' });
  assert.throws(() => s.setMods({ mods: ['@Missing'], serverMods: [] }), { code: 'not_found' });
  assert.throws(() => s.setMods({ mods: ['@..'], serverMods: [] }));
});

test('расписание принимает только ЧЧ:ММ', () => {
  const s = setup();
  assert.deepEqual(s.setSchedule(['16:00', '04:00', '04:00']), ['04:00', '16:00']);
  assert.throws(() => s.setSchedule(['25:00']), { code: 'bad_params' });
  assert.throws(() => s.setSchedule('04:00'), { code: 'bad_params' });
});

test('старт, повторный старт, стоп с принудительным завершением', { skip: process.platform === 'win32' }, async () => {
  const s = setup();
  const r = await s.start();
  assert.ok(r.pid);
  assert.ok(await s.isAlive());
  assert.deepEqual(await s.start(), { alreadyRunning: true, pid: r.pid });
  await s.stop();
  assert.ok(!(await s.isAlive()));
  assert.equal((await s.status()).desired, 'stopped');
});
