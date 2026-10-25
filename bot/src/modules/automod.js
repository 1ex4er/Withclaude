// Автомодерация: скам-ссылки (часто от взломанных аккаунтов), чужие инвайты, флуд, масс-упоминания.
// Персонал и роли из automod.exemptRoles не проверяются.
// На серверах группировок — если включено guilds.<id>.automod; там не проверяются их администраторы,
// а лог идёт в guilds.<id>.channels.modLog (пусто — в лог модерации основного сервера).

import { Events, PermissionFlagsBits } from 'discord.js';
import { SpamTracker, detectScam, hasInvite } from '../automod-rules.js';
import { clip } from '../util.js';

export default {
  name: 'automod',

  init(ctx) {
    const cfg = ctx.cfg.automod;
    const spam = new SpamTracker(cfg.spam, cfg.duplicates);
    setInterval(() => spam.users.clear(), 10 * 60_000).unref();

    const punish = async (message, reason, { timeout }) => {
      spam.forget(message.author.id);
      await message.delete().catch(() => {});
      let action = 'сообщение удалено';
      if (timeout && message.member?.moderatable) {
        await message.member.timeout(cfg.timeoutMinutes * 60_000, `Автомодерация: ${reason}`).catch(() => {});
        action += `, мут ${cfg.timeoutMinutes} мин`;
      }
      const notice = await message.channel
        .send({ content: `<@${message.author.id}>, ${reason} — ${action}.`, allowedMentions: { users: [message.author.id] } })
        .catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => {}), 8000);
      const fields = { Участник: `<@${message.author.id}>`, Канал: `<#${message.channel.id}>`, Причина: reason, Действие: action, Текст: clip(message.content || '—', 900) };
      const faction = ctx.faction(message.guild.id);
      if (!faction) return ctx.audit('🤖 Автомодерация', fields, 'warn');
      if (faction.channels?.modLog) return ctx.audit('🤖 Автомодерация', fields, 'warn', faction.channels.modLog);
      return ctx.audit(`🤖 Автомодерация · ${message.guild.name}`, { ...fields, Участник: `${message.author.tag} (${message.author.id})` }, 'warn');
    };

    ctx.client.on(Events.MessageCreate, async (message) => {
      try {
        if (!message.guild || message.author.bot || !message.member) return;
        if (message.guild.id !== ctx.cfg.guildId && !ctx.faction(message.guild.id)?.automod) return;
        if (ctx.level(message.member) > 0) return;
        if (cfg.exemptRoles.some((r) => message.member.roles.cache.has(r))) return;
        const text = message.content ?? '';

        if (cfg.blockScamLinks) {
          const scam = detectScam(text, cfg.extraBlockedPatterns);
          if (scam) return punish(message, `скам: ${scam}`, { timeout: true });
        }
        if (cfg.blockInvites && hasInvite(text)) return punish(message, 'ссылки-приглашения на другие серверы запрещены', { timeout: false });

        const pingEveryone = /@(everyone|here)/.test(text) && !message.member.permissions.has(PermissionFlagsBits.MentionEveryone);
        const mentions = message.mentions.users.size + message.mentions.roles.size;
        if (mentions >= cfg.maxMentions || (pingEveryone && /https?:\/\//.test(text))) {
          return punish(message, 'массовые упоминания', { timeout: true });
        }

        const flood = spam.hit(message.author.id, text || `[вложение ${message.attachments.size}]`);
        if (flood) return punish(message, flood, { timeout: true });
      } catch (e) {
        ctx.log.warn(`automod: ${e.message}`);
      }
    });
  },
};
