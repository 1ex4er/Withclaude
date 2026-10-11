// /profile — карточка игрока для персонала: всё о человеке в одном месте.

import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { banFields, checkAll, hasBans } from '../bancheck.js';
import { LEVEL, clip, embed, ts } from '../util.js';
import { punishmentLine } from './punishments.js';
import { steamLabel } from './steam.js';

const STATUS = { pending: '⏳ на рассмотрении', accepted: '✅ принята', rejected: '❌ отклонена' };

export default {
  name: 'profile',
  commands: [
    new SlashCommandBuilder()
      .setName('profile')
      .setDescription('Карточка игрока: Discord, Steam, наказания, анкеты, тикеты')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addUserOption((o) => o.setName('user').setDescription('Игрок').setRequired(true)),
  ],

  async onCommand(i, ctx) {
    ctx.require(i, LEVEL.support);
    const user = i.options.getUser('user');
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const member = i.options.getMember('user') ?? (await i.guild.members.fetch(user.id).catch(() => null));
    const db = ctx.db;
    const link = ctx.links.get(user.id);

    const warns = db.prepare('SELECT * FROM warns WHERE discord_id = ? ORDER BY id DESC').all(user.id);
    const punish = db.prepare('SELECT * FROM punishments WHERE discord_id = ? ORDER BY id DESC').all(user.id);
    const apps = db.prepare('SELECT * FROM applications WHERE discord_id = ? ORDER BY id DESC').all(user.id);
    const tickets = db.prepare('SELECT COUNT(*) n, SUM(status = \'open\') open FROM tickets WHERE discord_id = ?').get(user.id);
    const activePunish = punish.filter((p) => !p.removed_at);

    const roles = member
      ? [...member.roles.cache.values()].filter((r) => r.id !== i.guild.id).sort((a, b) => b.position - a.position).slice(0, 12).map((r) => `<@&${r.id}>`).join(' ')
      : '—';

    const main = embed(activePunish.length ? 'warn' : 'info', `Карточка: ${user.tag}`)
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { name: 'Discord', value: `<@${user.id}>\n\`${user.id}\``, inline: true },
        { name: 'Аккаунт создан', value: `${ts(user.createdTimestamp, 'D')}\n${ts(user.createdTimestamp)}`, inline: true },
        { name: 'На сервере', value: member?.joinedTimestamp ? `с ${ts(member.joinedTimestamp, 'D')}` : '❌ не на сервере', inline: true },
        { name: 'Steam', value: steamLabel(link) },
        { name: 'Роли', value: clip(roles || '—', 1024) },
        {
          name: `⚠️ Предупреждения: ${warns.length}`,
          value: warns.length ? warns.slice(0, 3).map((w) => `\`#${w.id}\` ${ts(w.created_at, 'd')} <@${w.mod_id}>: ${clip(w.reason, 100)}`).join('\n') : 'нет',
        },
        {
          name: `⚖️ Наказания: ${punish.length} (активных ${activePunish.length})`,
          value: clip(punish.length ? punish.slice(0, 4).map(punishmentLine).join('\n') : 'нет', 1024),
        },
        {
          name: `📝 Анкеты: ${apps.length}`,
          value: apps.length
            ? apps.slice(0, 3).map((a) => `\`#${a.id}\` ${ts(a.created_at, 'd')} ${STATUS[a.status] ?? a.status}${a.reviewer_id ? ` <@${a.reviewer_id}>` : ''}${a.reason ? `: ${clip(a.reason, 80)}` : ''}`).join('\n')
            : 'нет',
        },
        { name: '🎫 Тикеты', value: `всего ${tickets.n ?? 0}, открыто ${tickets.open ?? 0}`, inline: true },
      );

    const embeds = [main];
    if (link) {
      const results = await checkAll(ctx.cfg, link.steam_id).catch(() => []);
      embeds.push(embed(hasBans(results) ? 'bad' : 'ok', hasBans(results) ? '🚩 Найдены баны' : 'Проверка Steam').addFields(banFields(results)));
    }
    return i.editReply({ embeds });
  },
};
