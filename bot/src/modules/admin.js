// Управление сервером из Discord через агента. Права: поддержка — смотреть, модератор — say/kick,
// администратор — старт/стоп/рестарт/баны. Опасные действия — только после кнопки подтверждения.

import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { steamToBeGuid } from '../battleye.js';
import { BotError } from '../core.js';
import { LEVEL, clip, embed, escapeMd, formatDuration, parseDuration, ts } from '../util.js';

const pending = new Map(); // token -> { userId, title, run, expires }
const CONFIRM_MS = 60_000;

let playersCache = { at: 0, list: [] };
async function players(ctx) {
  if (Date.now() - playersCache.at > 10_000) {
    playersCache = { at: Date.now(), list: await ctx.agent.call('rcon.players', {}, 'admin') };
  }
  return playersCache.list;
}

// Игрок выбирается из подсказки: значение "id|guid". Номер игрока меняется при перезаходе,
// поэтому ищем его заново по GUID.
async function resolvePlayer(ctx, value) {
  const [idStr, guid] = String(value).split('|');
  playersCache.at = 0;
  const list = await players(ctx);
  const p = (guid && list.find((x) => x.guid === guid)) || list.find((x) => String(x.id) === idStr);
  if (!p) throw new BotError('Игрок не найден на сервере (вышел?)');
  return p;
}

async function confirm(i, title, description, run) {
  const token = crypto.randomBytes(8).toString('hex');
  pending.set(token, { userId: i.user.id, title, run, expires: Date.now() + CONFIRM_MS });
  setTimeout(() => pending.delete(token), CONFIRM_MS).unref?.();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`admin:confirm:${token}`).setLabel('Подтвердить').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`admin:cancel:${token}`).setLabel('Отмена').setStyle(ButtonStyle.Secondary),
  );
  await i.reply({ embeds: [embed('warn', `⚠️ ${title}`, `${description}\n\nПодтверди в течение минуты.`)], components: [row], flags: MessageFlags.Ephemeral });
}

function log(ctx, i, action, details, color = 'info') {
  const e = embed(color, `🛠️ ${action}`).addFields({ name: 'Кто', value: `<@${i.user.id}>`, inline: true });
  for (const [k, v] of Object.entries(details ?? {})) if (v) e.addFields({ name: k, value: String(v).slice(0, 1024), inline: true });
  return ctx.post('adminLog', { embeds: [e] });
}

const done = (i, text, color = 'ok') => {
  const payload = { embeds: [embed(color, null, text)], components: [] };
  return i.deferred || i.replied ? i.editReply(payload) : i.reply({ ...payload, flags: MessageFlags.Ephemeral });
};

const server = new SlashCommandBuilder()
  .setName('server')
  .setDescription('Управление игровым сервером')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((s) => s.setName('status').setDescription('Подробный статус'))
  .addSubcommand((s) => s.setName('start').setDescription('Запустить сервер'))
  .addSubcommand((s) =>
    s.setName('stop').setDescription('Остановить сервер').addBooleanOption((o) => o.setName('force').setDescription('Без мягкой остановки')),
  )
  .addSubcommand((s) =>
    s
      .setName('restart')
      .setDescription('Рестарт (сразу или через N минут с предупреждениями)')
      .addIntegerOption((o) => o.setName('minutes').setDescription('Через сколько минут (0 — сейчас)').setMinValue(0).setMaxValue(180))
      .addBooleanOption((o) => o.setName('update_mods').setDescription('Обновить моды из Workshop (только рестарт сейчас)')),
  )
  .addSubcommand((s) => s.setName('cancel-restart').setDescription('Отменить запланированный рестарт'))
  .addSubcommand((s) =>
    s
      .setName('schedule')
      .setDescription('Расписание рестартов (без параметра — показать)')
      .addStringOption((o) => o.setName('times').setDescription('Например: 00:00 06:00 12:00 18:00')),
  );

const rcon = new SlashCommandBuilder()
  .setName('rcon')
  .setDescription('Игроки и наказания в игре')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((s) => s.setName('players').setDescription('Кто сейчас на сервере'))
  .addSubcommand((s) =>
    s
      .setName('say')
      .setDescription('Сообщение в игровой чат')
      .addStringOption((o) => o.setName('text').setDescription('Текст').setRequired(true).setMaxLength(200)),
  )
  .addSubcommand((s) =>
    s
      .setName('kick')
      .setDescription('Кикнуть игрока')
      .addStringOption((o) => o.setName('player').setDescription('Игрок').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('reason').setDescription('Причина').setMaxLength(100)),
  )
  .addSubcommand((s) =>
    s
      .setName('ban')
      .setDescription('Забанить игрока, который сейчас на сервере')
      .addStringOption((o) => o.setName('player').setDescription('Игрок').setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName('duration').setDescription('Срок: 30m, 12h, 7d (пусто — навсегда)'))
      .addStringOption((o) => o.setName('reason').setDescription('Причина').setMaxLength(100)),
  )
  .addSubcommand((s) =>
    s
      .setName('ban-steam')
      .setDescription('Забанить по SteamID64 (игрок может быть не в сети)')
      .addStringOption((o) => o.setName('steamid').setDescription('SteamID64').setRequired(true).setMinLength(17).setMaxLength(17))
      .addStringOption((o) => o.setName('duration').setDescription('Срок: 30m, 12h, 7d (пусто — навсегда)'))
      .addStringOption((o) => o.setName('reason').setDescription('Причина').setMaxLength(100)),
  )
  .addSubcommand((s) => s.setName('bans').setDescription('Список банов BattlEye'))
  .addSubcommand((s) =>
    s
      .setName('unban')
      .setDescription('Снять бан')
      .addIntegerOption((o) => o.setName('index').setDescription('Номер из /rcon bans').setRequired(true).setMinValue(0)),
  );

