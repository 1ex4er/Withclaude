// Модерация Discord: предупреждения с автоэскалацией, мут (тайм-аут), кик, бан (в т.ч. временный), очистка.

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { BotError } from '../core.js';
import { LEVEL, clip, embed, formatDuration, parseDuration, ts } from '../util.js';

const MAX_TIMEOUT = 28 * 86400e3; // ограничение Discord

const userOpt = (o) => o.setName('user').setDescription('Участник').setRequired(true);
const reasonOpt = (o) => o.setName('reason').setDescription('Причина').setMaxLength(300);

const commands = [
  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Выдать предупреждение')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(userOpt)
    .addStringOption((o) => reasonOpt(o).setRequired(true)),
  new SlashCommandBuilder()
    .setName('warns')
    .setDescription('Предупреждения участника')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(userOpt),
  new SlashCommandBuilder()
    .setName('unwarn')
    .setDescription('Снять предупреждение')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addIntegerOption((o) => o.setName('id').setDescription('Номер из /warns').setRequired(true)),
  new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Тайм-аут (мут)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(userOpt)
    .addStringOption((o) => o.setName('duration').setDescription('10m, 2h, 3d (до 28d)').setRequired(true))
    .addStringOption(reasonOpt),
  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('Снять тайм-аут')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(userOpt),
  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Выгнать из Discord')
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(userOpt)
    .addStringOption(reasonOpt),
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Забанить в Discord')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(userOpt)
    .addStringOption((o) => o.setName('duration').setDescription('7d, 30d (пусто — навсегда)'))
    .addStringOption(reasonOpt)
    .addBooleanOption((o) => o.setName('delete_messages').setDescription('Удалить сообщения за сутки')),
  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Разбанить в Discord')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName('user_id').setDescription('ID пользователя').setRequired(true)),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Удалить последние сообщения в канале')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) => o.setName('count').setDescription('Сколько (до 100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .addUserOption((o) => o.setName('user').setDescription('Только этого участника')),
];

// Нельзя наказать того, кто выше или равен по ролям, и самого бота/владельца.
function assertCanModerate(i, target) {
  if (!target) throw new BotError('Участник не на сервере');
  if (target.id === i.guild.ownerId) throw new BotError('Нельзя наказать владельца сервера');
  if (target.id === i.client.user.id) throw new BotError('Нельзя наказать бота');
  if (target.id === i.user.id) throw new BotError('Нельзя наказать себя');
  if (i.member.id !== i.guild.ownerId && target.roles.highest.position >= i.member.roles.highest.position) {
    throw new BotError('Участник выше или равен тебе по ролям');
  }
  if (!target.manageable) throw new BotError('Роль бота ниже роли участника');
}

const dm = (user, title, text) => user.send({ embeds: [embed('warn', title, text)] }).catch(() => {});

export async function addWarn(ctx, member, modId, reason) {
  ctx.db.prepare('INSERT INTO warns (discord_id, mod_id, reason, created_at) VALUES (?, ?, ?, ?)').run(member.id, modId, reason, Date.now());
  const count = ctx.db.prepare('SELECT COUNT(*) n FROM warns WHERE discord_id = ?').get(member.id).n;
  const { muteAt, muteMinutes, banAt } = ctx.cfg.warns;
  let escalation = null;
  if (banAt && count >= banAt && member.bannable) {
    await dm(member.user, 'Бан на сервере Blackout', `Набрано предупреждений: ${count}.`);
    await member.ban({ reason: `Автобан: ${count} предупреждений` });
    escalation = 'бан';
  } else if (muteAt && count >= muteAt && member.moderatable) {
    await member.timeout(muteMinutes * 60_000, `Автомут: ${count} предупреждений`);
    escalation = `мут на ${formatDuration(muteMinutes * 60_000)}`;
  }
  return { count, escalation };
}

// Временные баны хранятся в kv и снимаются по таймеру (переживает перезапуск бота).
function scheduleUnbans(ctx) {
  const tick = async () => {
    const list = ctx.db.kv.get('tempbans', []);
    const due = list.filter((b) => b.until <= Date.now());
    if (!due.length) return;
    ctx.db.kv.set('tempbans', list.filter((b) => b.until > Date.now()));
    const guild = ctx.guild();
    for (const b of due) {
      await guild?.bans.remove(b.userId, 'Срок бана истёк').catch(() => {});
      ctx.audit('⏱️ Срок бана истёк', { Пользователь: `<@${b.userId}>` }, 'ok');
    }
  };
  setInterval(() => tick().catch((e) => ctx.log.warn(`темпбаны: ${e.message}`)), 60_000);
}

