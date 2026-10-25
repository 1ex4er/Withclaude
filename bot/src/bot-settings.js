// Полная настройка бота с сайта (админка → «Бот»): описание всех настроек, проверка и сохранение.
// Значения ложатся в БД поверх config.json, как и выбор в /setup (settings.js).
// Поле restart: true — значение читается при запуске модуля, применится после перезапуска бота.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType } from 'discord.js';
import { listBackups } from './backup.js';
import { registerFactionCommands } from './modules/tickets.js';
import { getPath, resetSetting, saveSetting, savedSettings } from './settings.js';

const ID_RE = /^\d{17,20}$/;

// Типы: role, roles, channel, category, guilds, number, bool, text, select, lines, ids, patterns, map, list.
// assign: роли, которые бот выдаёт сам, — должны быть ниже роли бота.
export const SECTIONS = [
  {
    id: 'access',
    title: 'Доступ персонала',
    hint: 'Кто может пользоваться командами бота. Админы — всё, модераторы — наказания и анкеты, поддержка — тикеты.',
    fields: [
      { path: 'roles.admin', label: 'Админы', type: 'roles' },
      { path: 'roles.moderator', label: 'Модераторы', type: 'roles' },
      { path: 'roles.support', label: 'Поддержка', type: 'roles' },
      { path: 'commands.hideFromPlayers', label: 'Скрывать команды персонала от игроков', type: 'bool', restart: true, hint: 'Выкл — команды видны всем, доступ решают роли выше (нужно, если у персонала нет права «Администратор» в Discord)' },
    ],
  },
  {
    id: 'verify',
    title: 'Верификация и Steam',
    hint: 'Кнопка «Я прочитал правила» → капча → ввод SteamID.',
    fields: [
      { path: 'roles.unverified', label: 'Роль новичка до верификации', type: 'role', assign: true, hint: 'Можно оставить пустой' },
      { path: 'roles.verified', label: 'Роль после верификации', type: 'role', assign: true },
      { path: 'roles.steamLinked', label: 'Роль после привязки Steam', type: 'role', assign: true },
      { path: 'roles.whitelisted', label: 'Роль вайтлиста', type: 'role', assign: true },
      { path: 'verify.askSteam', label: 'Спрашивать SteamID при верификации', type: 'bool' },
      { path: 'verify.manualApproval', label: 'Ручное одобрение верификации', type: 'bool', hint: 'Заявка уходит модераторам с кнопками' },
      { path: 'channels.verifyReview', label: 'Канал заявок на верификацию', type: 'channel', hint: 'Пусто — в лог модерации' },
      { path: 'verify.minAccountAgeDays', label: 'Минимальный возраст аккаунта Discord, дней', type: 'number', min: 0, max: 365 },
      { path: 'banCheck.alertOnLink', label: 'Проверять баны Steam при привязке', type: 'bool' },
    ],
  },
  {
    id: 'applications',
    title: 'Анкеты RP-персонажа',
    fields: [
      { path: 'channels.applications', label: 'Канал анкет на проверку', type: 'channel' },
      { path: 'applications.acceptRoles', label: 'Выдавать при принятии', type: 'roles', assign: true },
      { path: 'applications.removeRoles', label: 'Снимать при принятии', type: 'roles', assign: true },
      { path: 'applications.addToWhitelist', label: 'Вносить в вайтлист при принятии', type: 'bool' },
      { path: 'applications.requireSteam', label: 'Анкета только с привязанным Steam', type: 'bool' },
      { path: 'applications.cooldownHours', label: 'Повторная анкета через, часов', type: 'number', min: 0, max: 720 },
    ],
  },
  {
    id: 'tickets',
    title: 'Тикеты',
    fields: [
      { path: 'tickets.categoryId', label: 'Категория для тикетов', type: 'category' },
      { path: 'channels.ticketLog', label: 'Архив тикетов', type: 'channel' },
      { path: 'tickets.maxOpenPerUser', label: 'Открытых тикетов на игрока', type: 'number', min: 1, max: 10 },
      {
        path: 'tickets.types',
        label: 'Темы тикетов',
        type: 'list',
        max: 25,
        hint: 'Код — латиница, не меняйте у тем с открытыми тикетами. Новые темы появятся в панели после /panel',
        item: [
          { key: 'id', label: 'Код', type: 'text', max: 20, pattern: '^[a-z0-9_-]+$' },
          { key: 'label', label: 'Название', type: 'text', max: 80 },
          { key: 'emoji', label: 'Эмодзи', type: 'text', max: 8, optional: true },
        ],
      },
      { path: 'tickets.factionGuilds', label: 'Серверы группировок', type: 'guilds', hint: 'Тикеты с них приходят сюда. На каждом выполните /ticket-panel' },
    ],
  },
  {
    id: 'channels',
    title: 'Служебные каналы',
    fields: [
      { path: 'channels.status', label: 'Статус сервера', type: 'channel' },
      { path: 'channels.alerts', label: 'Тревоги для админов', type: 'channel' },
      { path: 'channels.modLog', label: 'Лог модерации', type: 'channel' },
      { path: 'channels.adminLog', label: 'Действия с игровым сервером', type: 'channel' },
      { path: 'channels.joinLeave', label: 'Входы и выходы игроков (игровой сервер)', type: 'channel' },
      { path: 'channels.memberLog', label: 'Входы и выходы участников Discord', type: 'channel', hint: 'Кто зашёл (возраст аккаунта, приглашение) и кто вышел (сам, кик или бан)' },
      { path: 'channels.killFeed', label: 'Килфид', type: 'channel' },
      { path: 'channels.gameChat', label: 'Игровой чат', type: 'channel' },
    ],
  },
  {
    id: 'status',
    title: 'Статус и логи сервера',
    fields: [
      { path: 'status.connect', label: 'Адрес для подключения', type: 'text', max: 100 },
      { path: 'status.maxPlayers', label: 'Слотов, если агент не прочитал serverDZ.cfg', type: 'number', min: 1, max: 500 },
      { path: 'status.intervalSec', label: 'Обновлять статус раз в, секунд', type: 'number', min: 15, max: 3600, restart: true },
      { path: 'logs.admFollow', label: 'Читать ADM-лог (входы, килфид, чат)', type: 'bool', restart: true },
      { path: 'modUpdates.intervalMinutes', label: 'Проверять обновления модов раз в, минут', type: 'number', min: 5, max: 1440, restart: true },
      { path: 'modUpdates.ids', label: 'Workshop ID модов без meta.cpp', type: 'map', hint: 'Строка: @Папка=WorkshopID', valuePattern: '^\\d{5,12}$' },
    ],
  },
  {
    id: 'punish',
    title: 'Наказания и варны',
    fields: [
      { path: 'punishments.roles.nlr', label: 'Роль NLR', type: 'role', assign: true },
      { path: 'punishments.roles.nonrp', label: 'Роль NonRP', type: 'role', assign: true },
      { path: 'punishments.roles.pg', label: 'Роль PG', type: 'role', assign: true },
      { path: 'punishments.roles.rdm', label: 'Роль RDM', type: 'role', assign: true },
      { path: 'punishments.roles.meta', label: 'Роль Meta', type: 'role', assign: true },
      { path: 'punishments.roles.ban', label: 'Роль Бан', type: 'role', assign: true },
      { path: 'warns.muteAt', label: 'Мут при варнах', type: 'number', min: 0, max: 50, hint: '0 — без авто-мута' },
      { path: 'warns.muteMinutes', label: 'Длительность мута, минут', type: 'number', min: 1, max: 40320 },
      { path: 'warns.banAt', label: 'Бан при варнах', type: 'number', min: 0, max: 50, hint: '0 — без авто-бана' },
    ],
  },
  {
    id: 'selfroles',
    title: 'Панель ролей',
    hint: 'Роли, которые игроки берут сами кнопками. После изменения обновите панель командой /panel.',
    fields: [
      {
        path: 'selfRoles',
        label: 'Роли панели',
        type: 'list',
        max: 25,
        item: [
          { key: 'id', label: 'Роль', type: 'role', assign: true },
          { key: 'label', label: 'Надпись', type: 'text', max: 80 },
          { key: 'emoji', label: 'Эмодзи', type: 'text', max: 8, optional: true },
        ],
      },
    ],
  },
  {
    id: 'automod',
    title: 'Автомодерация',
    hint: 'Персонал не проверяется.',
    fields: [
      { path: 'automod.blockScamLinks', label: 'Удалять скам-ссылки', type: 'bool' },
      { path: 'automod.blockInvites', label: 'Удалять инвайты на чужие серверы', type: 'bool' },
      { path: 'automod.maxMentions', label: 'Упоминаний в сообщении — уже спам', type: 'number', min: 2, max: 50 },
      { path: 'automod.spam.messages', label: 'Флуд: сообщений', type: 'number', min: 2, max: 50, restart: true },
      { path: 'automod.spam.seconds', label: 'Флуд: за секунд', type: 'number', min: 1, max: 120, restart: true },
      { path: 'automod.duplicates', label: 'Одинаковых сообщений подряд', type: 'number', min: 2, max: 20, restart: true },
      { path: 'automod.timeoutMinutes', label: 'Мут за нарушение, минут', type: 'number', min: 1, max: 10080 },
      { path: 'automod.exemptRoles', label: 'Не проверять роли', type: 'roles' },
      { path: 'automod.extraBlockedPatterns', label: 'Свои запрещённые слова и ссылки', type: 'patterns', max: 100, hint: 'По одному на строку, регулярные выражения без учёта регистра' },
    ],
  },
  {
    id: 'antiraid',
    title: 'Антирейд и антинюк',
    fields: [
      { path: 'antiraid.joins', label: 'Рейд: входов', type: 'number', min: 2, max: 200, restart: true },
      { path: 'antiraid.seconds', label: 'Рейд: за секунд', type: 'number', min: 5, max: 600, restart: true },
      { path: 'antiraid.lockMinutes', label: 'Режим рейда длится, минут', type: 'number', min: 1, max: 1440 },
      { path: 'antiraid.action', label: 'Новых участников в режиме рейда', type: 'select', options: [{ value: 'kick', label: 'Кикать' }, { value: 'ban', label: 'Банить' }] },
      { path: 'antiraid.minAccountAgeDays', label: 'Предупреждать о аккаунтах младше, дней', type: 'number', min: 0, max: 365 },
      { path: 'antinuke.actions', label: 'Антинюк: разрушительных действий', type: 'number', min: 2, max: 50, restart: true },
      { path: 'antinuke.seconds', label: 'Антинюк: за секунд', type: 'number', min: 5, max: 600, restart: true },
      { path: 'antinuke.trusted', label: 'Доверенные (Discord ID)', type: 'ids', max: 50, hint: 'По одному на строку. Владелец сервера доверен всегда' },
    ],
  },
  {
    id: 'backup',
    title: 'Бэкапы базы бота',
    fields: [
      { path: 'backup.keep', label: 'Хранить бэкапов', type: 'number', min: 1, max: 100 },
      { path: 'backup.intervalHours', label: 'Бэкап раз в, часов', type: 'number', min: 1, max: 168, restart: true },
    ],
  },
];