function durationMinutes(text) {
  const ms = parseDuration(text);
  if (ms === undefined) throw new BotError('Срок в формате 30m, 12h, 7d, 2w');
  return ms ? Math.max(1, Math.round(ms / 60_000)) : 0;
}

async function onServer(i, ctx) {
  const sub = i.options.getSubcommand();
  const call = (action, params, opts) => ctx.agent.call(action, params, i.member, opts);

  if (sub === 'status') {
    ctx.require(i, LEVEL.support);
    const s = await call('server.status');
    const e = embed(s.running ? 'ok' : 'bad', s.running ? '🟢 Работает' : '🔴 Выключен').addFields(
      { name: 'PID', value: String(s.pid ?? '—'), inline: true },
      { name: 'Аптайм', value: s.startedAt ? formatDuration(Date.now() - s.startedAt) : '—', inline: true },
      { name: 'RCon', value: s.rcon ? 'подключён' : 'нет', inline: true },
      { name: 'Следующий рестарт', value: s.nextRestart ? ts(s.nextRestart) : '—', inline: true },
      { name: 'Расписание', value: s.schedule?.length ? s.schedule.join(', ') : 'нет', inline: true },
      { name: 'Моды', value: clip([...s.mods, ...s.serverMods].join(', ') || '—', 1024) },
    );
    return i.reply({ embeds: [e], flags: MessageFlags.Ephemeral });
  }

  ctx.require(i, LEVEL.admin);

  if (sub === 'start') {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await call('server.start');
    log(ctx, i, 'Запуск сервера');
    return done(i, r.alreadyRunning ? 'Сервер уже работает' : `✅ Сервер запущен (pid ${r.pid})`);
  }
  if (sub === 'stop') {
    const force = i.options.getBoolean('force') ?? false;
    return confirm(i, 'Остановить сервер?', force ? 'Принудительно, без сохранения мира.' : 'Игроки будут отключены.', async (b) => {
      await b.update({ embeds: [embed('info', null, '⏳ Останавливаю…')], components: [] });
      await call('server.stop', { force });
      log(ctx, i, 'Остановка сервера', { Принудительно: force ? 'да' : null }, 'warn');
      return done(b, '⏹️ Сервер остановлен');
    });
  }
  if (sub === 'restart') {
    const minutes = i.options.getInteger('minutes') ?? 0;
    const updateMods = i.options.getBoolean('update_mods') ?? false;
    if (minutes > 0) {
      const r = await call('server.restartIn', { minutes });
      log(ctx, i, 'Запланирован рестарт', { Когда: ts(r.at) });
      return done(i, `🔁 Рестарт ${ts(r.at)}, игроки получат предупреждения`);
    }
    return confirm(i, 'Рестарт сервера сейчас?', updateMods ? 'С обновлением модов из Workshop.' : 'Игроки будут отключены без предупреждения.', async (b) => {
      await b.update({ embeds: [embed('info', null, '⏳ Рестарт…')], components: [] });
      const r = await call('server.restart', { updateMods }, { timeoutMs: 40 * 60_000 });
      log(ctx, i, 'Рестарт сервера', { 'Обновление модов': updateMods ? 'да' : null }, 'warn');
      return done(b, r.beforeStartError ? `⚠️ Сервер перезапущен, но обновление модов не удалось: ${r.beforeStartError}` : '🔁 Сервер перезапущен', r.beforeStartError ? 'warn' : 'ok');
    });
  }
  if (sub === 'cancel-restart') {
    await call('server.cancelRestart');
    log(ctx, i, 'Отмена рестарта');
    return done(i, 'Запланированный рестарт отменён');
  }
  if (sub === 'schedule') {
    const text = i.options.getString('times');
    if (!text) {
      const { restarts } = await call('server.getSchedule');
      return done(i, restarts.length ? `Рестарты: **${restarts.join(', ')}** (время сервера)` : 'Расписание пустое', 'info');
    }
    const times = text.split(/[\s,;]+/).filter(Boolean);
    const { restarts } = await call('server.setSchedule', { restarts: times });
    log(ctx, i, 'Новое расписание рестартов', { Время: restarts.join(', ') });
    return done(i, `Расписание: **${restarts.join(', ') || 'пусто'}**`);
  }
}

