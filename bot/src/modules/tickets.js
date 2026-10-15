// Тикеты: приватный канал с автором и персоналом. При закрытии — расшифровка в канал логов.
// Серверы группировок (tickets.factionGuilds, выбираются в /setup factions): игрок пишет в своём Discord,
// а тикет-зеркало появляется на основном сервере Blackout. Сообщения пересылаются в обе стороны;
// сообщения персонала, начинающиеся с «//», остаются внутренней заметкой и игроку не уходят.

import fs from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Events,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { BotError } from '../core.js';
import { LEVEL, clip, embed } from '../util.js';

export function ticketPanel(ctx) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('tickets:type')
    .setPlaceholder('Выбери тему обращения')
    .addOptions(ctx.cfg.tickets.types.map((t) => ({ label: t.label, value: t.id, emoji: t.emoji })));
  return {
    embeds: [embed('info', '🎫 Поддержка', 'Выбери тему — бот создаст приватный канал, где ответит администрация.')],
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

const controls = (id) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tickets:claim:${id}`).setLabel('Взять').setEmoji('🙋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tickets:close:${id}`).setLabel('Закрыть').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );

const closeOnly = (id) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tickets:close:${id}`).setLabel('Закрыть').setEmoji('🔒').setStyle(ButtonStyle.Danger),
  );

// Команды для серверов группировок (на основном сервере панель ставится через /panel).
export const FACTION_COMMANDS = [
  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Разместить панель тикетов Blackout в этом канале')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

export const isFaction = (cfg, guildId) => guildId !== cfg.guildId && (cfg.tickets.factionGuilds ?? []).includes(guildId);

// Регистрирует /ticket-panel на серверах группировок и убирает команды с остальных посторонних серверов.
export async function registerFactionCommands(ctx) {
  const json = FACTION_COMMANDS.map((c) => c.toJSON());
  for (const guild of (await ctx.client.guilds.fetch()).values()) {
    if (guild.id === ctx.cfg.guildId) continue;
    const on = isFaction(ctx.cfg, guild.id);
    try {
      const g = await guild.fetch();
      await g.commands.set(on ? json : []);
      if (on) ctx.log.info(`тикеты группировки: ${g.name}`);
    } catch (e) {
      ctx.log.warn(`команды на сервере ${guild.name ?? guild.id}: ${e.message}`);
    }
  }
}

// Имя канала-зеркала: короткое имя сервера группировки.
export const slug = (name) =>
  String(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20) || 'group';

// Текст пересылки. toPlayer — сообщение персонала уходит игроку; иначе сообщение игрока уходит персоналу.
export function relayText({ name, content, attachments = [] }, toPlayer) {
  const who = toPlayer ? `**${name}** · Администрация Blackout` : `**${name}**`;
  const files = attachments.map((url) => `📎 ${url}`).join('\n');
  const body = [content?.trim(), files].filter(Boolean).join('\n');
  if (!body) return null;
  return clip(`${who}: ${body}`, 2000);
}

async function transcript(channel) {
  const all = [];
  let before;
  for (let n = 0; n < 20; n++) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
  }
  return all
    .reverse()
    .map((m) => {
      const time = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
      const files = [...m.attachments.values()].map((a) => ` [файл: ${a.url}]`).join('');
      const embeds = m.embeds.map((e) => ` [${e.title ?? ''} ${e.description ?? ''}]`).join('');
      return `[${time}] ${m.author.tag}: ${m.content}${embeds}${files}`;
    })
    .join('\n');
}

const fetchChannel = (ctx, id) => (id ? ctx.client.channels.fetch(id).catch(() => null) : Promise.resolve(null));

const ALLOW = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles];
const staffRoles = (ctx) => [...ctx.cfg.roles.admin, ...ctx.cfg.roles.moderator, ...ctx.cfg.roles.support].filter(Boolean);

// Канал персонала на основном сервере: обычный тикет — с автором, зеркало группировки — без него.
function staffChannel(ctx, guild, { name, topic, userId }) {
  const staff = staffRoles(ctx);
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: ctx.cfg.tickets.categoryId || undefined,
    topic,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      ...(userId ? [{ id: userId, allow: ALLOW }] : []),
      { id: ctx.client.user.id, allow: [...ALLOW, PermissionFlagsBits.ManageChannels] },
      ...staff.map((r) => ({ id: r, allow: ALLOW })),
    ],
  });
}

export default {
  name: 'tickets',
  factionCommands: FACTION_COMMANDS,

  init(ctx) {
    ctx.cfg.tickets.factionGuilds ??= [];
    const find = ctx.db.prepare("SELECT * FROM tickets WHERE status = 'open' AND mirror_id IS NOT NULL AND (channel_id = ? OR mirror_id = ?)");

    ctx.client.on(Events.MessageCreate, async (message) => {
      if (!message.guild || message.author.bot || message.webhookId || message.system) return;
      const t = find.get(message.channelId, message.channelId);
      if (!t) return;
      const toPlayer = message.channelId === t.mirror_id;
      if (toPlayer && message.content.startsWith('//')) return; // внутренняя заметка персонала
      const text = relayText(
        { name: message.member?.displayName ?? message.author.username, content: message.content, attachments: [...message.attachments.values()].map((a) => a.url) },
        toPlayer,
      );
      if (!text) return;
      const target = await fetchChannel(ctx, toPlayer ? t.channel_id : t.mirror_id);
      try {
        if (!target) throw new Error('канал не найден');
        await target.send({ content: text, allowedMentions: { parse: [] } });
      } catch (e) {
        ctx.log.warn(`тикет #${t.id}: не удалось переслать: ${e.message}`);
        message.react('⚠️').catch(() => {});
      }
    });

    return registerFactionCommands(ctx);
  },

  async onCommand(i, ctx) {
    if (i.commandName !== 'ticket-panel') return;
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new BotError('Нужно право «Управлять сервером»');
    await i.channel.send(ticketPanel(ctx));
    return i.reply({ embeds: [embed('ok', null, 'Панель тикетов размещена. Обращения уйдут администрации Blackout.')], flags: MessageFlags.Ephemeral });
  },

  async onComponent(i, ctx, [action, arg]) {
    const cfg = ctx.cfg.tickets;
    const q = {
      open: ctx.db.prepare("SELECT COUNT(*) n FROM tickets WHERE discord_id = ? AND status = 'open'"),
      get: ctx.db.prepare('SELECT * FROM tickets WHERE id = ?'),
    };
    const faction = i.guildId !== ctx.cfg.guildId;
    if ((action === 'type' || action === 'create') && faction && !isFaction(ctx.cfg, i.guildId)) {
      throw new BotError('Тикеты на этом сервере не подключены');
    }

    if (action === 'type') {
      const type = cfg.types.find((t) => t.id === i.values[0]);
      if (!type) throw new BotError('Неизвестная тема');
      if (q.open.get(i.user.id).n >= cfg.maxOpenPerUser) throw new BotError('У тебя уже есть открытые тикеты — дождись ответа в них');
      const modal = new ModalBuilder()
        .setCustomId(`tickets:create:${type.id}`)
        .setTitle(type.label)
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('text').setLabel('Опиши ситуацию').setStyle(TextInputStyle.Paragraph).setMinLength(10).setMaxLength(1500).setRequired(true),
          ),
        );
      return i.showModal(modal);
    }

    if (action === 'create') {
      const type = cfg.types.find((t) => t.id === arg);
      if (!type) throw new BotError('Неизвестная тема');
      if (q.open.get(i.user.id).n >= cfg.maxOpenPerUser) throw new BotError('У тебя уже есть открытые тикеты');
      const main = faction ? ctx.guild() : i.guild;
      if (!main) throw new BotError('Основной сервер Blackout недоступен, попробуй позже');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const { lastInsertRowid: id } = ctx.db
        .prepare('INSERT INTO tickets (discord_id, type, guild_id, created_at) VALUES (?, ?, ?, ?)')
        .run(i.user.id, type.id, i.guildId, Date.now());
      const num = String(id).padStart(4, '0');
      const staff = staffRoles(ctx);
      const text = i.fields.getTextInputValue('text');
      const request = () => embed('info', `${type.emoji ?? ''} ${type.label} · #${id}`, text).setAuthor({ name: i.user.tag, iconURL: i.user.displayAvatarURL() });
      const ping = {
        content: staff.map((r) => `<@&${r}>`).join(' ') || undefined,
        allowedMentions: { roles: staff },
      };

      try {
        if (!faction) {
          const channel = await staffChannel(ctx, i.guild, { name: `${type.id}-${num}`, topic: `Тикет #${id} · ${type.label} · ${i.user.tag}`, userId: i.user.id });
          ctx.db.prepare('UPDATE tickets SET channel_id = ? WHERE id = ?').run(channel.id, id);
          await channel.send({
            content: `<@${i.user.id}>${ping.content ? ' ' + ping.content : ''}`,
            allowedMentions: { users: [i.user.id], roles: staff },
            embeds: [request()],
            components: [controls(id)],
          });
          return i.editReply({ embeds: [embed('ok', null, `Тикет создан: ${channel}`)] });
        }

        // Группировка: канал игрока на его сервере + зеркало для персонала на основном.
        const own = await i.guild.channels.create({
          name: `${type.id}-${num}`,
          type: ChannelType.GuildText,
          parent: i.channel?.parentId ?? undefined,
          topic: `Тикет Blackout #${id} · ${type.label} · ${i.user.tag}`,
          permissionOverwrites: [
            { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: i.user.id, allow: ALLOW },
            { id: ctx.client.user.id, allow: [...ALLOW, PermissionFlagsBits.ManageChannels] },
          ],
        });
        ctx.db.prepare('UPDATE tickets SET channel_id = ? WHERE id = ?').run(own.id, id);
        const mirror = await staffChannel(ctx, main, {
          name: `${slug(i.guild.name)}-${type.id}-${num}`,
          topic: `Тикет #${id} · ${type.label} · ${i.user.tag} · сервер «${i.guild.name}»`,
        });
        ctx.db.prepare('UPDATE tickets SET mirror_id = ? WHERE id = ?').run(mirror.id, id);
        await mirror.send({
          ...ping,
          embeds: [
            request().addFields(
              { name: 'Сервер', value: i.guild.name, inline: true },
              { name: 'Игрок', value: `<@${i.user.id}> \`${i.user.id}\``, inline: true },
            ),
            embed('neutral', null, 'Всё, что напишете здесь, уйдёт игроку. Внутренняя заметка — начните сообщение с `//`.'),
          ],
          components: [controls(id)],
        });
        await own.send({
          content: `<@${i.user.id}>`,
          allowedMentions: { users: [i.user.id] },
          embeds: [request(), embed('neutral', null, 'Обращение передано администрации Blackout. Ответ придёт сюда — можешь дописать подробности и приложить скриншоты.')],
          components: [closeOnly(id)],
        });
        return i.editReply({ embeds: [embed('ok', null, `Тикет создан: ${own}`)] });
      } catch (e) {
        ctx.log.warn(`тикет #${id}: ${e.message}`);
        const t = q.get.get(Number(id));
        for (const ch of [t.channel_id, t.mirror_id]) (await fetchChannel(ctx, ch))?.delete().catch(() => {});
        ctx.db.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ?").run(Date.now(), id);
        throw new BotError('Не удалось создать канал тикета — у бота не хватает прав, сообщи администрации');
      }
    }

    const t = q.get.get(Number(arg));
    if (!t || t.status !== 'open') throw new BotError('Тикет уже закрыт');
    // Персонал — только по ролям основного сервера: админ сервера группировки им не считается.
    const isStaff = i.guildId === ctx.cfg.guildId && ctx.level(i.member) >= LEVEL.support;

    if (action === 'claim') {
      if (!isStaff) throw new BotError('Нужны права: поддержка');
      ctx.db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?').run(i.user.id, t.id);
      if (t.mirror_id) {
        const own = await fetchChannel(ctx, t.channel_id);
        own?.send({ embeds: [embed('info', null, `🙋 Тикетом занимается администратор **${i.member?.displayName ?? i.user.username}**`)] }).catch(() => {});
      }
      return i.reply({ embeds: [embed('info', null, `🙋 Тикетом занимается <@${i.user.id}>`)] });
    }

    if (action === 'close') {
      if (t.discord_id !== i.user.id && !isStaff) throw new BotError('Нужны права: поддержка');
      const closed = ctx.db
        .prepare("UPDATE tickets SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ? AND status = 'open'")
        .run(i.user.id, Date.now(), t.id);
      if (closed.changes === 0) throw new BotError('Тикет уже закрыт');
      const notice = embed('warn', null, `🔒 Тикет закрывает <@${i.user.id}>. Канал будет удалён через 10 секунд.`);
      await i.reply({ embeds: [notice] });

      const channels = [...new Set([t.channel_id, t.mirror_id, i.channelId].filter(Boolean))];
      const other = await Promise.all(channels.filter((id) => id !== i.channelId).map((id) => fetchChannel(ctx, id)));
      for (const ch of other) {
        ch?.send({ embeds: [embed('warn', null, `🔒 Тикет закрыт (${i.member?.displayName ?? i.user.username}). Канал будет удалён через 10 секунд.`)] }).catch(() => {});
      }
      // В зеркале есть вся переписка: и игрока, и персонала, и заметки.
      const source = t.mirror_id ? ((await fetchChannel(ctx, t.mirror_id)) ?? i.channel) : i.channel;
      const text = await transcript(source).catch(() => '');
      fs.mkdirSync(ctx.cfg.transcriptsDir, { recursive: true });
      const file = path.join(ctx.cfg.transcriptsDir, `ticket-${t.id}.txt`);
      fs.writeFileSync(file, text);
      const guildName = t.guild_id && t.guild_id !== ctx.cfg.guildId ? ctx.client.guilds.cache.get(t.guild_id)?.name : null;
      await ctx.post('ticketLog', {
        embeds: [
          embed('neutral', `Тикет #${t.id} закрыт`).addFields(
            { name: 'Автор', value: `<@${t.discord_id}>`, inline: true },
            { name: 'Тема', value: t.type, inline: true },
            ...(guildName ? [{ name: 'Сервер', value: guildName, inline: true }] : []),
            { name: 'Закрыл', value: `<@${i.user.id}>`, inline: true },
            { name: 'Вёл', value: t.claimed_by ? `<@${t.claimed_by}>` : '—', inline: true },
          ),
        ],
        files: [new AttachmentBuilder(file, { name: `ticket-${t.id}.txt` })],
      });
      setTimeout(async () => {
        for (const id of channels) (await fetchChannel(ctx, id))?.delete(`Тикет #${t.id} закрыт`).catch(() => {});
      }, 10_000);
    }
  },
};
