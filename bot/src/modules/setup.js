// /setup — настройка ролей и каналов прямо в Discord, без копирования ID.
//   /setup roles      — выпадающие списки ролей сервера
//   /setup channels   — выпадающие списки каналов
//   /setup show       — что сейчас настроено
//   /setup roles-list — файл со всеми ролями сервера и их ID
//   /setup factions   — серверы группировок, откуда тикеты идут на основной сервер

import {
  ActionRowBuilder,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { listBackups, makeBackup } from '../backup.js';
import { BotError } from '../core.js';
import { getPath, saveSetting } from '../settings.js';
import { registerFactionCommands } from './tickets.js';
import { LEVEL, clip, embed } from '../util.js';

// path — куда в конфиге, multi — можно несколько.
const ROLE_SLOTS = [
  { path: 'roles.admin', label: 'Админы (полный доступ)', multi: true },
  { path: 'roles.moderator', label: 'Модераторы', multi: true },
  { path: 'roles.support', label: 'Поддержка (тикеты)', multi: true },
  { path: 'roles.verified', label: 'Выдаётся после верификации' },
  { path: 'roles.unverified', label: 'Выдаётся новичкам до верификации (можно пусто)' },
  { path: 'roles.steamLinked', label: 'Выдаётся после привязки Steam' },
  { path: 'roles.whitelisted', label: 'Вайтлист (доступ на сервер)' },
  { path: 'applications.acceptRoles', label: 'Выдаются при принятии анкеты', multi: true },
  { path: 'applications.removeRoles', label: 'Снимаются при принятии анкеты', multi: true },
  { path: 'selfRoles', label: 'Панель ролей (игроки берут сами)', multi: true, self: true },
  { path: 'punishments.roles.nlr', label: 'Наказание: NLR' },
  { path: 'punishments.roles.nonrp', label: 'Наказание: NonRP' },
  { path: 'punishments.roles.pg', label: 'Наказание: PG' },
  { path: 'punishments.roles.rdm', label: 'Наказание: RDM' },
  { path: 'punishments.roles.meta', label: 'Наказание: Meta' },
  { path: 'punishments.roles.ban', label: 'Наказание: Бан' },
];

const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const CHANNEL_SLOTS = [
  { path: 'channels.status', label: 'Статус сервера' },
  { path: 'channels.alerts', label: 'Тревоги для админов' },
  { path: 'channels.modLog', label: 'Лог модерации' },
  { path: 'channels.adminLog', label: 'Действия с игровым сервером' },
  { path: 'channels.verifyReview', label: 'Заявки на верификацию (пусто — в мод-лог)' },
  { path: 'channels.applications', label: 'Анкеты на проверку' },
  { path: 'channels.ticketLog', label: 'Архив тикетов' },
  { path: 'channels.joinLeave', label: 'Входы/выходы игроков (игра)' },
  { path: 'channels.memberLog', label: 'Входы/выходы в Discord' },
  { path: 'channels.killFeed', label: 'Килфид' },
  { path: 'channels.gameChat', label: 'Игровой чат' },
  { path: 'tickets.categoryId', label: 'Категория для тикетов', types: [ChannelType.GuildCategory] },
];

const PAGE = 5; // не больше 5 списков в одном сообщении

function ids(value, slot) {
  if (slot.self) return (value ?? []).map((r) => r.id);
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

function rolePage(ctx, page) {
  return ROLE_SLOTS.slice(page * PAGE, page * PAGE + PAGE).map((slot, n) => {
    const index = page * PAGE + n;
    const menu = new RoleSelectMenuBuilder()
      .setCustomId(`setup:role:${index}`)
      .setPlaceholder(slot.label)
      .setMinValues(0)
      .setMaxValues(slot.multi ? 10 : 1);
    const current = ids(getPath(ctx.cfg, slot.path), slot).filter((id) => ctx.guild()?.roles.cache.has(id));
    if (current.length) menu.setDefaultRoles(current);
    return new ActionRowBuilder().addComponents(menu);
  });
}

function channelPage(ctx, page) {
  return CHANNEL_SLOTS.slice(page * PAGE, page * PAGE + PAGE).map((slot, n) => {
    const index = page * PAGE + n;
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId(`setup:channel:${index}`)
      .setPlaceholder(slot.label)
      .setChannelTypes(slot.types ?? TEXT)
      .setMinValues(0)
      .setMaxValues(1);
    const current = getPath(ctx.cfg, slot.path);
    if (current && ctx.client.channels.cache.has(current)) menu.setDefaultChannels([current]);
    return new ActionRowBuilder().addComponents(menu);
  });
}

function describe(ctx) {
  const role = (id) => (id ? `<@&${id}>` : '—');
  const lines = ROLE_SLOTS.map((s) => {
    const v = ids(getPath(ctx.cfg, s.path), s);
    return `**${s.label}:** ${v.length ? v.map(role).join(' ') : '—'}`;
  });
  const chans = CHANNEL_SLOTS.map((s) => {
    const v = getPath(ctx.cfg, s.path);
    return `**${s.label}:** ${v ? `<#${v}>` : '—'}`;
  });
  const factions = (ctx.cfg.tickets.factionGuilds ?? []).map((id) => ctx.client.guilds.cache.get(id)?.name ?? `\`${id}\` (бота там нет)`);
  chans.push(`**Серверы группировок (тикеты):** ${factions.length ? factions.join(', ') : '—'}`);
  return [embed('info', 'Роли', lines.join('\n')), embed('info', 'Каналы', chans.join('\n'))];
}

export default {
  name: 'setup',
  commands: [
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Настройка бота: роли и каналы')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName('roles').setDescription('Выбрать роли'))
      .addSubcommand((s) => s.setName('channels').setDescription('Выбрать каналы'))
      .addSubcommand((s) => s.setName('show').setDescription('Текущие настройки'))
      .addSubcommand((s) => s.setName('roles-list').setDescription('Выгрузить все роли сервера с ID'))
      .addSubcommand((s) => s.setName('backup').setDescription('Сделать бэкап базы бота сейчас'))
      .addSubcommand((s) => s.setName('factions').setDescription('Серверы группировок: тикеты оттуда приходят сюда')),
  ],

  async onCommand(i, ctx) {
    ctx.require(i, LEVEL.admin);
    const sub = i.options.getSubcommand();
    const ephemeral = MessageFlags.Ephemeral;

    if (sub === 'roles' || sub === 'channels') {
      const build = sub === 'roles' ? rolePage : channelPage;
      const total = sub === 'roles' ? ROLE_SLOTS.length : CHANNEL_SLOTS.length;
      const pages = Math.ceil(total / PAGE);
      await i.reply({ content: `**${sub === 'roles' ? 'Роли' : 'Каналы'}** — выбор сохраняется сразу (1/${pages})`, components: build(ctx, 0), flags: ephemeral });
      for (let p = 1; p < pages; p++) {
        await i.followUp({ content: `(${p + 1}/${pages})`, components: build(ctx, p), flags: ephemeral });
      }
      return;
    }
    if (sub === 'show') return i.reply({ embeds: describe(ctx), flags: ephemeral });

    if (sub === 'factions') {
      const guilds = [...ctx.client.guilds.cache.values()].filter((g) => g.id !== ctx.cfg.guildId).slice(0, 25);
      if (!guilds.length) throw new BotError('Бот не добавлен ни на один другой сервер — сначала пригласи его на серверы группировок');
      const current = new Set(ctx.cfg.tickets.factionGuilds ?? []);
      const menu = new StringSelectMenuBuilder()
        .setCustomId('setup:factions')
        .setPlaceholder('Серверы группировок')
        .setMinValues(0)
        .setMaxValues(guilds.length)
        .addOptions(guilds.map((g) => ({ label: clip(g.name, 100), value: g.id, default: current.has(g.id) })));
      return i.reply({
        content: '**Серверы группировок** — тикеты с них будут приходить в категорию тикетов здесь. Затем на каждом сервере выполни `/ticket-panel` в нужном канале.',
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: ephemeral,
      });
    }

    if (sub === 'backup') {
      const b = makeBackup(ctx.db, ctx.cfg.backup.dir, ctx.cfg.backup.keep);
      const all = listBackups(ctx.cfg.backup.dir);
      return i.reply({
        embeds: [embed('ok', '💾 Бэкап сделан', `\`${b.file}\` · ${Math.round(b.size / 1024)} КБ\nВсего бэкапов: ${all.length} (хранятся последние ${ctx.cfg.backup.keep}, автоматически раз в сутки)`)],
        flags: ephemeral,
      });
    }

    if (sub === 'roles-list') {
      // Текстом, а не файлом: файлы с CDN Discord у части игроков не открываются.
      const roles = [...(await i.guild.roles.fetch()).values()]
        .filter((r) => r.id !== i.guild.id)
        .sort((a, b) => b.position - a.position);
      const lines = roles.map((r) => `<@&${r.id}> \`${r.id}\`${r.managed ? ' · бот' : ''}`);
      const chunks = [];
      for (const line of lines) {
        if (!chunks.length || chunks.at(-1).length + line.length + 1 > 3900) chunks.push('');
        chunks[chunks.length - 1] += (chunks.at(-1) ? '\n' : '') + line;
      }
      const embeds = chunks.map((text, n) => embed('info', n === 0 ? `Роли сервера: ${roles.length}` : null, text));
      // В одном сообщении не больше 6000 символов текста — шлём по одному блоку.
      await i.reply({ embeds: [embeds[0]], flags: ephemeral });
      for (const e of embeds.slice(1)) await i.followUp({ embeds: [e], flags: ephemeral });
      return;
    }
  },

  async onComponent(i, ctx, [kind, indexStr]) {
    ctx.require(i, LEVEL.admin);
    if (kind === 'factions') {
      saveSetting(ctx.cfg, ctx.db, 'tickets.factionGuilds', [...i.values]);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      await registerFactionCommands(ctx);
      const names = i.values.map((id) => ctx.client.guilds.cache.get(id)?.name ?? id);
      return i.editReply({ content: names.length ? `✅ Тикеты подключены: ${names.join(', ')}. Там появилась команда \`/ticket-panel\`.` : '✅ Серверы группировок отключены' });
    }
    const slot = (kind === 'role' ? ROLE_SLOTS : CHANNEL_SLOTS)[Number(indexStr)];
    if (!slot) throw new BotError('Неизвестная настройка');
    let value;
    if (kind === 'role') {
      const me = i.guild.members.me;
      const picked = [...i.roles.values()];
      const tooHigh = picked.filter((r) => r.position >= me.roles.highest.position || r.managed);
      if (tooHigh.length && !slot.path.startsWith('roles.admin') && !slot.path.startsWith('roles.moderator') && !slot.path.startsWith('roles.support')) {
        throw new BotError(`Бот не может выдавать: ${tooHigh.map((r) => r.name).join(', ')} — подними роль бота выше`);
      }
      if (slot.self) value = picked.map((r) => ({ id: r.id, label: clip(r.name, 80) }));
      else value = slot.multi ? picked.map((r) => r.id) : (picked[0]?.id ?? '');
    } else {
      value = i.values[0] ?? '';
    }
    saveSetting(ctx.cfg, ctx.db, slot.path, value);
    return i.reply({ content: `✅ ${slot.label}: сохранено`, flags: MessageFlags.Ephemeral });
  },
};
