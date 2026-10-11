// Привязка Steam к Discord и управление вайтлистом.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { banFields, checkAll, hasBans } from '../bancheck.js';
import { BotError } from '../core.js';
import { LEVEL, embed } from '../util.js';

const profile = (steamId) => `https://steamcommunity.com/profiles/${steamId}`;

const steamCmd = new SlashCommandBuilder().setName('steam').setDescription('Привязать свой Steam-аккаунт');

const checkCmd = new SlashCommandBuilder()
  .setName('check')
  .setDescription('Проверить игрока по базам банов (Steam, HunterEye и др.)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addUserOption((o) => o.setName('user').setDescription('Участник Discord (с привязанным Steam)'))
  .addStringOption((o) => o.setName('steamid').setDescription('Или SteamID64').setMinLength(17).setMaxLength(17));

const whitelistCmd = new SlashCommandBuilder()
  .setName('whitelist')
  .setDescription('Вайтлист сервера')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Добавить участника в вайтлист')
      .addUserOption((o) => o.setName('user').setDescription('Участник').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Убрать участника из вайтлиста')
      .addUserOption((o) => o.setName('user').setDescription('Участник').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('info')
      .setDescription('Steam и статус участника')
      .addUserOption((o) => o.setName('user').setDescription('Участник').setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName('unlink')
      .setDescription('Отвязать Steam у участника')
      .addUserOption((o) => o.setName('user').setDescription('Участник').setRequired(true)),
  );

export async function addToWhitelist(ctx, member, by) {
  const link = ctx.links.get(member.id);
  if (!link) throw new BotError('У участника не привязан Steam (/steam)');
  const applied = await ctx.whitelist.change('add', link.steam_id, member.user.tag);
  if (ctx.cfg.roles.whitelisted) await member.roles.add(ctx.cfg.roles.whitelisted, `Вайтлист: ${by}`).catch(() => {});
  return applied;
}

export async function removeFromWhitelist(ctx, member, by) {
  const link = ctx.links.get(member.id);
  const applied = link ? await ctx.whitelist.change('remove', link.steam_id) : true;
  if (ctx.cfg.roles.whitelisted) await member.roles.remove(ctx.cfg.roles.whitelisted, `Вайтлист: ${by}`).catch(() => {});
  return applied;
}

const queuedNote = (applied) => (applied ? '' : '\n⏳ Агент сервера не в сети — изменение применится при подключении.');

export default {
  name: 'steam',
  commands: [steamCmd, checkCmd, whitelistCmd],

  init(ctx) {
    // Вызывается HTTP-частью после успешного входа через Steam.
    ctx.emitLinked = async (discordId, steamId, previous) => {
      const guild = ctx.guild();
      const member = await guild?.members.fetch(discordId).catch(() => null);
      if (!member) return;
      if (ctx.cfg.roles.steamLinked) await member.roles.add(ctx.cfg.roles.steamLinked, 'Steam привязан').catch(() => {});
      // Был в вайтлисте со старым Steam — переносим.
      if (ctx.cfg.roles.whitelisted && member.roles.cache.has(ctx.cfg.roles.whitelisted)) {
        if (previous && previous !== steamId) await ctx.whitelist.change('remove', previous);
        await ctx.whitelist.change('add', steamId, member.user.tag);
      }
      ctx.audit('🔗 Привязан Steam', { Участник: `<@${discordId}>`, Steam: `[${steamId}](${profile(steamId)})` });
      if (ctx.cfg.banCheck.alertOnLink) {
        const results = await checkAll(ctx.cfg, steamId);
        if (hasBans(results)) {
          const e = embed('bad', '🚩 У игрока найдены баны', `<@${discordId}> · [${steamId}](${profile(steamId)})`).addFields(banFields(results));
          ctx.post('modLog', { embeds: [e] });
        }
      }
      member.send({ embeds: [embed('ok', 'Steam привязан', `Аккаунт [${steamId}](${profile(steamId)}) привязан к Discord.`)] }).catch(() => {});
    };
  },

  async onCommand(i, ctx) {
    if (i.commandName === 'steam') {
      const link = ctx.links.get(i.user.id);
      const token = ctx.links.createToken(i.user.id);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(link ? 'Привязать другой Steam' : 'Войти через Steam').setURL(`${ctx.cfg.publicUrl}/link/steam/start?t=${token}`),
      );
      const text = link
        ? `Сейчас привязан: [${link.steam_id}](${profile(link.steam_id)})`
        : 'Нажми кнопку и войди через Steam на официальном сайте Steam. Пароль мы не видим.';
      return i.reply({ embeds: [embed('info', 'Привязка Steam', `${text}\nСсылка действует 15 минут.`)], components: [row], flags: MessageFlags.Ephemeral });
    }

    ctx.require(i, LEVEL.moderator);

    if (i.commandName === 'check') {
      const u = i.options.getUser('user');
      let steamId = i.options.getString('steamid');
      if (u) steamId = ctx.links.get(u.id)?.steam_id;
      if (!steamId || !/^\d{17}$/.test(steamId)) throw new BotError(u ? 'У участника не привязан Steam' : 'Укажи участника или SteamID64');
      await i.deferReply({ flags: MessageFlags.Ephemeral });
      const results = await checkAll(ctx.cfg, steamId);
      const owner = ctx.links.bySteam(steamId);
      const e = embed(hasBans(results) ? 'bad' : 'ok', `Проверка ${steamId}`, `[Профиль Steam](${profile(steamId)})${owner ? ` · <@${owner.discord_id}>` : ''}`).addFields(banFields(results));
      return i.editReply({ embeds: [e] });
    }

    const sub = i.options.getSubcommand();
    const user = i.options.getUser('user');
    const member = await i.guild.members.fetch(user.id).catch(() => null);
    const link = ctx.links.get(user.id);

    if (sub === 'info') {
      const wl = ctx.cfg.roles.whitelisted && member?.roles.cache.has(ctx.cfg.roles.whitelisted);
      return i.reply({
        embeds: [
          embed('info', user.tag).addFields(
            { name: 'Steam', value: link ? `[${link.steam_id}](${profile(link.steam_id)})` : 'не привязан', inline: true },
            { name: 'Вайтлист', value: wl ? 'да' : 'нет', inline: true },
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!member) throw new BotError('Участник не на сервере');
    await i.deferReply({ flags: MessageFlags.Ephemeral });

    if (sub === 'add') {
      const applied = await addToWhitelist(ctx, member, i.user.tag);
      ctx.audit('✅ Добавлен в вайтлист', { Участник: `<@${user.id}>`, Кто: `<@${i.user.id}>` }, 'ok');
      return i.editReply({ embeds: [embed('ok', null, `${user} добавлен в вайтлист${queuedNote(applied)}`)] });
    }
    if (sub === 'remove') {
      const applied = await removeFromWhitelist(ctx, member, i.user.tag);
      ctx.audit('⛔ Убран из вайтлиста', { Участник: `<@${user.id}>`, Кто: `<@${i.user.id}>` }, 'warn');
      return i.editReply({ embeds: [embed('ok', null, `${user} убран из вайтлиста${queuedNote(applied)}`)] });
    }
    if (sub === 'unlink') {
      ctx.require(i, LEVEL.admin);
      await removeFromWhitelist(ctx, member, i.user.tag);
      ctx.links.unlink(user.id);
      if (ctx.cfg.roles.steamLinked) await member.roles.remove(ctx.cfg.roles.steamLinked).catch(() => {});
      ctx.audit('🔗 Steam отвязан', { Участник: `<@${user.id}>`, Кто: `<@${i.user.id}>`, Steam: link?.steam_id }, 'warn');
      return i.editReply({ embeds: [embed('ok', null, `Steam у ${user} отвязан, из вайтлиста убран`)] });
    }
  },
};