// Вкладка каждого сервера группировки: пути вида guilds.<id>.<путь ниже>, роли и каналы — того сервера.
export const FACTION_FIELDS = [
  { path: 'channels.status', label: 'Онлайн сервера (живое сообщение)', type: 'channel', hint: 'Бот держит в канале одно сообщение со статусом и обновляет его' },
  { path: 'channels.joinLeave', label: 'Входы и выходы на игровом сервере', type: 'channel' },
  { path: 'channels.killFeed', label: 'Килфид', type: 'channel', hint: 'Осторожно: видно, кто кого убил — может давать метагейм' },
  { path: 'channels.gameChat', label: 'Игровой чат', type: 'channel' },
  { path: 'channels.memberLog', label: 'Входы и выходы участников этого Discord', type: 'channel' },
  { path: 'joinRole', label: 'Роль при входе на этот Discord', type: 'role', assign: true },
  { path: 'automod', label: 'Автомодерация на этом сервере', type: 'bool', hint: 'Правила — как на основном (вкладка «Автомодерация»). Администраторы сервера не проверяются' },
  { path: 'channels.modLog', label: 'Лог автомодерации', type: 'channel', hint: 'Пусто — в лог модерации основного сервера' },
];

const FIELDS = new Map(SECTIONS.flatMap((s) => s.fields.map((f) => [f.path, f])));
const FACTION_BY_PATH = new Map(FACTION_FIELDS.map((f) => [f.path, f]));
const FACTION_RE = /^guilds\.(\d{17,20})\.(.+)$/;

