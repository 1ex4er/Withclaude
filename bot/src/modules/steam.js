// Привязка Steam к Discord и управление вайтлистом.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { banFields, checkAll, hasBans } from '../bancheck.js';
import { BotError } from '../core.js';
import { resolveSteamInput } from '../steamid.js';
import { LEVEL, embed, ts } from '../util.js';

const profile = (steamId) => `https://steamcommunity.com/profiles/${steamId}`;
export const steamLabel = (link) =>
  link ? `[${link.steam_id}](${profile(link.steam_id)})${link.method === 'manual' ? ' · указан вручную, не подтверждён' : ' · подтверждён через Steam'}` : 'не привязан';

// Окно «впиши свой Steam» — используется и в верификации, и в /steam.
export function steamModal(customId) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Твой Steam')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('steam')
          .setLabel('Ссылка на профиль Steam или SteamID64')
          .setPlaceholder('https://steamcommunity.com/profiles/7656119…')
          .setStyle(TextInputStyle.Short)
          .setMinLength(2)
          .setMaxLength(120)
          .setRequired(true),
      ),
    );
}

// Привязка по введённому тексту. Возвращает { ok, steamId } или { ok: false, message }.
export async function linkManual(ctx, member, text) {
  const r = await resolveSteamInput(text);
  if (r.error) return { ok: false, message: r.error };
  const res = ctx.links.setManual(member.id, r.steamId);
  if (!res.ok) return res;
  // Роли, журнал, проверка банов — в фоне, чтобы ответить игроку быстро.
  ctx.emitLinked?.(member.id, r.steamId, res.previous, 'manual').catch((e) => ctx.log.warn(`после привязки: ${e.message}`));
  return { ok: true, steamId: r.steamId };
}

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
    ctx.emitLinked = async (discordId, steamId, previous, method = 'openid') => {
      const guild = ctx.guild();
      const member = await guild?.members.fetch(discordId).catch(() => null);
      if (!member) return;
      if (ctx.cfg.roles.steamLinked) await member.roles.add(ctx.cfg.roles.steamLinked, 'Steam привязан').catch(() => {});
      // Был в вайтлисте со старым Steam — переносим.
      if (ctx.cfg.roles.whitelisted && member.roles.cache.has(ctx.cfg.roles.whitelisted)) {
        if (previous && previous !== steamId) await ctx.whitelist.change('remove', previous);
        await ctx.whitelist.change('add', steamId, member.user.tag);
      }
      // Одна сводка: Discord-аккаунт, Steam, баны и активность.
      const results = ctx.cfg.banCheck.alertOnLink ? await checkAll(ctx.cfg, steamId).catch(() => []) : [];
      const banned = hasBans(results);
      const e = embed(banned ? 'bad' : 'info', banned ? '🚩 Привязан Steam — найдены баны' : '🔗 Привязан Steam')
        .setThumbnail(member.user.displayAvatarURL())
        .addFields(
          { name: 'Участник', value: `<@${discordId}>\n${member.user.tag}`, inline: true },
          { name: 'Discord создан', value: `${ts(member.user.createdTimestamp, 'D')}\n${ts(member.user.createdTimestamp)}`, inline: true },
          { name: 'На сервере с', value: member.joinedTimestamp ? ts(member.joinedTimestamp, 'D') : '—', inline: true },
          { name: 'Steam', value: `[${steamId}](${profile(steamId)})`, inline: true },
          { name: 'Способ', value: method === 'manual' ? 'вписан вручную\n(не подтверждён)' : 'вход через Steam', inline: true },
          { name: 'Предупреждения', value: String(ctx.db.prepare('SELECT COUNT(*) n FROM warns WHERE discord_id = ?').get(discordId).n), inline: true },
        )
        .addFields(ctx.cfg.banCheck.alertOnLink ? banFields(results) : []);
      ctx.post('modLog', { embeds: [e] });
      if (method !== 'manual') member.send({ embeds: [embed('ok', 'Steam привязан', `Аккаунт [${steamId}](${profile(steamId)}) привязан к Discord.`)] }).catch(() => {});
    };
  },

  async onComponent(i, ctx, [action]) {
    if (action === 'manual') return i.showModal(steamModal('steam:manualSubmit'));
    if (action === 'manualSubmit') {
      const r = await linkManual(ctx, i.member, i.fields.getTextInputValue('steam'));
      if (!r.ok) throw new BotError(r.message);
      return i.reply({ embeds: [embed('ok', null, `✅ Steam сохранён: [${r.steamId}](${profile(r.steamId)})`)], flags: MessageFlags.Ephemeral });
    }
  },

  async onCommand(i, ctx) {
    if (i.commandName === 'steam') {
      const link = ctx.links.get(i.user.id);
      const token = ctx.links.createToken(i.user.id);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('steam:manual').setLabel('Вписать SteamID').setEmoji('✏️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Войти через Steam').setURL(`${ctx.cfg.publicUrl}/link/steam/start?t=${token}`),
      );
      const text = link ? `Сейчас: ${steamLabel(link)}` : 'Steam не привязан.';
      return i.reply({
        embeds: [embed('info', 'Привязка Steam', `${text}\n\n**Вписать SteamID** — быстро, просто вставь ссылку на профиль.\n**Войти через Steam** — подтверждает, что аккаунт твой (пароль мы не видим).`)],
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
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
            { name: 'Steam', value: steamLabel(link), inline: true },
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
