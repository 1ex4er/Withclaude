// Панель ролей по кнопкам (уведомления, интересы и т.п.): нажал — роль выдана, нажал ещё раз — снята.
// Список ролей — selfRoles в config.json: [{ "id": "…", "label": "Новости", "emoji": "📰" }].

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { BotError } from '../core.js';
import { embed } from '../util.js';

export function rolesPanel(ctx) {
  const roles = ctx.cfg.selfRoles ?? [];
  if (!roles.length) throw new BotError('В config.json не задан selfRoles');
  const rows = [];
  for (let n = 0; n < roles.length && rows.length < 5; n += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(
        roles.slice(n, n + 5).map((r) => {
          const b = new ButtonBuilder().setCustomId(`roles:toggle:${r.id}`).setLabel(r.label).setStyle(ButtonStyle.Secondary);
          return r.emoji ? b.setEmoji(r.emoji) : b;
        }),
      ),
    );
  }
  return { embeds: [embed('info', '🎭 Роли', 'Нажми, чтобы получить или снять роль.')], components: rows };
}

export default {
  name: 'roles',

  async onComponent(i, ctx, [action, roleId]) {
    if (action !== 'toggle') return;
    // Выдаём только роли из списка — customId можно подделать.
    const role = (ctx.cfg.selfRoles ?? []).find((r) => r.id === roleId);
    if (!role) throw new BotError('Эта роль больше не выдаётся');
    // Защита от ошибки в конфиге: роли с правами модерации самовыдачей не раздаются.
    const guildRole = i.guild.roles.cache.get(roleId);
    const P = PermissionFlagsBits;
    if (!guildRole || guildRole.permissions.any([P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ManageMessages, P.ModerateMembers, P.MentionEveryone, P.ManageWebhooks])) {
      throw new BotError('Эту роль нельзя выдать через панель');
    }
    const has = i.member.roles.cache.has(roleId);
    if (has) await i.member.roles.remove(roleId, 'Панель ролей');
    else await i.member.roles.add(roleId, 'Панель ролей');
    return i.reply({ embeds: [embed('ok', null, `${has ? 'Снята' : 'Выдана'} роль <@&${roleId}>`)], flags: MessageFlags.Ephemeral });
  },
};