// Поле по пути: обычное или поле сервера группировки (только для подключённых в tickets.factionGuilds).
function fieldFor(ctx, p) {
  if (FIELDS.has(p)) return FIELDS.get(p);
  const m = FACTION_RE.exec(p);
  const tpl = m && FACTION_BY_PATH.get(m[2]);
  if (!tpl || !ctx.faction(m[1])) return null;
  return { ...tpl, path: p, guildId: m[1] };
}

// Хуки после сохранения: то, что нужно применить в Discord сразу.
const AFTER = {
  'tickets.factionGuilds': (ctx) => registerFactionCommands(ctx),
};

const fail = (message) => Object.assign(new Error(message), { status: 400 });

// Высшая роль бота. Сразу после перезапуска members.me бывает без ролей — тогда спрашиваем Discord.
async function botRole(guild) {
  let me = guild.members.me;
  if (!me?.roles?.highest) me = await guild.members.fetchMe({ force: true }).catch(() => null);
  return me?.roles?.highest ?? null;
}

async function guildInfo(guild) {
  const highest = await botRole(guild);
  const top = highest?.position ?? 0;
  const roles = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor, managed: r.managed, assignable: !r.managed && r.position < top }));
  const KIND = { [ChannelType.GuildText]: 'text', [ChannelType.GuildAnnouncement]: 'announcement', [ChannelType.GuildCategory]: 'category' };
  const channels = [...guild.channels.cache.values()]
    .filter((c) => KIND[c.type])
    .sort((a, b) => (a.parent?.rawPosition ?? a.rawPosition) - (b.parent?.rawPosition ?? b.rawPosition) || a.rawPosition - b.rawPosition)
    .map((c) => ({ id: c.id, name: c.name, kind: KIND[c.type], category: c.parent?.name ?? '' }));
  return { id: guild.id, name: guild.name, botRole: highest ? { name: highest.name, position: highest.position } : null, roles, channels };
}

