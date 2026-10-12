// Живой статус сервера в канале + статус бота + оповещения о падениях/рестартах.

import { ActivityType, SlashCommandBuilder } from 'discord.js';
import { embed, formatDuration, ts } from '../util.js';

let cache = { at: 0, data: null };
let slots = { at: 0, value: null };

// Слоты — из maxPlayers в serverDZ.cfg (через агента, раз в 10 мин), иначе status.maxPlayers из config.json.
async function maxPlayers(ctx) {
  if (ctx.agent.online && Date.now() - slots.at > 10 * 60_000) {
    slots.at = Date.now();
    const cfg = await ctx.agent.call('files.read', { root: 'server', path: 'serverDZ.cfg' }, 'status').catch(() => null);
    const value = Number(/^\s*maxPlayers\s*=\s*(\d+)/m.exec(cfg?.content ?? '')?.[1]);
    if (value > 0) slots.value = value;
  }
  return slots.value ?? ctx.cfg.status.maxPlayers;
}

async function collect(ctx) {
  if (Date.now() - cache.at < 10_000 && cache.data) return cache.data;
  const data = { agent: ctx.agent.online, status: null, players: null };
  if (data.agent) {
    data.status = await ctx.agent.call('server.status', {}, 'status').catch(() => null);
    if (data.status?.running && data.status.rcon) {
      data.players = await ctx.agent.call('rcon.players', {}, 'status').catch(() => null);
    }
  }
  data.maxPlayers = await maxPlayers(ctx);
  cache = { at: Date.now(), data };
  return data;
}

function statusEmbed(ctx, { agent, status, players, maxPlayers }) {
  const { connect } = ctx.cfg.status;
  let e;
  if (!agent) {
    e = embed('warn', '🟠 Нет связи с сервером', 'Агент на VDS не в сети. Статус неизвестен.');
  } else if (!status?.running) {
    e = embed('bad', '🔴 Сервер выключен', status?.busy ? `Выполняется: ${status.busy}` : null);
  } else {
    const online = players ? players.filter((p) => !p.lobby).length : null;
    e = embed('ok', '🟢 Сервер работает');
    e.addFields(
      { name: 'Онлайн', value: online === null ? 'загрузка…' : `**${online}** / ${maxPlayers}`, inline: true },
      { name: 'Аптайм', value: status.startedAt ? formatDuration(Date.now() - status.startedAt) : '—', inline: true },
    );
  }
  if (status?.nextRestart) e.addFields({ name: 'Рестарт', value: ts(status.nextRestart), inline: true });
  e.addFields({ name: 'Подключение', value: `\`${connect}\``, inline: false });
  return e.setFooter({ text: 'BLACKOUT — S.T.A.L.K.E.R. Hard RP · обновляется автоматически' });
}

async function refresh(ctx) {
  const data = await collect(ctx);
  const online = data.status?.running && data.players ? data.players.filter((p) => !p.lobby).length : null;
  ctx.client.user.setPresence({
    activities: [
      {
        type: ActivityType.Watching,
        name: !data.agent ? 'нет связи с сервером' : !data.status?.running ? 'сервер выключен' : `${online ?? '?'}/${data.maxPlayers} в Зоне`,
      },
    ],
    status: data.status?.running ? 'online' : 'idle',
  });

  const ch = await ctx.channel('status');
  if (!ch?.isTextBased()) return;
  const payload = { embeds: [statusEmbed(ctx, data)] };
  const id = ctx.db.kv.get('status.message');
  const msg = id ? await ch.messages.fetch(id).catch(() => null) : null;
  if (msg) await msg.edit(payload);
  else ctx.db.kv.set('status.message', (await ch.send(payload)).id);
}

const ALERTS = {
  started: ['ok', '🟢 Сервер запущен'],
  stopped: ['warn', '⏹️ Сервер остановлен'],
  crashed: ['bad', '💥 Сервер упал', 'Агент перезапускает его автоматически.'],
  crash_loop: ['bad', '🚨 Сервер падает раз за разом', 'Автоподъём отключён. Нужна ручная проверка логов и запуск.'],
};

export default {
  name: 'status',
  commands: [new SlashCommandBuilder().setName('status').setDescription('Статус сервера Blackout')],

  async onCommand(i, ctx) {
    await i.reply({ embeds: [statusEmbed(ctx, await collect(ctx))] });
  },

  init(ctx) {
    const tick = () => refresh(ctx).catch((e) => ctx.log.warn(`статус: ${e.message}`));
    tick();
    setInterval(tick, ctx.cfg.status.intervalSec * 1000);

    ctx.agent.on('server', ({ what }) => {
      cache.at = 0;
      const a = ALERTS[what];
      if (a) ctx.post('alerts', { embeds: [embed(a[0], a[1], a[2])] });
      setTimeout(tick, 2000);
    });
    ctx.agent.on('online', () => {
      cache.at = 0;
      ctx.post('alerts', { embeds: [embed('ok', '🔌 Агент сервера на связи')] });
      tick();
    });
    ctx.agent.on('offline', () => {
      cache.at = 0;
      ctx.post('alerts', { embeds: [embed('warn', '🔌 Агент сервера отключился', 'Управление сервером из Discord временно недоступно.')] });
      tick();
    });
  },
};
