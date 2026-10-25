// Входы и выходы участников Discord-сервера — в канал channels.memberLog.
// Вход: возраст аккаунта, по какому приглашению, сколько теперь участников.
// Выход: сколько был на сервере, роли, ушёл сам или кикнут/забанен (по журналу аудита).
// Приглашения бот видит с правом «Управлять сервером», журнал аудита — с «Просматривать журнал аудита»;
// без них эти строки просто не показываются.

import { AuditLogEvent, Events } from 'discord.js';
import { clip, embed, escapeMd, formatDuration, ts } from '../util.js';

// Сколько раз использовано каждое приглашение: новое срабатывание = то, у которого выросло.
async function fetchInvites(guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (!invites) return null;
  return new Map(invites.map((i) => [i.code, { uses: i.uses ?? 0, inviterId: i.inviterId ?? null }]));
}

export function usedInvite(before, after) {
  if (!before || !after) return null;
  for (const [code, now] of after) {
    const was = before.get(code)?.uses ?? 0;
    if (now.uses > was) return { code, inviterId: now.inviterId };
  }
  // Одноразовое приглашение исчезает сразу после входа.
  const gone = [...before.keys()].filter((code) => !after.has(code));
  if (gone.length === 1) return { code: gone[0], inviterId: before.get(gone[0]).inviterId };
  return null;
}

async function leaveReason(guild, userId) {
  // Запись в журнал аудита появляется чуть позже события выхода.
  await new Promise((r) => setTimeout(r, 1500));
  for (const [type, text] of [
    [AuditLogEvent.MemberBanAdd, '🔨 забанен'],
    [AuditLogEvent.MemberKick, '👢 кикнут'],
  ]) {
    const logs = await guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
    const entry = logs?.entries.find((e) => e.targetId === userId && Date.now() - e.createdTimestamp < 15_000);
    if (entry) return `${text}${entry.executorId ? ` — <@${entry.executorId}>` : ''}${entry.reason ? `\nПричина: ${clip(entry.reason, 300)}` : ''}`;
  }
  return 'ушёл сам';
}

export default {
  name: 'memberlog',

  async init(ctx) {
    const guild = ctx.guild();
    let invites = guild ? await fetchInvites(guild) : null;
    if (guild && !invites) ctx.log.warn('входы в Discord: нет права «Управлять сервером» — приглашения не отслеживаются');

    ctx.client.on(Events.InviteCreate, (i) => {
      if (i.guild?.id === ctx.cfg.guildId) invites?.set(i.code, { uses: i.uses ?? 0, inviterId: i.inviterId ?? null });
    });

    ctx.client.on(Events.GuildMemberAdd, async (member) => {
      if (member.guild.id !== ctx.cfg.guildId) return;
      try {
        const after = await fetchInvites(member.guild);
        const invite = usedInvite(invites, after);
        if (after) invites = after;

        const created = member.user.createdTimestamp;
        const ageDays = (Date.now() - created) / 86400e3;
        const young = ageDays < ctx.cfg.verify.minAccountAgeDays;
        let via = null;
        if (invite) via = `\`${invite.code}\`${invite.inviterId ? ` от <@${invite.inviterId}>` : ''}`;
        else if (after && member.guild.vanityURLCode) via = `персональная ссылка \`${member.guild.vanityURLCode}\``;

        const e = embed(young ? 'warn' : 'ok', member.user.bot ? '🤖 Добавлен бот' : '📥 Зашёл на сервер', `<@${member.id}> · ${escapeMd(member.user.tag)}`)
          .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
          .addFields(
            { name: 'Аккаунт создан', value: `${ts(created, 'D')} (${ts(created)})${young ? '\n⚠️ новый аккаунт' : ''}`, inline: true },
            { name: 'Участников', value: String(member.guild.memberCount), inline: true },
          )
          .setFooter({ text: `ID ${member.id}` });
        if (via) e.addFields({ name: 'Приглашение', value: via, inline: true });
        await ctx.post('memberLog', { embeds: [e] });
      } catch (err) {
        ctx.log.warn(`вход в Discord: ${err.message}`);
      }
    });

    ctx.client.on(Events.GuildMemberRemove, async (member) => {
      if (member.guild.id !== ctx.cfg.guildId) return;
      try {
        const reason = await leaveReason(member.guild, member.id);
        const roles = member.roles?.cache
          ? [...member.roles.cache.values()].filter((r) => r.id !== member.guild.id).sort((a, b) => b.position - a.position)
          : [];
        const e = embed(reason === 'ушёл сам' ? 'neutral' : 'bad', '📤 Покинул сервер', `<@${member.id}> · ${escapeMd(member.user.tag)}`)
          .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
          .addFields({ name: 'Как', value: reason, inline: true });
        if (member.joinedTimestamp) {
          e.addFields({ name: 'Был на сервере', value: `${formatDuration(Date.now() - member.joinedTimestamp)} (с ${ts(member.joinedTimestamp, 'D')})`, inline: true });
        }
        e.addFields({ name: 'Участников', value: String(member.guild.memberCount), inline: true });
        if (roles.length) e.addFields({ name: `Роли (${roles.length})`, value: clip(roles.map((r) => `<@&${r.id}>`).join(' '), 1024) });
        e.setFooter({ text: `ID ${member.id}` });
        await ctx.post('memberLog', { embeds: [e] });
      } catch (err) {
        ctx.log.warn(`выход из Discord: ${err.message}`);
      }
    });
  },
};