// Короткий коммит из .git без запуска git — чтобы видеть, какая версия бота работает.
function version() {
  try {
    const git = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.git');
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    if (!ref) return head.slice(0, 7);
    const file = path.join(git, ref);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim().slice(0, 7);
    const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8');
    return packed.split('\n').find((l) => l.endsWith(` ${ref}`))?.slice(0, 7) ?? null;
  } catch {
    return null;
  }
}

const startedAt = Date.now();
const VERSION = version();

const factionGuilds = (ctx) =>
  (ctx.cfg.tickets.factionGuilds ?? []).map((id) => ctx.client.guilds.cache.get(id)).filter((g) => g && g.id !== ctx.cfg.guildId);

export async function describeSettings(ctx) {
  const saved = savedSettings(ctx.db);
  const value = (f) => ({ ...f, value: getPath(ctx.cfg, f.path) ?? null, saved: f.path in saved });
  const main = ctx.guild();
  const guild = main ? await guildInfo(main) : null;
  if (guild) guild.guilds = [...ctx.client.guilds.cache.values()].filter((g) => g.id !== main.id).map((g) => ({ id: g.id, name: g.name }));
  const factions = await Promise.all(factionGuilds(ctx).map(guildInfo));
  return {
    bot: {
      online: ctx.client?.isReady?.() ?? false,
      tag: ctx.client?.user?.tag ?? null,
      ping: ctx.client?.ws?.ping ?? null,
      startedAt,
      version: VERSION,
      agent: ctx.agent.online,
      restartPending: ctx.db.kv.get('settings.restartAfter', 0) > startedAt,
    },
    guild,
    factions,
    backups: listBackups(ctx.cfg.backup.dir).slice(-5).reverse(),
    sections: [
      ...SECTIONS.map((s) => ({ ...s, fields: s.fields.map(value) })),
      ...factions.map((g) => ({
        id: `guild-${g.id}`,
        title: g.name,
        guildId: g.id,
        hint: 'Сервер группировки: тикеты отсюда приходят на основной сервер, а сюда бот пишет выбранное ниже. Пустой канал — выключено.',
        fields: FACTION_FIELDS.map((f) => value({ ...f, path: `guilds.${g.id}.${f.path}`, guildId: g.id })),
      })),
    ],
  };
}

