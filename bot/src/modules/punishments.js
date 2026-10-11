// RP-наказания: роль NLR / NonRP / PG / RDM / Meta / Бан на срок (или до снятия) с причиной.
// Бот сам снимает роль по истечении срока. Вся история — в базе (видна в /punishments и /profile).

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { BotError } from '../core.js';
import { LEVEL, clip, embed, formatDuration, parseDuration, ts } from '../util.js';
import { assertCanModerate } from './moderation.js';

export const PUNISH_TYPES = [
  { key: 'nlr', label: 'NLR' },
  { key: 'nonrp', label: 'NonRP' },
  { key: 'pg', label: 'PG' },
  { key: 'rdm', label: 'RDM' },
  { key: 'meta', label: 'Meta' },
  { key: 'ban', label: 'Бан' },
];
const label = (key) => PUNISH_TYPES.find((t) => t.key === key)?.label ?? key;
const typeOption = (o) =>
  o
    .setName('type')
    .setDescription('Наказание')
    .setRequired(true)
    .addChoices(...PUNISH_TYPES.map((t) => ({ name: t.label, value: t.key })));

const commands = [
  new SlashCommandBuilder()
    .setName('punish')
    .setDescription('Выдать RP-наказание (роль на срок)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Игрок').setRequired(true))
    .addStringOption(typeOption)
    .addStringOption((o) => o.setName('reason').setDescription('Причина').setRequired(true).setMaxLength(300))
    .addStringOption((o) => o.setName('duration').setDescription('Срок: 12h, 3d, 1w (пусто — до снятия)')),
  new SlashCommandBuilder()
    .setName('unpunish')
    .setDescription('Снять RP-наказание')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Игрок').setRequired(true))
    .addStringOption(typeOption)
    .addStringOption((o) => o.setName('reason').setDescription('Причина снятия').setMaxLength(200)),
  new SlashCommandBuilder()
    .setName('punishments')
    .setDescription('RP-наказания игрока: активные и история')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((o) => o.setName('user').setDescription('Игрок').setRequired(true)),
];

function queries(db) {
  return {
    active: db.prepare('SELECT * FROM punishments WHERE discord_id = ? AND type = ? AND removed_at IS NULL'),
    activeAll: db.prepare('SELECT * FROM punishments WHERE discord_id = ? AND removed_at IS NULL ORDER BY id DESC'),
    history: db.prepare('SELECT * FROM punishments WHERE discord_id = ? ORDER BY id DESC LIMIT 15'),
    insert: db.prepare('INSERT INTO punishments (discord_id, type, role_id, mod_id, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    remove: db.prepare('UPDATE punishments SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL'),
    due: db.prepare('SELECT * FROM punishments WHERE removed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?'),
  };
}

export function punishmentLine(p) {
  const term = p.expires_at ? `до ${ts(p.expires_at, 'f')}` : 'до снятия';
  const state = p.removed_at ? ` · снято ${p.removed_by === 'auto' ? 'по сроку' : `<@${p.removed_by}>`}` : ' · **активно**';
  return `\`#${p.id}\` **${label(p.type)}** ${ts(p.created_at, 'd')} <@${p.mod_id}>: ${clip(p.reason, 120)} (${term})${state}`;
}

export default {
  name: 'punishments',
  commands,

  init(ctx) {
    const q = queries(ctx.db);
    // Снятие по сроку — раз в минуту; переживает перезапуск бота.
    const tick = async () => {
      const guild = ctx.guild();
      for (const p of q.due.all(Date.now())) {
        if (q.remove.run(Date.now(), 'auto', p.id).changes === 0) continue;
        const member = await guild?.members.fetch(p.discord_id).catch(() => null);
        // Роль снимаем, только если нет другого активного наказания с той же ролью.
        const still = q.activeAll.all(p.discord_id).some((x) => x.role_id === p.role_id);
        if (member && !still) await member.roles.remove(p.role_id, `Срок наказания ${label(p.type)} истёк`).catch(() => {});
        ctx.audit('⏱️ Наказание снято по сроку', { Игрок: `<@${p.discord_id}>`, Наказание: label(p.type), Было: p.reason }, 'ok');
      }
    };
    setInterval(() => tick().catch((e) => ctx.log.warn(`наказания: ${e.message}`)), 60_000).unref();
    tick().catch(() => {});
  },

  async onCommand(i, ctx) {
    ctx.require(i, LEVEL.moderator);
    const q = queries(ctx.db);
    const user = i.options.getUser('user');

    if (i.commandName === 'punishments') {
      const rows = q.history.all(user.id);
      const active = rows.filter((p) => !p.removed_at).length;
      return i.reply({
        embeds: [embed(active ? 'warn' : 'info', `Наказания ${user.tag}`, rows.length ? rows.map(punishmentLine).join('\n') : 'Наказаний нет').setFooter({ text: `Активных: ${active}` })],
        flags: MessageFlags.Ephemeral,
      });
    }

    const type = i.options.getString('type');
    const roleId = ctx.cfg.punishments.roles[type];
    if (!roleId) throw new BotError(`Роль для «${label(type)}» не выбрана: /setup roles`);
    const member = i.options.getMember('user') ?? (await i.guild.members.fetch(user.id).catch(() => null));

    if (i.commandName === 'punish') {
      assertCanModerate(i, member);
      const ms = parseDuration(i.options.getString('duration'));
      if (ms === undefined) throw new BotError('Срок в формате 12h, 3d, 1w');
      const reason = i.options.getString('reason');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      // Повторное наказание того же типа заменяет прежнее (новый срок).
      for (const old of q.active.all(user.id, type)) q.remove.run(Date.now(), i.user.id, old.id);
      const { lastInsertRowid: id } = q.insert.run(user.id, type, roleId, i.user.id, reason, Date.now(), ms ? Date.now() + ms : null);
      try {
        await member.roles.add(roleId, `${label(type)}: ${reason} (${i.user.tag})`);
      } catch (e) {
        q.remove.run(Date.now(), 'error', id);
        throw new BotError(`Не удалось выдать роль (роль бота ниже роли «${label(type)}»?): ${e.message}`);
      }
      member
        .send({ embeds: [embed('warn', `Наказание: ${label(type)}`, `Причина: ${reason}\nСрок: ${formatDuration(ms)}\n\nОбжаловать можно через тикет.`)] })
        .catch(() => {});
      ctx.audit(`⚖️ Наказание ${label(type)}`, { Игрок: `<@${user.id}>`, Кто: `<@${i.user.id}>`, Срок: formatDuration(ms), Причина: reason, Номер: `#${id}` }, 'warn');
      return i.editReply({ embeds: [embed('ok', null, `⚖️ ${user} — **${label(type)}** на ${formatDuration(ms)}`)] });
    }

    if (i.commandName === 'unpunish') {
      const active = q.active.all(user.id, type);
      if (!active.length) throw new BotError(`У игрока нет активного «${label(type)}»`);
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      for (const p of active) q.remove.run(Date.now(), i.user.id, p.id);
      if (member) await member.roles.remove(roleId, `Снято: ${i.user.tag}`).catch(() => {});
      const reason = i.options.getString('reason');
      ctx.audit(`Снято наказание ${label(type)}`, { Игрок: `<@${user.id}>`, Кто: `<@${i.user.id}>`, Причина: reason }, 'ok');
      return i.editReply({ embeds: [embed('ok', null, `Наказание **${label(type)}** с ${user} снято`)] });
    }
  },
};
