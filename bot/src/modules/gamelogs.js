// Игровые логи в каналы: входы/выходы, убийства, игровой чат. Источник — ADM-лог через агента.
// Сообщения копятся и отправляются пачками раз в 2 с, чтобы не упираться в лимиты Discord.

import { newestAdm, parseAdmLine } from '../adm.js';
import { escapeMd } from '../util.js';

const FLUSH_MS = 2000;

function format(ev) {
  const n = (s) => `**${escapeMd(s)}**`;
  switch (ev.type) {
    case 'connect':
      return ['joinLeave', `\`${ev.time}\` 🟢 ${n(ev.name)} зашёл`];
    case 'disconnect':
      return ['joinLeave', `\`${ev.time}\` 🔴 ${n(ev.name)} вышел`];
    case 'pvp': {
      const extra = [ev.weapon && escapeMd(ev.weapon), ev.distance !== null && `${Math.round(ev.distance)} м`].filter(Boolean).join(', ');
      return ['killFeed', `\`${ev.time}\` ☠️ ${n(ev.killer)} убил ${n(ev.victim)}${extra ? ` (${extra})` : ''}`];
    }
    case 'death':
      return ['killFeed', `\`${ev.time}\` 💀 ${n(ev.name)} погиб${ev.cause ? ` (${escapeMd(ev.cause)})` : ''}`];
    case 'chat':
      return ['gameChat', `\`${ev.time}\` 💬 ${n(ev.name)}: ${escapeMd(ev.text)}`];
    default:
      return [null, null];
  }
}

export default {
  name: 'gamelogs',

  init(ctx) {
    if (!ctx.cfg.logs.admFollow) return;
    const queues = new Map(); // канал -> строки
    let following = null;

    const flush = async () => {
      for (const [channel, lines] of queues) {
        queues.delete(channel);
        let chunk = '';
        for (const line of lines) {
          if (chunk.length + line.length + 1 > 1900) {
            await ctx.post(channel, { content: chunk });
            chunk = '';
          }
          chunk += (chunk ? '\n' : '') + line;
        }
        if (chunk) await ctx.post(channel, { content: chunk });
      }
    };
    setInterval(() => flush().catch((e) => ctx.log.warn(`логи: ${e.message}`)), FLUSH_MS);

    ctx.agent.on('log', ({ file, lines }) => {
      if (file !== following) return;
      for (const line of lines) {
        const ev = parseAdmLine(line);
        if (!ev) continue;
        const [channel, text] = format(ev);
        if (!channel || !ctx.cfg.channels[channel]) continue;
        if (!queues.has(channel)) queues.set(channel, []);
        queues.get(channel).push(text);
      }
    });

    // После каждого рестарта сервер начинает новый ADM-файл — переключаемся на него.
    const sync = async () => {
      if (!ctx.agent.online) return;
      const file = newestAdm(await ctx.agent.call('logs.list', {}, 'gamelogs'));
      if (!file || file === following) return;
      if (following) await ctx.agent.call('logs.unfollow', { file: following }, 'gamelogs').catch(() => {});
      await ctx.agent.call('logs.follow', { file }, 'gamelogs');
      following = file;
      ctx.log.info(`слежу за ${file}`);
    };
    const safeSync = () => sync().catch((e) => ctx.log.warn(`ADM: ${e.message}`));
    ctx.agent.on('online', () => {
      following = null; // после переподключения агент забывает подписки
      safeSync();
    });
    ctx.agent.on('server', () => setTimeout(safeSync, 30_000));
    setInterval(safeSync, 60_000);
    safeSync();
  },
};