// ------------------------------------------------------------- проверка значений
// env: { ctx, guild — сервер, чьи роли и каналы выбираются, top — позиция роли бота на нём }.

function checkId(value, label) {
  if (typeof value !== 'string' || (value !== '' && !ID_RE.test(value))) throw fail(`${label}: неверный ID`);
  return value;
}

function checkRole(env, id, field, label) {
  if (!id) return id;
  const role = env.guild?.roles.cache.get(id);
  if (!role) throw fail(`${label}: роли нет на сервере`);
  if (field.assign) {
    if (role.managed || role.position >= env.top) throw fail(`${label}: бот не может выдавать «${role.name}» — поднимите роль бота выше`);
  }
  return id;
}

function checkChannel(env, id, label, kinds) {
  if (!id) return id;
  const ch = env.guild?.channels.cache.get(id);
  if (!ch || !kinds.includes(ch.type)) throw fail(`${label}: канал не найден`);
  return id;
}

function lines(value, max, label) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw fail(`${label}: ожидается список строк`);
  const out = value.map((v) => v.trim()).filter(Boolean);
  if (out.length > max) throw fail(`${label}: не больше ${max} строк`);
  return out;
}

function checkScalar(env, field, value, label) {
  switch (field.type) {
    case 'bool':
      if (typeof value !== 'boolean') throw fail(`${label}: да/нет`);
      return value;
    case 'number': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < field.min || n > field.max) throw fail(`${label}: целое от ${field.min} до ${field.max}`);
      return n;
    }
    case 'text': {
      if (typeof value !== 'string') throw fail(`${label}: текст`);
      const v = value.trim();
      if (!v && !field.optional) throw fail(`${label}: пусто`);
      if (v.length > field.max) throw fail(`${label}: не длиннее ${field.max}`);
      if (v && field.pattern && !new RegExp(field.pattern).test(v)) throw fail(`${label}: недопустимые символы`);
      return v;
    }
    case 'select':
      if (!field.options.some((o) => o.value === value)) throw fail(`${label}: неверный вариант`);
      return value;
    case 'role':
      return checkRole(env, checkId(value, label), field, label);
    default:
      throw fail(`${label}: неизвестный тип`);
  }
}