export default {
  name: 'moderation',
  commands,

  init(ctx) {
    scheduleUnbans(ctx);
  },

  async onCommand(i, ctx) {
    const name = i.commandName;
    const reason = i.options.getString('reason') ?? 'Без причины';
    const user = i.options.getUser('user');
    // Участника подгружаем только для наказаний: каждый запрос к Discord через прокси — это время.
    const needsMember = ['warn', 'mute', 'unmute', 'kick', 'ban'].includes(name);
    const target = user && needsMember ? (i.options.getMember('user') ?? (await i.guild.members.fetch(user.id).catch(() => null))) : null;
    const reply = (text, color = 'ok') => i.reply({ embeds: [embed(color, null, text)], flags: MessageFlags.Ephemeral });

    if (name === 'warns') {
      ctx.require(i, LEVEL.support);
      const rows = ctx.db.prepare('SELECT * FROM warns WHERE discord_id = ? ORDER BY id DESC LIMIT 25').all(user.id);
      const text = rows.map((w) => `\`#${w.id}\` ${ts(w.created_at, 'd')} <@${w.mod_id}>: ${w.reason}`).join('\n');
      return reply(clip(text || 'Предупреждений нет', 4000), 'info');
    }

    ctx.require(i, name === 'ban' || name === 'unban' ? LEVEL.admin : LEVEL.moderator);

    if (name === 'warn') {
      assertCanModerate(i, target);
      const { count, escalation } = await addWarn(ctx, target, i.user.id, reason);
      await dm(user, 'Предупреждение на сервере Blackout', `Причина: ${reason}\nВсего предупреждений: ${count}`);
      ctx.audit('⚠️ Предупреждение', { Участник: `<@${user.id}>`, Кто: `<@${i.user.id}>`, Причина: reason, Всего: count, Автонаказание: escalation }, 'warn');
      return reply(`⚠️ ${user} предупреждён (всего: ${count})${escalation ? `, автоматически: ${escalation}` : ''}`);
    }
    if (name === 'unwarn') {
      const id = i.options.getInteger('id');
      const w = ctx.db.prepare('SELECT * FROM warns WHERE id = ?').get(id);
      if (!w) throw new BotError('Предупреждение не найдено');
      ctx.db.prepare('DELETE FROM warns WHERE id = ?').run(id);
      ctx.audit('Снято предупреждение', { Участник: `<@${w.discord_id}>`, Кто: `<@${i.user.id}>`, Было: w.reason }, 'ok');
      return reply(`Предупреждение #${id} снято`);
    }
    if (name === 'mute') {
      assertCanModerate(i, target);
      const ms = parseDuration(i.options.getString('duration'));
      if (!ms) throw new BotError('Срок в формате 10m, 2h, 3d');
      if (ms > MAX_TIMEOUT) throw new BotError('Максимум 28 дней');
      await target.timeout(ms, `${i.user.tag}: ${reason}`);
      await dm(user, 'Мут на сервере Blackout', `Срок: ${formatDuration(ms)}\nПричина: ${reason}`);
      ctx.audit('🔇 Мут', { Участник: `<@${user.id}>`, Кто: `<@${i.user.id}>`, Срок: formatDuration(ms), Причина: reason }, 'warn');
      return reply(`🔇 ${user} в муте на ${formatDuration(ms)}`);
    }
    if (name === 'unmute') {
      if (!target) throw new BotError('Участник не на сервере');
      await target.timeout(null, i.user.tag);
      ctx.audit('🔊 Снят мут', { Участник: `<@${user.id}>`, Кто: `<@${i.user.id}>` }, 'ok');
      return reply(`🔊 Мут с ${user} снят`);
    }
    if (name === 'kick') {
      assertCanModerate(i, target);
      await dm(user, 'Кик с сервера Blackout', `Причина: ${reason}`);
      await target.kick(`${i.user.tag}: ${reason}`);
      ctx.audit('👢 Кик', { Участник: `${user.tag} (<@${user.id}>)`, Кто: `<@${i.user.id}>`, Причина: reason }, 'warn');
      return reply(`👢 ${user.tag} выгнан`);
    }
    if (name === 'ban') {
      if (target) assertCanModerate(i, target);
      const ms = parseDuration(i.options.getString('duration'));
      if (ms === undefined) throw new BotError('Срок в формате 7d, 30d');
      await dm(user, 'Бан на сервере Blackout', `Срок: ${formatDuration(ms)}\nПричина: ${reason}`);
      await i.guild.bans.create(user.id, {
        reason: `${i.user.tag}: ${reason}`,
        deleteMessageSeconds: i.options.getBoolean('delete_messages') ? 86400 : 0,
      });
      if (ms) ctx.db.kv.set('tempbans', [...ctx.db.kv.get('tempbans', []).filter((b) => b.userId !== user.id), { userId: user.id, until: Date.now() + ms }]);
      ctx.audit('🔨 Бан', { Участник: `${user.tag} (<@${user.id}>)`, Кто: `<@${i.user.id}>`, Срок: formatDuration(ms), Причина: reason }, 'bad');
      return reply(`🔨 ${user.tag} забанен (${formatDuration(ms)})`);
    }
    if (name === 'unban') {
      const id = i.options.getString('user_id');
      if (!/^\d{17,20}$/.test(id)) throw new BotError('Неверный ID');
      await i.guild.bans.remove(id, i.user.tag).catch(() => {
        throw new BotError('Этот пользователь не забанен');
      });
      ctx.db.kv.set('tempbans', ctx.db.kv.get('tempbans', []).filter((b) => b.userId !== id));
      ctx.audit('Разбан', { Пользователь: `<@${id}>`, Кто: `<@${i.user.id}>` }, 'ok');
      return reply(`<@${id}> разбанен`);
    }
    if (name === 'clear') {
      const count = i.options.getInteger('count');
      const fetched = await i.channel.messages.fetch({ limit: 100 });
      const twoWeeks = Date.now() - 14 * 86400e3 + 60_000;
      const toDelete = [...fetched.values()].filter((m) => (!user || m.author.id === user.id) && m.createdTimestamp > twoWeeks).slice(0, count);
      const deleted = await i.channel.bulkDelete(toDelete, true);
      ctx.audit('🧹 Очистка', { Канал: `<#${i.channel.id}>`, Кто: `<@${i.user.id}>`, Удалено: deleted.size, Участник: user ? `<@${user.id}>` : null });
      return reply(`🧹 Удалено сообщений: ${deleted.size}`);
    }
  },
};
