// Оповещения из админки сайта (ивентологи, новости): пост в канал Discord от имени бота.
// Права (кто может слать) проверяет сайт; здесь — только каналы, где бот сам может писать.

import { ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';

const ID_RE = /^\d{17,20}$/;
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);
const NEED = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks];

const cut = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\/\S+$/.test(v) ? v.slice(0, 2000) : null);

async function guildOf(ctx) {
  const guild = ctx.client?.guilds.cache.get(ctx.cfg.guildId) ?? (await ctx.client?.guilds.fetch(ctx.cfg.guildId).catch(() => null));
  if (!guild) throw Object.assign(new Error('Бот не в сети или не добавлен на Discord-сервер'), { code: 'discord' });
  return guild;
}

// Каналы, куда бот может писать, и роли для упоминания.
export async function listTargets(ctx) {
  const guild = await guildOf(ctx);
  const me = guild.members.me ?? (await guild.members.fetchMe());
  const channels = [...guild.channels.cache.values()]
    .filter((c) => TEXT_TYPES.has(c.type) && c.permissionsFor(me)?.has(NEED))
    .sort((a, b) => (a.parent?.rawPosition ?? -1) - (b.parent?.rawPosition ?? -1) || a.rawPosition - b.rawPosition)
    .map((c) => ({
      id: c.id,
      name: c.name,
      category: c.parent?.name ?? '',
      announcement: c.type === ChannelType.GuildAnnouncement,
      everyone: Boolean(c.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone)),
    }));
  const roles = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ id: r.id, name: r.name, color: r.hexColor }));
  return { channels, roles };
}

async function textChannel(ctx, channelId) {
  if (!ID_RE.test(channelId ?? '')) throw Object.assign(new Error('channelId'), { status: 400 });
  const guild = await guildOf(ctx);
  const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
  const me = guild.members.me ?? (await guild.members.fetchMe());
  if (!channel || !TEXT_TYPES.has(channel.type) || !channel.permissionsFor(me)?.has(NEED)) {
    throw Object.assign(new Error('Бот не может писать в этот канал'), { code: 'discord' });
  }
  return channel;
}

// body: { channelId, content, embed: { title, description, url, color, image, thumbnail, footer, fields: [{name, value}] },
//         mentionRoles: [id], mentionEveryone, publish, actor: { steamId, name } }
export function buildMessage(body) {
  const roles = (Array.isArray(body.mentionRoles) ? body.mentionRoles : []).filter((id) => ID_RE.test(id)).slice(0, 10);
  const everyone = body.mentionEveryone === true;
  const mentions = [everyone ? '@everyone' : '', ...roles.map((id) => `<@&${id}>`)].filter(Boolean).join(' ');
  const text = cut(body.content, 1800);
  const content = [mentions, text].filter(Boolean).join('\n');

  const embeds = [];
  const e = body.embed;
  if (e && (cut(e.title, 256) || cut(e.description, 4096))) {
    const embed = new EmbedBuilder();
    if (cut(e.title, 256)) embed.setTitle(cut(e.title, 256));
    if (cut(e.description, 4096)) embed.setDescription(cut(e.description, 4096));
    if (httpsUrl(e.url)) embed.setURL(httpsUrl(e.url));
    if (/^#[0-9a-f]{6}$/i.test(e.color ?? '')) embed.setColor(e.color);
    if (httpsUrl(e.image)) embed.setImage(httpsUrl(e.image));
    if (httpsUrl(e.thumbnail)) embed.setThumbnail(httpsUrl(e.thumbnail));
    if (cut(e.footer, 2048)) embed.setFooter({ text: cut(e.footer, 2048) });
    const fields = (Array.isArray(e.fields) ? e.fields : [])
      .map((f) => ({ name: cut(f?.name, 256), value: cut(f?.value, 1024), inline: f?.inline !== false }))
      .filter((f) => f.name && f.value)
      .slice(0, 10);
    if (fields.length) embed.addFields(fields);
    embeds.push(embed);
  }
  if (!content && !embeds.length) throw Object.assign(new Error('Пустое оповещение'), { status: 400 });
  return { content: content || undefined, embeds, allowedMentions: { parse: everyone ? ['everyone'] : [], roles } };
}

export async function sendAnnouncement(ctx, body) {
  const channel = await textChannel(ctx, body.channelId);
  const payload = buildMessage(body);
  const message = await channel.send(payload).catch((e) => {
    throw Object.assign(new Error(`Discord: ${e.message}`), { code: 'discord' });
  });
  // В канале объявлений можно сразу опубликовать на подписанные серверы.
  if (body.publish && channel.type === ChannelType.GuildAnnouncement) await message.crosspost().catch(() => {});
  const who = body.actor?.name ? `${body.actor.name} (${body.actor.steamId ?? '?'})` : 'сайт';
  ctx.log.info(`оповещение с сайта в #${channel.name} от ${who}`);
  ctx.audit?.('📣 Оповещение с сайта', { Канал: `<#${channel.id}>`, Автор: who, Сообщение: message.url });
  return { id: message.id, url: message.url, channelName: channel.name };
}

export async function deleteAnnouncement(ctx, body) {
  if (!ID_RE.test(body.messageId ?? '')) throw Object.assign(new Error('messageId'), { status: 400 });
  const channel = await textChannel(ctx, body.channelId);
  const message = await channel.messages.fetch(body.messageId).catch(() => null);
  if (message) await message.delete();
  return { ok: true, existed: Boolean(message) };
}
