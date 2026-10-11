// Общий контекст и маршрутизация: команды и кнопки распределяются по модулям.
// Модуль: { name, commands?: SlashCommandBuilder[], init?(ctx), onCommand?(i, ctx),
//           onComponent?(i, ctx, args), onAutocomplete?(i, ctx) }
// customId кнопок/форм: "<модуль>:<действие>:<аргументы...>".

import { MessageFlags } from 'discord.js';
import { LEVEL_NAME, embed, staffLevel } from './util.js';

export class BotError extends Error {}

export function createContext({ client, cfg, db, agent, links, log }) {
  const ctx = {
    client,
    cfg,
    db,
    agent,
    links,
    log,
    guild: () => client.guilds.cache.get(cfg.guildId) ?? null,

    async channel(name) {
      const id = cfg.channels[name];
      if (!id) return null;
      try {
        return client.channels.cache.get(id) ?? (await client.channels.fetch(id));
      } catch {
        log.warn(`канал ${name} (${id}) недоступен`);
        return null;
      }
    },

    // Отправка в служебный канал; если канал не настроен — молча пропускаем.
    async post(name, payload) {
      const ch = await ctx.channel(name);
      if (!ch?.isTextBased()) return null;
      return ch.send({ allowedMentions: { parse: [] }, ...payload }).catch((e) => {
        log.warn(`не удалось отправить в ${name}: ${e.message}`);
        return null;
      });
    },

    level: (member) => staffLevel(member, cfg.roles),

    require(interaction, level) {
      if (ctx.level(interaction.member) < level) throw new BotError(`Нужны права: ${LEVEL_NAME[level]}`);
    },

    // Журнал действий персонала.
    audit(title, fields, color = 'info') {
      const e = embed(color, title);
      for (const [name, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null && value !== '') e.addFields({ name, value: String(value).slice(0, 1024), inline: String(value).length < 40 });
      }
      return ctx.post('modLog', { embeds: [e] });
    },
  };
  return ctx;
}

export async function replyError(interaction, message) {
  const payload = { embeds: [embed('bad', null, `❌ ${message}`)], flags: MessageFlags.Ephemeral };
  try {
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch {}
}

// Discord ждёт ответ 3 секунды. Если обработчик не успел за 2 (медленный прокси, вызовы агента,
// личные сообщения), бот сам откладывает ответ («думает…»), а reply/update дальше идут в отложенный ответ.
const AUTO_DEFER_MS = 1200;
export function autoDefer(i) {
  const isCommand = i.isChatInputCommand?.() || i.isContextMenuCommand?.();
  const isComponent = i.isMessageComponent?.() || i.isModalSubmit?.();
  if (!isCommand && !isComponent) return () => {};
  const canUpdate = isComponent && (i.isMessageComponent() || i.isFromMessage?.());
  const orig = { reply: i.reply.bind(i), update: i.update?.bind(i), deferReply: i.deferReply.bind(i), deferUpdate: i.deferUpdate?.bind(i) };
  const strip = (p) => {
    if (typeof p !== 'object' || p === null) return p;
    const rest = { ...p };
    delete rest.flags;
    delete rest.ephemeral;
    return rest;
  };
  let deferring = null;
  const timer = setTimeout(() => {
    if (i.replied || i.deferred) return;
    deferring = (canUpdate ? orig.deferUpdate() : orig.deferReply({ flags: MessageFlags.Ephemeral })).catch(() => {});
  }, AUTO_DEFER_MS);
  const settle = () => clearTimeout(timer);

  i.reply = async (p) => {
    if (!deferring) return settle(), orig.reply(p);
    await deferring;
    // После deferUpdate новый ответ — отдельным сообщением, чтобы не затереть панель с кнопками.
    return canUpdate ? i.followUp({ ...p, flags: MessageFlags.Ephemeral }) : i.editReply(strip(p));
  };
  if (orig.update) {
    i.update = async (p) => {
      if (!deferring) return settle(), orig.update(p);
      await deferring;
      return i.editReply(strip(p));
    };
  }
  i.deferReply = async (opts) => (deferring ? deferring : (settle(), orig.deferReply(opts)));
  if (orig.deferUpdate) i.deferUpdate = async () => (deferring ? deferring : (settle(), orig.deferUpdate()));
  const showModal = i.showModal?.bind(i);
  if (showModal) i.showModal = (m) => (settle(), showModal(m));
  return settle;
}

export function createRouter(modules, ctx) {
  const byCommand = new Map();
  const byPrefix = new Map();
  for (const m of modules) {
    byPrefix.set(m.name, m);
    for (const c of m.commands ?? []) byCommand.set(c.name, m);
  }

  return async function route(interaction) {
    const settle = autoDefer(interaction);
    try {
      if (interaction.isAutocomplete()) {
        await byCommand.get(interaction.commandName)?.onAutocomplete?.(interaction, ctx);
        return;
      }
      if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
        if (interaction.guildId !== ctx.cfg.guildId) throw new BotError('Команды работают только на сервере Blackout');
        const m = byCommand.get(interaction.commandName);
        if (m) await m.onCommand(interaction, ctx);
        return;
      }
      if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
        const [prefix, ...args] = interaction.customId.split(':');
        const m = byPrefix.get(prefix);
        if (m?.onComponent) await m.onComponent(interaction, ctx, args);
      }
    } catch (e) {
      if (e instanceof BotError) return replyError(interaction, e.message);
      if (e.code === 'agent_offline') return replyError(interaction, 'Агент сервера не в сети — управление сейчас недоступно');
      if (e.code && e.message && typeof e.code === 'string') return replyError(interaction, e.message);
      ctx.log.error(`interaction ${interaction.customId ?? interaction.commandName}: ${e.stack}`);
      return replyError(interaction, 'Внутренняя ошибка бота');
    } finally {
      settle();
    }
  };
}
