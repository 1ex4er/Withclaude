import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { newestAdm, parseAdmLine } from '../bot/src/adm.js';
import { SpamTracker, detectScam, hasInvite } from '../bot/src/automod-rules.js';
import { banFields, checkProvider, checkSteam, hasBans } from '../bot/src/bancheck.js';
import { steamToBeGuid } from '../bot/src/battleye.js';
import { openDb } from '../bot/src/db.js';
import { createHttpServer } from '../bot/src/http.js';
import { Links } from '../bot/src/links.js';
import { RateWindow } from '../bot/src/modules/antiraid.js';
import { MODULES } from '../bot/src/modules/index.js';
import { verifySteamCallback } from '../bot/src/steam.js';
import { parseDuration } from '../bot/src/util.js';
import { applyWhitelistChange, whitelistIds } from '../bot/src/whitelist.js';

const STEAM = '76561198000000001';

test('все команды бота валидны и не повторяются', () => {
  const cmds = MODULES.flatMap((m) => m.commands ?? []).map((c) => c.toJSON());
  const names = cmds.map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(new Set(MODULES.map((m) => m.name)).size, MODULES.length);
  assert.ok(cmds.length <= 100);
});

test('ADM: вход, выход, PvP, смерть, чат; посторонние строки игнорируются', () => {
  assert.deepEqual(parseAdmLine('12:00:01 | Player "Ivan" (id=AbC= pos=<1, 2, 3>) is connected'), { type: 'connect', time: '12:00:01', name: 'Ivan', id: 'AbC=' });
  assert.equal(parseAdmLine('12:00:01 | Player "Ivan"(id=AbC=) has been disconnected').type, 'disconnect');
  const pvp = parseAdmLine('12:00:01 | Player "Ivan" (DEAD) (id=A= pos=<1, 2, 3>) killed by Player "Petr" (id=B= pos=<4, 5, 6>) with M4A1 from 42.5 meters');
  assert.deepEqual([pvp.killer, pvp.victim, pvp.weapon, pvp.distance], ['Petr', 'Ivan', 'M4A1', 42.5]);
  assert.equal(parseAdmLine('12:00:01 | Player "Ivan" (DEAD) (id=A= pos=<1, 2, 3>) killed by Wolf').cause, 'Wolf');
  assert.equal(parseAdmLine('12:00:01 | Chat("Ivan"(id=A=)): привет').text, 'привет');
  assert.equal(parseAdmLine('12:00:01 | Player "Ivan" (id=A= pos=<1, 2, 3>)[HP: 50] hit by Player "P"'), null);
  assert.equal(parseAdmLine('мусор'), null);
  assert.equal(newestAdm([{ file: 'a.ADM', mtime: 1 }, { file: 'b.RPT', mtime: 9 }, { file: 'c.ADM', mtime: 5 }]), 'c.ADM');
});

test('вайтлист: добавление без дублей и удаление, сохраняет чужие строки', () => {
  let t = '// комментарий\r\n76561198000000002\r\n';
  t = applyWhitelistChange(t, { op: 'add', steamId: STEAM, note: 'Ivan#1' });
  t = applyWhitelistChange(t, { op: 'add', steamId: STEAM, note: 'Ivan#1' });
  assert.deepEqual(whitelistIds(t), ['76561198000000002', STEAM]);
  assert.ok(t.includes('\r\n') && t.startsWith('// комментарий'));
  t = applyWhitelistChange(t, { op: 'remove', steamId: '76561198000000002' });
  assert.deepEqual(whitelistIds(t), [STEAM]);
  assert.deepEqual(whitelistIds(applyWhitelistChange('', { op: 'add', steamId: STEAM, note: 'x\ny' })), [STEAM]);
});

test('BattlEye GUID из SteamID64', () => {
  const buf = Buffer.alloc(10);
  buf.write('BE');
  buf.writeBigUInt64LE(76561198000000001n, 2);
  assert.equal(steamToBeGuid(STEAM), crypto.createHash('md5').update(buf).digest('hex'));
  assert.match(steamToBeGuid(STEAM), /^[0-9a-f]{32}$/);
  assert.throws(() => steamToBeGuid('123'));
});

