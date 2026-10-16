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

test('API сайта: привязка с сайта, карточка игрока, вайтлист, агент не в сети', async () => {
  const { createSiteApi } = await import('../bot/src/site-api.js');
  const db = openDb(':memory:');
  const links = new Links(db);
  const linked = [];
  const changes = [];
  const ctx = {
    db,
    links,
    log: { warn() {} },
    agent: { online: false },
    emitLinked: async (...args) => linked.push(args),
    whitelist: {
      change: async (...args) => (changes.push(args), false),
      list: async () => Promise.reject(Object.assign(new Error('offline'), { code: 'agent_offline' })),
    },
  };
  const cfg = { publicUrl: 'https://blackout.test', secrets: { apiToken: 'secret-token' } };
  const srv = createHttpServer({ cfg, links, agent: { attach() {} }, log: ctx.log, siteApi: createSiteApi(ctx) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const api = (path, body) =>
    fetch(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer secret-token' },
      body: body && JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 401);
    assert.deepEqual(await (await api('/api/health')).json(), { bot: false, agent: false });

    // Ручная привязка заменяется подтверждённой сайтом; повтор ничего не меняет.
    links.setManual('111111111111111111', '76561198000000009');
    const r1 = await (await api('/api/link', { discordId: '111111111111111111', steamId: STEAM })).json();
    assert.deepEqual(r1, { ok: true, changed: true, previous: '76561198000000009' });
    assert.equal(links.get('111111111111111111').method, 'site');
    assert.equal((await (await api('/api/link', { discordId: '111111111111111111', steamId: STEAM })).json()).changed, false);
    assert.equal(linked.length, 1);
    // Подтверждённую привязку вручную не перебить, чужой Steam сайтом не перехватить.
    assert.equal(links.setManual('111111111111111111', '76561198000000009').ok, false);
    assert.equal((await api('/api/link', { discordId: '222222222222222222', steamId: STEAM })).status, 409);
    assert.equal((await api('/api/link', { discordId: 'x', steamId: STEAM })).status, 400);

    db.prepare('INSERT INTO warns (discord_id, mod_id, reason, created_at) VALUES (?, ?, ?, ?)').run('111111111111111111', '9', 'флуд', 1);
    const p = await (await api(`/api/profile?steamId=${STEAM}`)).json();
    assert.equal(p.discordId, '111111111111111111');
    assert.equal(p.warns[0].reason, 'флуд');
    assert.deepEqual(p.tickets, { total: 0, open: 0 });
    assert.equal((await (await api('/api/profile?steamId=76561198000000123')).json()).link, null);

    assert.deepEqual(await (await api('/api/whitelist', { op: 'add', steamId: STEAM, note: 'site' })).json(), { ok: true, applied: false });
    assert.deepEqual(changes, [['add', STEAM, 'site']]);
    assert.equal((await api('/api/whitelist', { op: 'drop', steamId: STEAM })).status, 400);
    assert.equal((await api('/api/whitelist')).status, 503);
    assert.equal((await api('/api/nope')).status, 404);
  } finally {
    srv.close();
  }
});

test('оповещения с сайта: упоминания только выбранных ролей, пустое не уходит, без бота — понятная ошибка', async () => {
  const { buildMessage, sendAnnouncement } = await import('../bot/src/announce.js');
  const m = buildMessage({
    content: 'Сбор у бара',
    mentionRoles: ['123456789012345678', 'bad'],
    embed: { title: 'Выброс', description: 'Через час', color: '#24c9ab', image: 'javascript:alert(1)', fields: [{ name: 'Где', value: 'Бар' }, { name: '', value: 'x' }] },
  });
  assert.equal(m.content, '<@&123456789012345678>\nСбор у бара');
  assert.deepEqual(m.allowedMentions, { parse: [], roles: ['123456789012345678'] });
  const e = m.embeds[0].toJSON();
  assert.equal(e.title, 'Выброс');
  assert.equal(e.image, undefined);
  assert.equal(e.fields.length, 1);
  assert.deepEqual(buildMessage({ mentionEveryone: true, content: 'a' }).allowedMentions.parse, ['everyone']);
  assert.throws(() => buildMessage({ content: '  ', embed: { title: '' } }), /Пустое/);
  await assert.rejects(sendAnnouncement({ cfg: { guildId: '1' }, client: null, log: {} }, { channelId: '123456789012345678', content: 'x' }), /Бот не в сети/);
  await assert.rejects(sendAnnouncement({ cfg: { guildId: '1' }, client: null, log: {} }, { channelId: 'x', content: 'x' }), { status: 400 });
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

test('верификация с одобрением: заявка → модератор принимает → роль выдаётся один раз', async () => {
  const verify = (await import('../bot/src/modules/verify.js')).default;
  const db = openDb(':memory:');
  const posted = [];
  const roles = new Set();
  const member = {
    id: '111111111111111111',
    user: { id: '111111111111111111', tag: 'player', createdTimestamp: Date.now() - 400 * 86400e3, displayAvatarURL: () => '' },
    joinedTimestamp: Date.now(),
    roles: { cache: roles, add: async (r) => roles.add(r), remove: async (r) => roles.delete(r) },
    send: async () => {},
  };
  const ctx = {
    cfg: { roles: { verified: 'V', unverified: '', admin: [], moderator: ['M'], support: [] }, verify: { manualApproval: true, askSteam: true, minAccountAgeDays: 3 }, channels: {}, banCheck: { alertOnLink: false, providers: [] } },
    db,
    links: new Links(db),
    log: { warn() {}, info() {} },
    post: async (ch, p) => posted.push([ch, p]),
    audit: async () => {},
    level: (m) => (m.roles.cache.has('M') ? 2 : 0),
    require(i, lvl) {
      if (this.level(i.member) < lvl) throw new Error('нет прав');
    },
  };
  ctx.links.setManual(member.id, STEAM);
  // Игрок прошёл «нажми картинку», Steam уже указан → заявка.
  let updated;
  const challengeI = { user: member.user, member, update: async (p) => (updated = p), showModal: async () => {} };
  await verify.onComponent({ ...challengeI, reply: async () => {} }, ctx, ['start']).catch(() => {});
  // Достаём заявку напрямую: симулируем правильный ответ через complete().
  const pendingBefore = db.kv.get('verify.pending', {});
  assert.equal(Object.keys(pendingBefore).length, 0);
  db.kv.set('verify.pending', { [member.id]: { at: Date.now(), steamId: STEAM } });
  await assert.rejects(verify.onComponent({ user: member.user, member }, ctx, ['start']), /на рассмотрении/);

  const mod = { roles: { cache: new Set(['M']) } };
  const guild = { members: { fetch: async () => member } };
  const { autoDefer } = await import('../bot/src/core.js');
  const button = (who) => {
    const i = {
      message: { embeds: [] },
      user: { id: '222222222222222222', tag: 'mod' },
      member: who,
      guild,
      replied: false,
      deferred: false,
      isChatInputCommand: () => false,
      isContextMenuCommand: () => false,
      isMessageComponent: () => true,
      isModalSubmit: () => false,
      reply: async () => {},
      update: async (p) => (updated = p),
      deferReply: async () => {},
      deferUpdate: async () => (i.deferred = true),
      editReply: async (p) => (updated = p),
    };
    autoDefer(i);
    return i;
  };
  const decision = button(mod);
  await verify.onComponent(decision, ctx, ['approve', member.id]);
  assert.ok(roles.has('V'));
  assert.equal(updated.components[0].components[0].data.disabled, true);
  await assert.rejects(verify.onComponent(button(mod), ctx, ['approve', member.id]), /уже рассмотрена/);
  await assert.rejects(verify.onComponent(button({ roles: { cache: new Set() } }), ctx, ['approve', member.id]), /нет прав/);
  void posted;
});

test('бэкап базы: файл создаётся, старые удаляются', async () => {
  const { makeBackup, listBackups } = await import('../bot/src/backup.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-backup-'));
  const db = openDb(':memory:');
  db.kv.set('x', 1);
  for (let n = 0; n < 4; n++) makeBackup(db, dir, 3, new Date(Date.UTC(2026, 0, 1, 0, 0, n)));
  const files = listBackups(dir);
  assert.equal(files.length, 3);
  assert.equal(files[0].file, 'bot-2026-01-01_00-00-01.db');
  const restored = openDb(path.join(dir, files.at(-1).file));
  assert.equal(restored.kv.get('x'), 1);
});

test('RP-наказание: выдаётся роль, повтор заменяет, по сроку снимается', async () => {
  const mod = (await import('../bot/src/modules/punishments.js')).default;
  const db = openDb(':memory:');
  const roles = new Set();
  const target = {
    id: '333333333333333333',
    manageable: true,
    roles: { highest: { position: 1 }, cache: roles, add: async (r) => roles.add(r), remove: async (r) => roles.delete(r) },
    send: async () => {},
  };
  const audits = [];
  const ctx = {
    db,
    cfg: { punishments: { roles: { nonrp: 'R_NONRP' } } },
    log: { warn() {} },
    guild: () => ({ members: { fetch: async () => target } }),
    audit: async (t) => audits.push(t),
    require() {},
  };
  const replies = [];
  const cmd = (name, opts) => ({
    commandName: name,
    user: { id: '444444444444444444', tag: 'mod' },
    member: { id: '444444444444444444', roles: { highest: { position: 10 } } },
    client: { user: { id: 'bot' } },
    guild: { ownerId: 'owner', members: { fetch: async () => target } },
    options: {
      getUser: () => ({ id: target.id, tag: 'player' }),
      getMember: () => target,
      getString: (k) => opts[k] ?? null,
    },
    deferReply: async () => {},
    editReply: async (p) => replies.push(p),
    reply: async (p) => replies.push(p),
  });
  await mod.onCommand(cmd('punish', { type: 'nonrp', reason: 'RDM на базе', duration: '1h' }), ctx);
  assert.ok(roles.has('R_NONRP'));
  await mod.onCommand(cmd('punish', { type: 'nonrp', reason: 'повтор', duration: '2h' }), ctx);
  const active = db.prepare('SELECT * FROM punishments WHERE removed_at IS NULL').all();
  assert.equal(active.length, 1);
  assert.equal(active[0].reason, 'повтор');
  await assert.rejects(mod.onCommand(cmd('punish', { type: 'meta', reason: 'x' }), ctx), /не выбрана/);
  // Срок истёк → init-тик снимает роль.
  db.prepare('UPDATE punishments SET expires_at = ? WHERE removed_at IS NULL').run(Date.now() - 1000);
  mod.init(ctx);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!roles.has('R_NONRP'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM punishments WHERE removed_by = ?').get('auto').n, 1);
});

test('HTTP-нажатия: подпись Discord проверяется, первый ответ уходит в HTTP, остальные — в REST', async () => {
  const { HttpInteractions, publicKeyFromHex } = await import('../bot/src/http-interactions.js');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const hex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  assert.ok(publicKeyFromHex(hex));
  const hi = new HttpInteractions({ publicKeyHex: hex, log: { warn() {}, error() {} } });
  const sign = (body, t = '1700000000') => ({
    'x-signature-ed25519': crypto.sign(null, Buffer.concat([Buffer.from(t), Buffer.from(body)]), privateKey).toString('hex'),
    'x-signature-timestamp': t,
  });

  const ping = JSON.stringify({ type: 1 });
  assert.deepEqual(await hi.handle(sign(ping), Buffer.from(ping)), { status: 200, body: { type: 1 } });
  assert.equal((await hi.handle({ ...sign(ping), 'x-signature-timestamp': '1' }, Buffer.from(ping))).status, 401);

  const sent = [];
  const base = async (url, init) => (sent.push(url), { status: 200, ok: true });
  const makeRequest = hi.intercept(base);
  hi.client = {
    isReady: () => true,
    actions: {
      InteractionCreate: {
        handle: (d) =>
          setTimeout(async () => {
            // Так discord.js отвечает на нажатие: callback, затем follow-up.
            await makeRequest(`https://discord.com/api/v10/interactions/${d.id}/tok/callback?with_response=false`, { body: JSON.stringify({ type: 4, data: { content: 'ok' } }) });
            await makeRequest(`https://discord.com/api/v10/webhooks/app/tok`, { body: '{}' });
          }, 10),
      },
    },
  };
  const cmd = JSON.stringify({ id: '123', type: 2, data: { name: 'status' } });
  const r = await hi.handle(sign(cmd), Buffer.from(cmd));
  assert.deepEqual(r, { status: 200, body: { type: 4, data: { content: 'ok' } } });
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(sent, ['https://discord.com/api/v10/webhooks/app/tok']);
});

test('обновления модов: устаревшие по дате Workshop, ручной ID, в мод-лог один раз', async () => {
  const { checkModUpdates, findOutdated } = await import('../bot/src/modules/modupdates.js');
  const H = 3_600_000;
  const mods = [
    { folder: '@CF', enabled: true, publishedId: '1559212036', name: 'CF', filesUpdatedAt: 10 * H },
    { folder: '@Blackout RP', enabled: true, publishedId: '3799885501', name: 'Blackout RP', filesUpdatedAt: 10 * H },
    { folder: '@Blacout RP Weapons', enabled: true, publishedId: '0', name: 'W', filesUpdatedAt: 10 * H },
    { folder: '@Servermod', enabled: true, filesUpdatedAt: 1 },
    { folder: '@Old', enabled: false, publishedId: '5', filesUpdatedAt: 1 },
  ];
  const details = { 1559212036: { title: 'CF', updatedAt: 9 * H }, 3799885501: { title: 'Blackout RP', updatedAt: 12 * H }, 3812171981: { title: 'Weapons', updatedAt: 11 * H } };
  const rows = findOutdated(mods, details, { '@Blacout RP Weapons': '3812171981' });
  assert.deepEqual(rows.filter((r) => r.outdated).map((r) => r.folder), ['@Blackout RP', '@Blacout RP Weapons']);
  assert.equal(rows.find((r) => r.folder === '@Servermod').id, null);
  assert.ok(!rows.some((r) => r.folder === '@Old'));

  const db = openDb(':memory:');
  const posts = [];
  const ctx = { db, cfg: { modUpdates: { ids: { '@Blacout RP Weapons': '3812171981' } } }, agent: { online: true, call: async () => mods }, post: async (ch, p) => posts.push([ch, p]) };
  let asked = '';
  const fakeFetch = async (url) => {
    asked = url;
    return { ok: true, json: async () => ({ response: { publishedfiledetails: Object.entries(details).map(([id, d]) => ({ publishedfileid: id, result: 1, title: d.title, time_updated: d.updatedAt / 1000 })) } }) };
  };
  const prev = process.env.STEAM_API_KEY;
  process.env.STEAM_API_KEY = 'k';
  try {
    const r = await checkModUpdates(ctx, fakeFetch);
    assert.equal(r.mods.filter((m) => m.outdated).length, 2);
    assert.match(decodeURIComponent(asked), /publishedfileids\[2\]=3812171981/);
    assert.equal(posts.length, 1);
    assert.equal(posts[0][0], 'modLog');
    await checkModUpdates(ctx, fakeFetch);
    assert.equal(posts.length, 1, 'то же обновление второй раз не объявляется');
    assert.equal(db.kv.get('mods.updates').mods.length, 4);
  } finally {
    if (prev === undefined) delete process.env.STEAM_API_KEY;
    else process.env.STEAM_API_KEY = prev;
  }
});

test('тикеты группировок: пересылка, имя канала, допуск серверов, миграция БД', async () => {
  const { relayText, slug, isFaction, FACTION_COMMANDS } = await import('../bot/src/modules/tickets.js');
  assert.equal(relayText({ name: 'Игрок', content: 'привет' }, false), '**Игрок**: привет');
  assert.equal(relayText({ name: 'Адм', content: 'ок', attachments: ['https://x/a.png'] }, true), '**Адм** · Администрация Blackout: ок\n📎 https://x/a.png');
  assert.equal(relayText({ name: 'Игрок', content: '  ' }, false), null);
  assert.ok(relayText({ name: 'Игрок', content: 'я'.repeat(3000) }, false).length <= 2000);
  assert.equal(slug('Долг | Duty Clan!'), 'долг-duty-clan');
  assert.equal(slug('!!!'), 'group');
  const cfg = { guildId: '1', tickets: { factionGuilds: ['2'] } };
  assert.ok(isFaction(cfg, '2'));
  assert.ok(!isFaction(cfg, '3'));
  assert.ok(!isFaction(cfg, '1'));
  for (const c of FACTION_COMMANDS) c.toJSON();

  const db = openDb(':memory:');
  db.prepare("INSERT INTO tickets (discord_id, type, guild_id, mirror_id, created_at) VALUES ('u', 'help', '2', 'm', 0)").run();
  assert.equal(db.prepare("SELECT * FROM tickets WHERE mirror_id = 'm'").get().guild_id, '2');
});

test('команды на сервере группировки: только /ticket-panel и только на подключённых серверах', async () => {
  const { createRouter } = await import('../bot/src/core.js');
  const calls = [];
  const mod = { name: 'tickets', factionCommands: [{ name: 'ticket-panel' }], onCommand: async (i) => calls.push(i.guildId) };
  const replies = [];
  const ctx = { cfg: { guildId: '1', tickets: { factionGuilds: ['2'] } }, client: { ws: { ping: 0 } }, log: { warn() {}, error() {} } };
  const route = createRouter([mod], ctx);
  const make = (guildId, commandName) => ({
    guildId,
    commandName,
    createdTimestamp: Date.now(),
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isContextMenuCommand: () => false,
    isMessageComponent: () => false,
    isModalSubmit: () => false,
    reply: async (p) => replies.push(p),
    deferReply: async () => {},
  });
  await route(make('2', 'ticket-panel'));
  await route(make('3', 'ticket-panel'));
  await route(make('2', 'ban'));
  assert.deepEqual(calls, ['2']);
  assert.equal(replies.length, 1); // посторонний сервер получил отказ
});
