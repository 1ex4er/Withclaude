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

    async channelById(id, name = id) {
      if (!id) return null;
      try {
        return client.channels.cache.get(id) ?? (await client.channels.fetch(id));
      } catch {
        log.warn(`канал ${name} (${id}) недоступен`);
        return null;
      }
    },

    channel: (name) => ctx.channelById(cfg.channels[name], name),

    async postTo(id, payload, name = id) {
      const ch = await ctx.channelById(id, name);
      if (!ch?.isTextBased()) return null;
      return ch.send({ allowedMentions: { parse: [] }, ...payload }).catch((e) => {
        log.warn(`не удалось отправить в ${name}: ${e.message}`);
        return null;
      });
    },

    // Отправка в служебный канал; если канал не настроен — молча пропускаем.
    post: (name, payload) => ctx.postTo(cfg.channels[name], payload, name),

    // Настройки сервера группировки (guilds.<id> в конфиге); null — сервер не подключён в tickets.factionGuilds.
    faction: (guildId) => ((cfg.tickets.factionGuilds ?? []).includes(guildId) && guildId !== cfg.guildId ? (cfg.guilds[guildId] ?? {}) : null),

    // Каналы с таким назначением: основной сервер + серверы группировок, где этот канал выбран.
    targets(name) {
      const ids = [cfg.channels[name]];
      for (const g of cfg.tickets.factionGuilds ?? []) ids.push(ctx.faction(g)?.channels?.[name]);
      return [...new Set(ids.filter(Boolean))];
    },

    // То же, что post, но во все каналы этого назначения.
    postAll: (name, payload) => Promise.all(ctx.targets(name).map((id) => ctx.postTo(id, payload, name))),

    level: (member) => staffLevel(member, cfg.roles),

    require(interaction, level) {
      if (ctx.level(interaction.member) < level) throw new BotError(`Нужны права: ${LEVEL_NAME[level]}`);
    },

    // Журнал действий персонала; channelId — другой канал вместо лога модерации (серверы группировок).
    audit(title, fields, color = 'info', channelId = null) {
      const e = embed(color, title);
      for (const [name, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null && value !== '') e.addFields({ name, value: String(value).slice(0, 1024), inline: String(value).length < 40 });
      }
      return channelId ? ctx.postTo(channelId, { embeds: [e] }, 'modLog') : ctx.post('modLog', { embeds: [e] });
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

// Discord ждёт ответ 3 секунды. Если обработчик не ответил за AUTO_DEFER_MS (медленный прокси, вызовы
// агента, роли, личные сообщения), бот сам подтверждает взаимодействие («думает…»), а reply/update дальше
// идут в отложенный ответ. То же, если обработчик сам вызвал deferUpdate/deferReply.
const AUTO_DEFER_MS = 600;
export function autoDefer(i, log) {
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
  let kind = null; // 'update' | 'reply'
  const defer = (k, opts) => {
    if (deferring) return deferring;
    clearTimeout(timer);
    kind = k;
    const t0 = Date.now();
    deferring = (k === 'update' ? orig.deferUpdate() : orig.deferReply(opts ?? { flags: MessageFlags.Ephemeral }))
      .then(() => {
        const ms = Date.now() - t0;
        if (ms > 1500) log?.warn(`подтверждение взаимодействия заняло ${ms} мс — медленная связь с Discord`);
      })
      .catch((e) => log?.warn(`не удалось подтвердить взаимодействие: ${e.code ?? ''} ${e.message}`));
    return deferring;
  };
  const timer = setTimeout(() => {
    if (!i.replied && !i.deferred) defer(canUpdate ? 'update' : 'reply');
  }, AUTO_DEFER_MS);
  const settle = () => clearTimeout(timer);

  i.reply = async (p) => {
    if (!deferring) return settle(), orig.reply(p);
    await deferring;
    // После deferUpdate новый ответ — отдельным сообщением, чтобы не затереть панель с кнопками.
    return kind === 'update' ? i.followUp({ ...p, flags: MessageFlags.Ephemeral }) : i.editReply(strip(p));
  };
  if (orig.update) {
    i.update = async (p) => {
      if (!deferring) return settle(), orig.update(p);
      await deferring;
      return i.editReply(strip(p));
    };
  }
  i.deferReply = (opts) => defer('reply', opts);
  if (orig.deferUpdate) i.deferUpdate = () => defer('update');
  const showModal = i.showModal?.bind(i);
  if (showModal) i.showModal = (m) => (settle(), showModal(m));
  return settle;
}

export function createRouter(modules, ctx) {
  const byCommand = new Map();
  const byPrefix = new Map();
  const byFactionCommand = new Map(); // команды для серверов группировок
  for (const m of modules) {
    byPrefix.set(m.name, m);
    for (const c of m.commands ?? []) byCommand.set(c.name, m);
    for (const c of m.factionCommands ?? []) byFactionCommand.set(c.name, m);
  }

  return async function route(interaction) {
    // Диагностика: насколько поздно событие дошло до бота (если больше ~2.5 с — Discord уже не примет ответ).
    const lag = Date.now() - interaction.createdTimestamp;
    if (lag > 1500) ctx.log.warn(`взаимодействие ${interaction.commandName ?? interaction.customId} дошло с опозданием ${lag} мс (ping ${ctx.client.ws.ping} мс)`);
    const settle = autoDefer(interaction, ctx.log);
    try {
      if (interaction.isAutocomplete()) {
        await byCommand.get(interaction.commandName)?.onAutocomplete?.(interaction, ctx);
        return;
      }
      if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
        let m;
        if (interaction.guildId === ctx.cfg.guildId) m = byCommand.get(interaction.commandName);
        else if (ctx.cfg.tickets.factionGuilds?.includes(interaction.guildId)) m = byFactionCommand.get(interaction.commandName);
        else throw new BotError('Команды работают только на сервере Blackout');
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
      ctx.log.error(`interaction ${interaction.customId ?? interaction.commandName} (опоздание ${lag} мс): ${e.code ?? ''} ${e.message}`);
      return replyError(interaction, 'Внутренняя ошибка бота');
    } finally {
      settle();
    }
  };
}