test('автомодерация: скам, инвайты, флуд, повторы', () => {
  assert.match(detectScam('Free nitro https://dlscord-gift.com/abc'), /поддельный домен/);
  assert.match(detectScam('забери бесплатно скины https://csgo-skins.ru/x'), /скам/);
  assert.equal(detectScam('гайд https://discord.com/channels/1/2 и https://steamcommunity.com/id/x'), null);
  assert.equal(detectScam('steamcomrnunity https://steamcomrnunity.com/trade'), 'поддельный домен steamcomrnunity.com');
  assert.equal(detectScam('обычное сообщение'), null);
  assert.ok(hasInvite('заходи discord.gg/abcd'));
  assert.ok(!hasInvite('discord.com/channels/1'));

  const s = new SpamTracker({ messages: 5, seconds: 5 }, 3);
  for (let n = 0; n < 4; n++) assert.equal(s.hit('u', `msg ${n}`, 1000 + n), null);
  assert.match(s.hit('u', 'msg 5', 1005), /флуд/);
  const d = new SpamTracker({ messages: 100, seconds: 5 }, 3);
  d.hit('u', 'КУПИ', 0);
  d.hit('u', 'купи', 10_000);
  assert.match(d.hit('u', 'купи ', 20_000), /повтор/);
});

test('антирейд: окно событий', () => {
  const w = new RateWindow(3, 10);
  assert.ok(!w.hit('g', 0));
  assert.ok(!w.hit('g', 1000));
  assert.ok(w.hit('g', 2000));
  assert.ok(!w.hit('x', 2000));
  assert.ok(!new RateWindow(3, 10).hit('g', 50_000));
});

test('сроки: 10m, 2ч, 3d', () => {
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('2ч'), 7_200_000);
  assert.equal(parseDuration('3d'), 259_200_000);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('бред'), undefined);
});

test('привязка Steam: токен одноразовый, один Steam — один Discord', () => {
  const links = new Links(openDb(':memory:'));
  const t1 = links.createToken('111');
  assert.equal(links.peekToken(t1), '111');
  assert.equal(links.complete(t1, STEAM).ok, true);
  assert.equal(links.peekToken(t1), null);
  const t2 = links.createToken('222');
  assert.equal(links.complete(t2, STEAM).ok, false);
  const t3 = links.createToken('111');
  assert.equal(links.complete(t3, '76561198000000009').previous, STEAM);
  assert.equal(links.get('111').steam_id, '76561198000000009');
  assert.equal(links.peekToken(links.createToken('333'), Date.now() + 16 * 60_000), null);
});