function checkValue(env, field, value) {
  const label = field.label;
  switch (field.type) {
    case 'roles': {
      const ids = lines(value, 25, label);
      return [...new Set(ids)].map((id) => checkRole(env, checkId(id, label), field, label));
    }
    case 'channel':
      return checkChannel(env, checkId(value, label), label, [ChannelType.GuildText, ChannelType.GuildAnnouncement]);
    case 'category':
      return checkChannel(env, checkId(value, label), label, [ChannelType.GuildCategory]);
    case 'guilds': {
      const ids = [...new Set(lines(value, 25, label))];
      for (const id of ids) if (!env.ctx.client.guilds.cache.has(checkId(id, label))) throw fail(`${label}: бота нет на сервере ${id}`);
      return ids;
    }
    case 'ids':
      return [...new Set(lines(value, field.max, label))].map((id) => checkId(id, label));
    case 'patterns':
      return lines(value, field.max, label).map((p) => {
        try {
          new RegExp(p, 'i');
        } catch {
          throw fail(`${label}: ошибка в выражении «${p}»`);
        }
        return p;
      });
    case 'map': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label}: ожидается словарь`);
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const key = k.trim();
        const val = String(v).trim();
        if (!key || key.length > 100) throw fail(`${label}: пустое или длинное имя`);
        if (!new RegExp(field.valuePattern).test(val)) throw fail(`${label}: неверное значение у «${key}»`);
        out[key] = val;
      }
      return out;
    }
    case 'list': {
      if (!Array.isArray(value) || value.length > field.max) throw fail(`${label}: не больше ${field.max} строк`);
      const out = value.map((row, n) => {
        if (!row || typeof row !== 'object') throw fail(`${label}: строка ${n + 1}`);
        return Object.fromEntries(field.item.map((f) => [f.key, checkScalar(env, f, row[f.key] ?? '', `${label}, строка ${n + 1}: ${f.label}`)]));
      });
      const key = field.item[0].key;
      const keys = out.map((r) => r[key]);
      if (new Set(keys).size !== keys.length) throw fail(`${label}: повторяется «${field.item[0].label}»`);
      if (field.item[0].type === 'role' && keys.some((k) => !k)) throw fail(`${label}: не выбрана роль`);
      // Пустой эмодзи не передаём в Discord.
      return out.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== '')));
    }
    default:
      return checkScalar(env, field, value, label);
  }
}

// body: { values: { path: value }, reset: [path] }. Сначала проверяется всё, потом сохраняется.
export async function updateSettings(ctx, body) {
  const values = body?.values && typeof body.values === 'object' ? body.values : {};
  const reset = Array.isArray(body?.reset) ? body.reset : [];
  // Роль бота запрашивается один раз на сервер.
  const envs = new Map();
  const envFor = async (guildId) => {
    if (!envs.has(guildId)) {
      const guild = (guildId ? ctx.client.guilds.cache.get(guildId) : ctx.guild()) ?? null;
      envs.set(guildId, { ctx, guild, top: guild ? ((await botRole(guild))?.position ?? 0) : 0 });
    }
    return envs.get(guildId);
  };
  const changes = [];
  for (const [p, v] of Object.entries(values)) {
    const field = fieldFor(ctx, p);
    if (!field) throw fail(`Неизвестная настройка ${p}`);
    changes.push([field, checkValue(await envFor(field.guildId ?? null), field, v)]);
  }
  const resets = [];
  for (const p of reset) {
    const field = fieldFor(ctx, p);
    if (!field) throw fail(`Неизвестная настройка ${p}`);
    resets.push(field);
  }

  const changed = [];
  for (const [field, value] of changes) {
    if (JSON.stringify(getPath(ctx.cfg, field.path)) === JSON.stringify(value)) continue;
    saveSetting(ctx.cfg, ctx.db, field.path, value);
    changed.push(field);
  }
  for (const f of resets) if (resetSetting(ctx.cfg, ctx.db, f.path)) changed.push(f);

  const restart = changed.some((f) => f.restart);
  if (restart) ctx.db.kv.set('settings.restartAfter', Date.now());
  for (const f of changed) {
    await AFTER[f.path]?.(ctx).catch((e) => ctx.log.warn(`после настройки ${f.path}: ${e.message}`));
  }
  const who = typeof body?.actor?.name === 'string' ? body.actor.name : 'сайт';
  if (changed.length) ctx.log.info(`настройки с сайта (${who}): ${changed.map((f) => f.path).join(', ')}`);
  return { changed: changed.map((f) => f.label), restart };
}
