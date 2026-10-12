import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isAllowed, loadConfig, readBattlEyeConfig } from '../agent/src/config.js';

function writeConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

test('allow: шаблоны действий', () => {
  assert.ok(isAllowed(['*'], 'server.stop'));
  assert.ok(isAllowed(['lx.*'], 'lx.read'));
  assert.ok(!isAllowed(['lx.*'], 'lxx.read'));
  assert.ok(!isAllowed(['lx.*', 'server.status'], 'server.stop'));
  assert.ok(isAllowed(['server.status'], 'server.status'));
});

test('сайт по лицензии по умолчанию получает только права LX', () => {
  const cfg = loadConfig(writeConfig({
    server: { dir: '.' },
    hubs: [
      { name: 'lx', url: 'wss://lxmodschngz.ru/agent-ws', license: 'LX-1234-5678' },
      { name: 'site', url: 'wss://blackoutstalkerrp.ru/agent-ws', agentId: 'blackout-main', sitePublicKey: 'k.pem' },
    ],
  }));
  assert.deepEqual(cfg.hubs[0].allow, ['agent.info', 'server.status', 'lx.*']);
  assert.deepEqual(cfg.hubs[1].allow, ['*']);
  assert.ok(path.isAbsolute(cfg.hubs[1].sitePublicKey));
});

test('агент только с сайтом LX не управляет процессом сервера, со своим сайтом — управляет', () => {
  const lxOnly = loadConfig(writeConfig({ server: { dir: '.' }, hubs: [{ name: 'lx', url: 'wss://lxmodschngz.ru/agent-ws', license: 'LX-1234-5678' }] }));
  assert.equal(lxOnly.server.manage, false);
  const both = loadConfig(writeConfig({
    server: { dir: '.' },
    hubs: [
      { name: 'lx', url: 'wss://lxmodschngz.ru/agent-ws', license: 'LX-1234-5678' },
      { name: 'site', url: 'wss://blackoutstalkerrp.ru/agent-ws', agentId: 'blackout-main', sitePublicKey: 'k.pem' },
    ],
  }));
  assert.equal(both.server.manage, true);
  const forced = loadConfig(writeConfig({ server: { dir: '.', manage: false }, hubs: [{ name: 'site', url: 'wss://a.ru/agent-ws', agentId: 'abc', sitePublicKey: 'k.pem' }] }));
  assert.equal(forced.server.manage, false);
});

test('незашифрованный адрес сайта запрещён', () => {
  assert.throws(() => loadConfig(writeConfig({ server: { dir: '.' }, hubs: [{ name: 'xx', url: 'ws://a/b' }] })), /wss/);
  assert.throws(() => loadConfig(writeConfig({ server: { dir: '.' }, hubs: [{ name: 'xx', url: 'wss://a', allow: ['rm -rf'] }] })), /allow/);
});

test('пароль RCon читается из конфига BattlEye', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-be-'));
  fs.mkdirSync(path.join(dir, 'battleye'));
  fs.writeFileSync(path.join(dir, 'battleye', 'beserver_x64.cfg'), 'RConPassword s3cret\nRConPort 2310\nRestrictRCon 0\n');
  assert.deepEqual(readBattlEyeConfig({ dir, bePath: 'battleye', profiles: 'profiles' }), { password: 's3cret', port: 2310, passwords: ['s3cret'] });
});

test('RCon как на ark-hoster: действующий пароль и порт — в active, старый пароль — в обычном файле', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-be-'));
  const be = { dir, bePath: 'battleye', profiles: 'profiles' };
  fs.mkdirSync(path.join(dir, 'battleye'));
  fs.mkdirSync(path.join(dir, 'profiles', 'BattlEye'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'battleye', 'BEServer_x64.cfg'), 'RConPassword stale\n');
  fs.writeFileSync(path.join(dir, 'profiles', 'BattlEye', 'BEServer_x64.cfg'), 'RConPort 2399\n');
  fs.writeFileSync(path.join(dir, 'battleye', 'BEServer_x64_active_28a9.cfg'), 'RConPassword s3cret\nRConPort 2305\n');
  assert.deepEqual(readBattlEyeConfig(be), { password: 's3cret', port: 2305, passwords: ['s3cret', 'stale'] });
  // Пароль только в обычном файле, порт — только в active.
  fs.writeFileSync(path.join(dir, 'battleye', 'BEServer_x64_active_28a9.cfg'), 'RConPort 2305\n');
  assert.deepEqual(readBattlEyeConfig(be), { password: 'stale', port: 2305, passwords: ['stale'] });
});