test('Steam OpenID: подпись проверяется у Steam, подмена return_to отклоняется', async () => {
  const returnTo = 'https://site/link/steam/callback?t=abc';
  const q = new URLSearchParams({
    'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.return_to': returnTo,
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${STEAM}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${STEAM}`,
    'openid.sig': 'x',
  });
  let sent;
  const ok = async (url, opts) => ((sent = opts.body), { text: async () => 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n' });
  const bad = async () => ({ text: async () => 'is_valid:false\n' });
  assert.equal(await verifySteamCallback(q, { expectedReturnTo: returnTo, fetchImpl: ok }), STEAM);
  assert.match(sent, /openid\.mode=check_authentication/);
  assert.equal(await verifySteamCallback(q, { expectedReturnTo: returnTo, fetchImpl: bad }), null);
  assert.equal(await verifySteamCallback(q, { expectedReturnTo: 'https://evil/cb', fetchImpl: ok }), null);
});

test('проверка банов: Steam API и подключаемая база', async () => {
  const fakeFetch = async (url) => ({
    ok: true,
    json: async () => {
      if (url.includes('GetPlayerBans')) return { players: [{ VACBanned: true, NumberOfVACBans: 1, DaysSinceLastBan: 10, NumberOfGameBans: 0, CommunityBanned: false, EconomyBan: 'none' }] };
      if (url.includes('GetPlayerSummaries')) return { response: { players: [{ personaname: 'Ivan', timecreated: 1_500_000_000, communityvisibilitystate: 3 }] } };
      if (url.includes('GetOwnedGames')) return { response: { games: [{ appid: 221100, playtime_forever: 600 }] } };
      if (url.includes('hunter')) return { bans: [{ reason: 'Cheats', project: 'Other RP', date: '2026-01-01' }] };
      throw new Error(url);
    },
  });
  const steam = await checkSteam(STEAM, 'key', fakeFetch);
  assert.equal(steam.banned, true);
  assert.equal(steam.info.dayzHours, 10);
  const he = await checkProvider({ name: 'HunterEye', url: 'https://hunter/check?s={steamId}', listField: 'bans', reasonField: 'reason', projectField: 'project', dateField: 'date' }, STEAM, fakeFetch);
  assert.deepEqual(he.details, [{ reason: 'Cheats', project: 'Other RP', date: '2026-01-01' }]);
  assert.ok(hasBans([steam, he]));
  const fields = banFields([he, { source: 'X', error: 'HTTP 500' }]);
  assert.match(fields[0].value, /Cheats — Other RP/);
  assert.match(fields[1].value, /не удалось/);
});

test('HTTP: старт привязки, неверный токен, API только с токеном', async () => {
  const links = new Links(openDb(':memory:'));
  const cfg = { publicUrl: 'https://blackout.test', secrets: { apiToken: 'secret-token' } };
  const agent = { attach() {}, call: async (action) => ({ action }) };
  const quiet = { info() {}, warn() {}, error() {} };
  const srv = createHttpServer({ cfg, links, agent, log: quiet });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const t = links.createToken('111');
    const r1 = await fetch(`${base}/link/steam/start?t=${t}`, { redirect: 'manual' });
    assert.equal(r1.status, 302);
    const loc = new URL(r1.headers.get('location'));
    assert.equal(loc.origin, 'https://steamcommunity.com');
    assert.equal(loc.searchParams.get('openid.return_to'), `https://blackout.test/link/steam/callback?t=${t}`);
    assert.equal((await fetch(`${base}/link/steam/start?t=wrong-token-wrong-token`)).status, 400);
    assert.equal((await fetch(`${base}/api/agent/call`, { method: 'POST', body: '{}' })).status, 401);
    const ok = await fetch(`${base}/api/agent/call`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-token' },
      body: JSON.stringify({ action: 'server.status' }),
    });
    assert.deepEqual(await ok.json(), { ok: true, result: { action: 'server.status' } });
  } finally {
    srv.close();
  }
});


test('настройки из /setup накладываются на конфиг и переживают перезапуск', async () => {
  const { applySettings, saveSetting } = await import('../bot/src/settings.js');
  const db = openDb(':memory:');
  const cfg = { roles: { admin: [], verified: '' }, channels: {} };
  saveSetting(cfg, db, 'roles.admin', ['1', '2']);
  saveSetting(cfg, db, 'channels.modLog', '3');
  assert.deepEqual(cfg.roles.admin, ['1', '2']);
  const fresh = applySettings({ roles: { admin: [], verified: '' }, channels: {} }, db);
  assert.deepEqual(fresh.roles.admin, ['1', '2']);
  assert.equal(fresh.channels.modLog, '3');
});

test('бот без ключей агента запускается, управление сервером просто недоступно', async () => {
  const { AgentLink } = await import('../bot/src/agent.js');
  const warns = [];
  const link = new AgentLink({ agent: { id: 'x', sitePrivateKey: '/нет/site.pem', agentPublicKey: '/нет/agent.pem' }, http: { host: '127.0.0.1' } }, { warn: (m) => warns.push(m), info() {} });
  assert.equal(link.online, false);
  link.attach({ on() {} });
  await assert.rejects(link.call('server.status'), { code: 'agent_offline' });
  assert.match(warns[0], /управление сервером выключено/);
});

