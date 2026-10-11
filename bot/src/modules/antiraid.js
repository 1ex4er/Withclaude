// Антирейд и антинюк.
//  - Антирейд: слишком много входов за короткое время -> режим рейда: новые участники кикаются,
//    персонал получает тревогу. Режим выключается сам через lockMinutes или командой /raidmode.
//  - Антинюк: если кто-то (не из доверенных) массово удаляет каналы/роли, банит или кикает —
//    с него снимаются все роли (или бот выгоняется), персонал получает тревогу.
//    Боту нужна роль ВЫШЕ всех ролей персонала и право «Просмотр журнала аудита».

import { AuditLogEvent, Events, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { LEVEL, embed, ts } from '../util.js';

const NUKE_EVENTS = new Map([
  [AuditLogEvent.ChannelDelete, 'удаление канала'],
  [AuditLogEvent.ChannelCreate, 'создание канала'],
  [AuditLogEvent.RoleDelete, 'удаление роли'],
  [AuditLogEvent.MemberBanAdd, 'бан'],
  [AuditLogEvent.MemberKick, 'кик'],
  [AuditLogEvent.MemberPrune, 'чистка участников'],
  [AuditLogEvent.WebhookCreate, 'создание вебхука'],
  [AuditLogEvent.GuildUpdate, 'изменение сервера'],
]);

// Скользящее окно событий по ключу (тестируемо отдельно).
export class RateWindow {
  constructor(limit, seconds) {
    this.limit = limit;
    this.windowMs = seconds * 1000;
    this.hits = new Map();
  }

  hit(key, now = Date.now()) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list);
    return list.length >= this.limit;
  }

  reset(key) {
    this.hits.delete(key);
  }
}

export default {
  name: 'antiraid',
  commands: [
    new SlashCommandBuilder()
      .setName('raidmode')
      .setDescription('Режим рейда: кикать всех новых участников')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((o) => o.setName('state').setDescription('Включить или выключить').setRequired(true).addChoices({ name: 'вкл', value: 'on' }, { name: 'выкл', value: 'off' })),
  ],

  init(ctx) {
    const cfg = ctx.cfg.antiraid;
    const joins = new RateWindow(cfg.joins, cfg.seconds);
    const staffPing = () => ctx.cfg.roles.admin.map((r) => `<@&${r}>`).join(' ');

    ctx.setRaidMode = async (on, by) => {
      const until = on ? Date.now() + cfg.lockMinutes * 60_000 : 0;
      ctx.db.kv.set('raid.until', until);
      const e = on
        ? embed('bad', '🚨 Режим рейда включён', `Новые участники будут кикаться до ${ts(until)}.${by ? `\nВключил: ${by}` : ' Причина: волна входов.'}`)
        : embed('ok', '✅ Режим рейда выключен', by ? `Выключил: ${by}` : 'Время вышло.');
      await ctx.post('alerts', { content: on ? staffPing() : undefined, embeds: [e], allowedMentions: { roles: ctx.cfg.roles.admin } });
      ctx.post('modLog', { embeds: [e] });
    };
    const raidActive = () => ctx.db.kv.get('raid.until', 0) > Date.now();

    ctx.client.on(Events.GuildMemberAdd, async (member) => {
      if (member.guild.id !== ctx.cfg.guildId || member.user.bot) return;
      const ageDays = (Date.now() - member.user.createdTimestamp) / 86400e3;
      if (!raidActive() && joins.hit('guild')) await ctx.setRaidMode(true);

      if (raidActive()) {
        const reason = 'Режим рейда: вход временно закрыт';
        await member.send({ embeds: [embed('warn', 'Blackout', `${reason}. Попробуй зайти позже.`)] }).catch(() => {});
        if (cfg.action === 'ban') await member.ban({ reason }).catch(() => {});
        else await member.kick(reason).catch(() => {});
        ctx.post('joinLeave', { content: `🚫 ${member.user.tag} (<@${member.id}>) — ${reason}` });
        return;
      }
      if (ageDays < cfg.minAccountAgeDays) {
        ctx.audit('🕵️ Подозрительно новый аккаунт', { Участник: `<@${member.id}>`, 'Аккаунт создан': ts(member.user.createdTimestamp) }, 'warn');
      }
    });

    setInterval(() => {
      const until = ctx.db.kv.get('raid.until', 0);
      if (until && until <= Date.now()) ctx.setRaidMode(false).catch(() => {});
    }, 30_000);

    // ---------- Антинюк ----------
    const nuke = new RateWindow(ctx.cfg.antinuke.actions, ctx.cfg.antinuke.seconds);
    const handled = new Set();

    ctx.client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
      try {
        if (guild.id !== ctx.cfg.guildId || !NUKE_EVENTS.has(entry.action)) return;
        const executorId = entry.executorId;
        if (!executorId || executorId === ctx.client.user.id || executorId === guild.ownerId) return;
        if (ctx.cfg.antinuke.trusted.includes(executorId)) return;
        if (!nuke.hit(executorId) || handled.has(executorId)) return;

        handled.add(executorId);
        setTimeout(() => handled.delete(executorId), 60_000);
        nuke.reset(executorId);

        const member = await guild.members.fetch(executorId).catch(() => null);
        let result = 'не удалось ограничить — роль бота ниже';
        if (member?.user.bot && member.kickable) {
          await member.kick('Антинюк: массовые разрушительные действия');
          result = 'бот выгнан';
        } else if (member?.manageable) {
          await member.roles.set([], 'Антинюк: массовые разрушительные действия');
          if (member.moderatable) await member.timeout(60 * 60_000, 'Антинюк').catch(() => {});
          result = 'все роли сняты, мут на 1 час';
        }
        const e = embed('bad', '🚨 Антинюк сработал', `<@${executorId}> — массовое «${NUKE_EVENTS.get(entry.action)}».\nДействие: **${result}**.\nПроверь журнал аудита и верни роли вручную, если это ошибка.`);
        await ctx.post('alerts', { content: staffPing(), embeds: [e], allowedMentions: { roles: ctx.cfg.roles.admin } });
        ctx.post('modLog', { embeds: [e] });
      } catch (err) {
        ctx.log.error(`антинюк: ${err.message}`);
      }
    });
  },

  async onCommand(i, ctx) {
    ctx.require(i, LEVEL.admin);
    const on = i.options.getString('state') === 'on';
    await ctx.setRaidMode(on, `<@${i.user.id}>`);
    return i.reply({ embeds: [embed('ok', null, on ? 'Режим рейда включён' : 'Режим рейда выключен')], flags: MessageFlags.Ephemeral });
  },
};
