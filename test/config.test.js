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

test('незашифрованный адрес сайта запрещён', () => {
  assert.throws(() => loadConfig(writeConfig({ server: { dir: '.' }, hubs: [{ name: 'xx', url: 'ws://a/b' }] })), /wss/);
  assert.throws(() => loadConfig(writeConfig({ server: { dir: '.' }, hubs: [{ name: 'xx', url: 'wss://a', allow: ['rm -rf'] }] })), /allow/);
});

test('пароль RCon читается из конфига BattlEye', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-be-'));
  fs.mkdirSync(path.join(dir, 'battleye'));
  fs.writeFileSync(path.join(dir, 'battleye', 'beserver_x64.cfg'), 'RConPassword s3cret\nRConPort 2310\nRestrictRCon 0\n');
  assert.deepEqual(readBattlEyeConfig({ dir, bePath: 'battleye', profiles: 'profiles' }), { password: 's3cret', port: 2310 });
});
