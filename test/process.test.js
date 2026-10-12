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

test('manage: false — старт/стоп/рестарт отклоняются при любом allow, статус работает', async () => {
  const { createActions } = await import('../agent/src/actions.js');
  const calls = [];
  const server = {
    cfg: { manage: false },
    status: async () => ({ running: true, manage: false }),
    start: async () => calls.push('start'),
    stop: async () => calls.push('stop'),
    restart: async () => calls.push('restart'),
    restartIn: () => calls.push('restartIn'),
    setSchedule: () => calls.push('setSchedule'),
    getSchedule: () => [],
    cancelPlannedRestart: () => {},
  };
  const actions = createActions({ server, rcon: {}, files: {}, lxFiles: {}, lxModPrefix: '@LX', logs: {}, mods: {}, rconCfg: {}, info: () => ({}) });
  for (const a of ['server.start', 'server.stop', 'server.restart', 'server.restartIn', 'server.setSchedule']) {
    assert.throws(() => actions[a]({ minutes: 5, restarts: [] }), (e) => e.code === 'denied', a);
  }
  assert.deepEqual(calls, []);
  assert.equal((await actions['server.status']()).manage, false);
  server.cfg.manage = true;
  await actions['server.start']({});
  assert.deepEqual(calls, ['start']);
});

function scheduled(schedule) {
  const s = setup();
  const said = [];
  s.schedule = { restarts: ['16:00'], warnMinutes: [30, 15, 5, 3], warnMessage: 'через {min} мин', kick: { beforeMinutes: 2, warnSeconds: 30, warnMessage: 'кик через {sec} сек', reason: 'Рестарт' }, ...schedule };
  s.rcon = {
    connected: true,
    close() {},
    command: async (cmd) => {
      said.push(cmd);
      return cmd === 'players' ? '0   1.2.3.4:2304  50   abcdefabcdefabcdefabcdefabcdefab(OK) Стрелок\n1   5.6.7.8:2304  70   -  Меченый (Lobby)\n' : '';
    },
  };
  s.restart = async () => said.push('RESTART');
  return { s, said };
}

test('рестарт по расписанию: 30/15/5/3 мин, предупреждение о кике, #lock, кик всех за 2 мин, рестарт ровно один раз', async () => {
  const { s, said } = scheduled();
  const at = (h, m, sec = 0) => new Date(2026, 9, 12, h, m, sec).getTime();
  for (let t = at(15, 25); t <= at(16, 1); t += 5000) await s.scheduleStep(true, t);
  assert.deepEqual(said, [
    'say -1 через 30 мин',
    'say -1 через 15 мин',
    'say -1 через 5 мин',
    'say -1 через 3 мин',
    'say -1 кик через 30 сек',
    '#lock',
    'players',
    'kick 0 Рестарт',
    'kick 1 Рестарт',
    'RESTART',
  ]);
  // Следующий рестарт — уже завтра в 16:00, а не повтор сегодня.
  await s.scheduleStep(true, at(16, 2));
  assert.equal(s.nextRestart, new Date(2026, 9, 13, 16, 0).getTime());
});

test('«рестарт через N мин»: одно предупреждение с настоящим остатком, кик не раньше чем через 30 с после предупреждения', async () => {
  const { s, said } = scheduled({ restarts: [] });
  const t0 = new Date(2026, 9, 12, 12, 0).getTime();
  s.nextRestart = t0 + 5 * 60_000;
  s.manualRestart = true;
  await s.scheduleStep(true, t0);
  assert.deepEqual(said, ['say -1 через 5 мин']);
  said.length = 0;
  // Рестарт через 1 минуту: кик-время уже прошло, но кик — только через 30 с после предупреждения.
  const { s: s2, said: said2 } = scheduled({ restarts: [] });
  s2.nextRestart = t0 + 60_000;
  s2.manualRestart = true;
  await s2.scheduleStep(true, t0);
  assert.deepEqual(said2, ['say -1 через 1 мин', 'say -1 кик через 30 сек']);
  await s2.scheduleStep(true, t0 + 20_000);
  assert.ok(!said2.includes('RESTART'));
  await s2.scheduleStep(true, t0 + 30_000);
  assert.equal(said2.at(-1), 'RESTART');
});

test('без кика (kick: null) рестарт ровно в назначенное время', async () => {
  const { s, said } = scheduled({ kick: null, warnMinutes: [5] });
  const at = (h, m) => new Date(2026, 9, 12, h, m).getTime();
  for (let t = at(15, 57); t <= at(16, 0) + 5000; t += 5000) await s.scheduleStep(true, t);
  assert.deepEqual(said, ['say -1 через 3 мин', 'RESTART']);
});

test('расписание по МСК независимо от часового пояса Windows', async () => {
  const { s } = scheduled({ timeZone: 'Europe/Moscow', restarts: ['16:00', '00:00'] });
  await s.scheduleStep(true, Date.UTC(2026, 9, 12, 12, 55)); // 15:55 МСК
  assert.equal(s.nextRestart, Date.UTC(2026, 9, 12, 13, 0)); // 16:00 МСК
  const { s: late } = scheduled({ timeZone: 'Europe/Moscow', restarts: ['00:00'] });
  await late.scheduleStep(true, Date.UTC(2026, 9, 31, 20, 0)); // 23:00 МСК 31 октября
  assert.equal(late.nextRestart, Date.UTC(2026, 9, 31, 21, 0)); // 00:00 МСК 1 ноября
});

test('выбор процесса сервера: самый свежий из своей папки, без зависших и процессов без потоков', async () => {
  const { pickServerProcess } = await import('../agent/src/process.js');
  const exe = path.join(os.tmpdir(), 'gs', 'Server', 'DayZServer_x64.exe');
  const other = path.join(os.tmpdir(), 'other', 'DayZServer_x64.exe');
  const list = [
    { ProcessId: 95664, ExecutablePath: exe, ThreadCount: 0, Created: '2026-10-01T01:03:45Z' },
    { ProcessId: 572868, ExecutablePath: exe, ThreadCount: 0, Created: '2026-10-06T00:22:59Z' },
    { ProcessId: 700, ExecutablePath: other, ThreadCount: 90, Created: '2026-10-12T12:30:00Z' },
    { ProcessId: 800, ExecutablePath: exe, ThreadCount: 85, Created: '2026-10-12T12:05:00Z' },
    { ProcessId: 801, ExecutablePath: exe, ThreadCount: 80, Created: '2026-10-12T09:00:00Z' },
  ];
  assert.equal(pickServerProcess(list, exe).pid, 800);
  assert.equal(pickServerProcess(list, exe, new Set([800])).pid, 801);
  assert.equal(pickServerProcess(list.slice(0, 2), exe), null);
});