async function onRcon(i, ctx) {
  const sub = i.options.getSubcommand();
  const call = (action, params, opts) => ctx.agent.call(action, params, i.member, opts);

  if (sub === 'players') {
    ctx.require(i, LEVEL.support);
    playersCache.at = 0;
    const list = await players(ctx);
    const lines = list.map((p) => `\`#${p.id}\` ${escapeMd(p.name)} · ${p.ping} мс${p.lobby ? ' · в лобби' : ''}`);
    return i.reply({ embeds: [embed('info', `Игроки: ${list.length}`, clip(lines.join('\n') || 'Никого нет', 4000))], flags: MessageFlags.Ephemeral });
  }
  if (sub === 'say') {
    ctx.require(i, LEVEL.moderator);
    const text = i.options.getString('text');
    await call('rcon.say', { message: text });
    log(ctx, i, 'Сообщение в игру', { Текст: text });
    return done(i, '📢 Отправлено');
  }
  if (sub === 'kick') {
    ctx.require(i, LEVEL.moderator);
    const p = await resolvePlayer(ctx, i.options.getString('player'));
    const reason = i.options.getString('reason') ?? 'Kicked';
    await call('rcon.kick', { id: p.id, reason });
    log(ctx, i, 'Кик', { Игрок: escapeMd(p.name), Причина: reason }, 'warn');
    return done(i, `👢 ${escapeMd(p.name)} кикнут`);
  }
  if (sub === 'ban' || sub === 'ban-steam') {
    ctx.require(i, LEVEL.admin);
    const minutes = durationMinutes(i.options.getString('duration'));
    const reason = i.options.getString('reason') ?? 'Banned';
    const term = minutes ? formatDuration(minutes * 60_000) : 'навсегда';
    let target;
    let params;
    if (sub === 'ban') {
      const p = await resolvePlayer(ctx, i.options.getString('player'));
      target = escapeMd(p.name);
      params = p.guid ? { guid: p.guid, minutes, reason } : { id: p.id, minutes, reason };
      if (p.guid) await call('rcon.kick', { id: p.id, reason }).catch(() => {});
    } else {
      const steamId = i.options.getString('steamid');
      let guid;
      try {
        guid = steamToBeGuid(steamId);
      } catch (e) {
        throw new BotError(e.message);
      }
      const link = ctx.links.bySteam(steamId);
      target = `${steamId}${link ? ` (<@${link.discord_id}>)` : ''}`;
      params = { guid, minutes, reason };
    }
    return confirm(i, 'Забанить?', `**${target}** — ${term}\nПричина: ${reason}`, async (b) => {
      await call('rcon.ban', params);
      log(ctx, i, 'Бан в игре', { Игрок: target, Срок: term, Причина: reason }, 'bad');
      return b.update({ embeds: [embed('ok', null, `🔨 ${target} забанен (${term})`)], components: [] });
    });
  }
  if (sub === 'bans') {
    ctx.require(i, LEVEL.moderator);
    const bans = await call('rcon.bans');
    const lines = bans.map((b) => `\`${b.index}\` ${b.target.slice(0, 12)}… · ${b.minutesLeft} · ${escapeMd(b.reason || '—')}`);
    return i.reply({ embeds: [embed('info', `Баны: ${bans.length}`, clip(lines.join('\n') || 'Пусто', 4000))], flags: MessageFlags.Ephemeral });
  }
  if (sub === 'unban') {
    ctx.require(i, LEVEL.admin);
    const index = i.options.getInteger('index');
    await call('rcon.unban', { index });
    log(ctx, i, 'Снятие бана', { Номер: index });
    return done(i, `Бан #${index} снят`);
  }
}

export default {
  name: 'admin',
  commands: [server, rcon],

  async onCommand(i, ctx) {
    if (i.commandName === 'server') return onServer(i, ctx);
    if (i.commandName === 'rcon') return onRcon(i, ctx);
  },

  async onAutocomplete(i, ctx) {
    if (ctx.level(i.member) < LEVEL.moderator || !ctx.agent.online) return i.respond([]);
    const q = String(i.options.getFocused()).toLowerCase();
    const list = await players(ctx).catch(() => []);
    await i.respond(
      list
        .filter((p) => p.name.toLowerCase().includes(q) || String(p.id) === q)
        .slice(0, 25)
        .map((p) => ({ name: clip(`#${p.id} ${p.name}`, 100), value: `${p.id}|${p.guid ?? ''}` })),
    );
  },

  async onComponent(i, ctx, [action, token]) {
    const p = pending.get(token);
    if (!p || p.expires < Date.now()) return i.update({ embeds: [embed('neutral', null, 'Время подтверждения истекло')], components: [] });
    if (p.userId !== i.user.id) throw new BotError('Это подтверждение не для тебя');
    pending.delete(token);
    if (action === 'cancel') return i.update({ embeds: [embed('neutral', null, 'Отменено')], components: [] });
    return p.run(i);
  },
};
