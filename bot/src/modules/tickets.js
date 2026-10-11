// Тикеты: приватный канал с автором и персоналом. При закрытии — расшифровка в канал логов.

import fs from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { BotError } from '../core.js';
import { LEVEL, embed } from '../util.js';

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

export default {
  name: 'tickets',

  async onComponent(i, ctx, [action, arg]) {
    const cfg = ctx.cfg.tickets;
    const q = {
      open: ctx.db.prepare("SELECT COUNT(*) n FROM tickets WHERE discord_id = ? AND status = 'open'"),
      get: ctx.db.prepare('SELECT * FROM tickets WHERE id = ?'),
    };

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
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const { lastInsertRowid: id } = ctx.db
        .prepare('INSERT INTO tickets (discord_id, type, created_at) VALUES (?, ?, ?)')
        .run(i.user.id, type.id, Date.now());

      const staff = [...ctx.cfg.roles.admin, ...ctx.cfg.roles.moderator, ...ctx.cfg.roles.support].filter(Boolean);
      const allow = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles];
      const channel = await i.guild.channels.create({
        name: `${type.id}-${String(id).padStart(4, '0')}`,
        type: ChannelType.GuildText,
        parent: cfg.categoryId || undefined,
        topic: `Тикет #${id} · ${type.label} · ${i.user.tag}`,
        permissionOverwrites: [
          { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: i.user.id, allow },
          { id: ctx.client.user.id, allow: [...allow, PermissionFlagsBits.ManageChannels] },
          ...staff.map((r) => ({ id: r, allow })),
        ],
      });
      ctx.db.prepare('UPDATE tickets SET channel_id = ? WHERE id = ?').run(channel.id, id);
      const text = i.fields.getTextInputValue('text');
      await channel.send({
        content: `<@${i.user.id}>${staff.length ? ' ' + staff.map((r) => `<@&${r}>`).join(' ') : ''}`,
        allowedMentions: { users: [i.user.id], roles: staff },
        embeds: [embed('info', `${type.emoji ?? ''} ${type.label} · #${id}`, text).setAuthor({ name: i.user.tag, iconURL: i.user.displayAvatarURL() })],
        components: [controls(id)],
      });
      return i.editReply({ embeds: [embed('ok', null, `Тикет создан: ${channel}`)] });
    }

    const t = q.get.get(Number(arg));
    if (!t || t.status !== 'open') throw new BotError('Тикет уже закрыт');

    if (action === 'claim') {
      ctx.require(i, LEVEL.support);
      ctx.db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?').run(i.user.id, t.id);
      return i.reply({ embeds: [embed('info', null, `🙋 Тикетом занимается <@${i.user.id}>`)] });
    }

    if (action === 'close') {
      const isOwner = t.discord_id === i.user.id;
      if (!isOwner) ctx.require(i, LEVEL.support);
      const closed = ctx.db
        .prepare("UPDATE tickets SET status = 'closed', closed_by = ?, closed_at = ? WHERE id = ? AND status = 'open'")
        .run(i.user.id, Date.now(), t.id);
      if (closed.changes === 0) throw new BotError('Тикет уже закрыт');
      await i.reply({ embeds: [embed('warn', null, `🔒 Тикет закрывает <@${i.user.id}>. Канал будет удалён через 10 секунд.`)] });

      const text = await transcript(i.channel);
      fs.mkdirSync(ctx.cfg.transcriptsDir, { recursive: true });
      const file = path.join(ctx.cfg.transcriptsDir, `ticket-${t.id}.txt`);
      fs.writeFileSync(file, text);
      await ctx.post('ticketLog', {
        embeds: [
          embed('neutral', `Тикет #${t.id} закрыт`).addFields(
            { name: 'Автор', value: `<@${t.discord_id}>`, inline: true },
            { name: 'Тема', value: t.type, inline: true },
            { name: 'Закрыл', value: `<@${i.user.id}>`, inline: true },
            { name: 'Вёл', value: t.claimed_by ? `<@${t.claimed_by}>` : '—', inline: true },
          ),
        ],
        files: [new AttachmentBuilder(file, { name: `ticket-${t.id}.txt` })],
      });
      setTimeout(() => i.channel.delete(`Тикет #${t.id} закрыт`).catch(() => {}), 10_000);
    }
  },
};