function fakeInteraction(kind) {
  const calls = [];
  const i = {
    replied: false,
    deferred: false,
    isChatInputCommand: () => kind === 'command',
    isContextMenuCommand: () => false,
    isMessageComponent: () => kind === 'button',
    isModalSubmit: () => false,
    reply: async (p) => (calls.push(['reply', p]), (i.replied = true)),
    update: async (p) => (calls.push(['update', p]), (i.replied = true)),
    deferReply: async (p) => (calls.push(['deferReply', p]), (i.deferred = true)),
    deferUpdate: async () => (calls.push(['deferUpdate']), (i.deferred = true)),
    editReply: async (p) => calls.push(['editReply', p]),
    followUp: async (p) => calls.push(['followUp', p]),
  };
  return { i, calls };
}

test('медленная команда: бот откладывает ответ, а потом редактирует его', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { autoDefer } = await import('../bot/src/core.js');
  const { i, calls } = fakeInteraction('command');
  const settle = autoDefer(i);
  t.mock.timers.tick(2100);
  await i.reply({ content: 'готово', flags: 64 });
  settle();
  assert.deepEqual(calls.map((c) => c[0]), ['deferReply', 'editReply']);
  assert.deepEqual(calls[1][1], { content: 'готово' });
});

test('быстрая команда отвечает как обычно', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { autoDefer } = await import('../bot/src/core.js');
  const { i, calls } = fakeInteraction('command');
  const settle = autoDefer(i);
  await i.reply({ content: 'ok' });
  t.mock.timers.tick(5000);
  settle();
  assert.deepEqual(calls.map((c) => c[0]), ['reply']);
});

test('медленная кнопка: update идёт в исходное сообщение, reply — отдельным сообщением', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { autoDefer } = await import('../bot/src/core.js');
  const a = fakeInteraction('button');
  autoDefer(a.i);
  t.mock.timers.tick(2100);
  await a.i.update({ content: 'x' });
  assert.deepEqual(a.calls.map((c) => c[0]), ['deferUpdate', 'editReply']);
  const b = fakeInteraction('button');
  autoDefer(b.i);
  t.mock.timers.tick(2100);
  await b.i.reply({ content: 'роль выдана' });
  assert.deepEqual(b.calls.map((c) => c[0]), ['deferUpdate', 'followUp']);
});

test('SteamID из текста: ссылки, SteamID64, STEAM_0, [U:1], короткие ссылки', async () => {
  const { parseSteamInput, resolveSteamInput } = await import('../bot/src/steamid.js');
  assert.deepEqual(parseSteamInput('76561198000000001'), { steamId: '76561198000000001' });
  assert.deepEqual(parseSteamInput(' https://steamcommunity.com/profiles/76561198000000001/ '), { steamId: '76561198000000001' });
  assert.deepEqual(parseSteamInput('STEAM_0:1:19867136'), { steamId: '76561198000000001' });
  assert.deepEqual(parseSteamInput('[U:1:39734273]'), { steamId: '76561198000000001' });
  assert.deepEqual(parseSteamInput('https://steamcommunity.com/id/gaben'), { vanity: 'gaben' });
  assert.ok(parseSteamInput('12345').error);
  const fakeFetch = async () => ({ json: async () => ({ response: { success: 1, steamid: '76561197960287930' } }) });
  assert.deepEqual(await resolveSteamInput('steamcommunity.com/id/gaben', { apiKey: 'k', fetchImpl: fakeFetch }), { steamId: '76561197960287930' });
  assert.ok((await resolveSteamInput('gaben', { apiKey: '' })).error);
});

test('ручная привязка Steam не перебивает чужой и подтверждённый Steam', () => {
  const links = new Links(openDb(':memory:'));
  assert.equal(links.setManual('1', STEAM).ok, true);
  assert.equal(links.get('1').method, 'manual');
  assert.equal(links.setManual('2', STEAM).ok, false);
  links.complete(links.createToken('3'), '76561198000000003');
  assert.equal(links.setManual('3', '76561198000000004').ok, false);
  assert.equal(links.get('3').method, 'openid');
  // Вход через Steam поверх ручной привязки — становится подтверждённым.
  links.complete(links.createToken('1'), STEAM);
  assert.equal(links.get('1').method, 'openid');
});
