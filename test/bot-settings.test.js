import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType } from 'discord.js';
import { SECTIONS, describeSettings, updateSettings } from '../bot/src/bot-settings.js';
import { DEFAULTS } from '../bot/src/config.js';
import { openDb } from '../bot/src/db.js';
import { getPath } from '../bot/src/settings.js';

const GUILD = '100000000000000001';
const LOW = '200000000000000001';
const HIGH = '200000000000000002';
const TEXT = '300000000000000001';
const CAT = '300000000000000002';

function fakeCtx() {
  const map = (items) => new Map(items.map((x) => [x.id, x]));
  const roles = map([
    { id: GUILD, name: '@everyone', position: 0, managed: false, hexColor: '#000000' },
    { id: LOW, name: 'Сталкер', position: 1, managed: false, hexColor: '#00ff00' },
    { id: HIGH, name: 'Гл. Админ', position: 9, managed: false, hexColor: '#ff0000' },
  ]);
  const guild = {
    id: GUILD,
    name: 'Blackout',
    roles: { cache: roles },
    channels: { cache: map([{ id: TEXT, name: 'общий', type: ChannelType.GuildText, rawPosition: 1 }, { id: CAT, name: 'Тикеты', type: ChannelType.GuildCategory, rawPosition: 0 }]) },
    members: { me: { roles: { highest: { name: 'Бот', position: 5 } } } },
  };
  return {
    cfg: structuredClone({ ...DEFAULTS, guildId: GUILD, backup: { ...DEFAULTS.backup, dir: 'nonexistent-backups' } }),
    db: openDb(':memory:'),
    client: { guilds: { cache: new Map([[GUILD, guild]]) }, isReady: () => true },
    agent: { online: false },
    log: { info() {}, warn() {} },
    guild: () => guild,
  };
}

test('настройки бота: у каждого поля есть путь в конфиге по умолчанию и тип', () => {
  const paths = SECTIONS.flatMap((s) => s.fields.map((f) => f.path));
  assert.equal(new Set(paths).size, paths.length);
  for (const p of paths) assert.notEqual(getPath(DEFAULTS, p), undefined, p);
});

test('настройки бота: сохранение, проверка ролей и каналов, сброс', async () => {
  const ctx = fakeCtx();
  const r = await updateSettings(ctx, { values: { 'roles.verified': LOW, 'channels.modLog': TEXT, 'tickets.categoryId': CAT, 'warns.muteAt': '4' } });
  assert.equal(r.changed.length, 4);
  assert.equal(ctx.cfg.roles.verified, LOW);
  assert.equal(ctx.cfg.warns.muteAt, 4);
  assert.equal(ctx.db.kv.get('settings', {})['channels.modLog'], TEXT);

  // Роль выше бота выдавать нельзя, а в админы — можно.
  await assert.rejects(updateSettings(ctx, { values: { 'roles.verified': HIGH } }), /поднимите роль бота/);
  await updateSettings(ctx, { values: { 'roles.admin': [HIGH] } });
  assert.deepEqual(ctx.cfg.roles.admin, [HIGH]);

  await assert.rejects(updateSettings(ctx, { values: { 'channels.modLog': CAT } }), /канал не найден/);
  await assert.rejects(updateSettings(ctx, { values: { 'warns.muteAt': 999 } }), /целое от 0 до 50/);
  await assert.rejects(updateSettings(ctx, { values: { 'automod.extraBlockedPatterns': ['('] } }), /ошибка в выражении/);
  await assert.rejects(updateSettings(ctx, { values: { 'nope.path': 1 } }), /Неизвестная настройка/);
  // Ошибка в одном поле — не сохраняется ничего.
  await assert.rejects(updateSettings(ctx, { values: { 'warns.banAt': 7, 'warns.muteAt': -1 } }));
  assert.equal(ctx.cfg.warns.banAt, DEFAULTS.warns.banAt);

  const restart = await updateSettings(ctx, { values: { 'status.intervalSec': 120 } });
  assert.equal(restart.restart, true);

  await updateSettings(ctx, { reset: ['warns.muteAt'] });
  assert.equal(ctx.cfg.warns.muteAt, DEFAULTS.warns.muteAt);
  assert.ok(!('warns.muteAt' in ctx.db.kv.get('settings', {})));
});

test('настройки бота: списки тем тикетов и панели ролей', async () => {
  const ctx = fakeCtx();
  await updateSettings(ctx, { values: { 'tickets.types': [{ id: 'help', label: 'Вопрос', emoji: '' }, { id: 'bug', label: 'Баг', emoji: '🐞' }] } });
  assert.deepEqual(ctx.cfg.tickets.types, [{ id: 'help', label: 'Вопрос' }, { id: 'bug', label: 'Баг', emoji: '🐞' }]);
  await assert.rejects(updateSettings(ctx, { values: { 'tickets.types': [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] } }), /повторяется/);
  await assert.rejects(updateSettings(ctx, { values: { 'tickets.types': [{ id: 'Плохо', label: 'x' }] } }), /недопустимые/);
  await assert.rejects(updateSettings(ctx, { values: { selfRoles: [{ id: HIGH, label: 'x' }] } }), /поднимите/);
  await updateSettings(ctx, { values: { selfRoles: [{ id: LOW, label: 'Новости', emoji: '📰' }], 'modUpdates.ids': { '@Mod': '3812171981' } } });
  assert.equal(ctx.cfg.selfRoles[0].id, LOW);

  const d = await describeSettings(ctx);
  assert.equal(d.guild.roles.find((x) => x.id === HIGH).assignable, false);
  assert.equal(d.sections.flatMap((s) => s.fields).find((f) => f.path === 'selfRoles').saved, true);
});

test('лог входов: какое приглашение использовано', async () => {
  const { usedInvite } = await import('../bot/src/modules/memberlog.js');
  const before = new Map([['aaa', { uses: 3, inviterId: '1' }], ['bbb', { uses: 0, inviterId: '2' }]]);
  assert.deepEqual(usedInvite(before, new Map([['aaa', { uses: 3, inviterId: '1' }], ['bbb', { uses: 1, inviterId: '2' }]])), { code: 'bbb', inviterId: '2' });
  // Новое приглашение, которого не было в кэше.
  assert.equal(usedInvite(before, new Map([...before, ['ccc', { uses: 1, inviterId: '3' }]])).code, 'ccc');
  // Одноразовое исчезло после входа.
  assert.equal(usedInvite(before, new Map([['aaa', { uses: 3, inviterId: '1' }]])).code, 'bbb');
  assert.equal(usedInvite(before, before), null);
  assert.equal(usedInvite(null, before), null);
});

test('настройки бота: роль бота запрашивается заново, если после перезапуска её нет в кэше', async () => {
  const ctx = fakeCtx();
  const guild = ctx.guild();
  const real = guild.members.me;
  guild.members.me = { roles: {} };
  guild.members.fetchMe = async () => real;
  const d = await describeSettings(ctx);
  assert.equal(d.guild.botRole.position, 5);
  await updateSettings(ctx, { values: { 'roles.verified': LOW } });
  assert.equal(ctx.cfg.roles.verified, LOW);
});
