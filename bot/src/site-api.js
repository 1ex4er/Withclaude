// Внутренний API для сайта blackoutstalkerrp.ru (Bearer API_TOKEN проверяет http.js).
// Права админа проверяет сайт; сюда приходят только его запросы.
//   GET  /api/health                      — бот и агент в сети
//   GET  /api/profile?discordId=|steamId= — привязка, варны, наказания, анкеты, тикеты
//   POST /api/link      { discordId, steamId }        — привязка, подтверждённая сайтом (вход Steam + Discord OAuth)
//   GET  /api/whitelist                    — SteamID из whitelist.txt (нужен агент)
//   POST /api/whitelist { op, steamId, note }         — add | remove; без агента ждёт в очереди
//   GET  /api/mods/updates[?refresh=1]     — какие моды обновились в Workshop
//   GET  /api/discord/targets              — каналы, куда бот может писать, и роли для упоминания
//   POST /api/discord/announce { channelId, content, embed, mentionRoles, mentionEveryone, publish, actor }
//   POST /api/discord/delete   { channelId, messageId } — удалить отправленное оповещение
//   GET  /api/settings                     — все настройки бота (описание + значения), роли и каналы Discord
//   POST /api/settings { values, reset, actor } — сохранить (bot-settings.js)
//   POST /api/bot/backup                   — бэкап bot.db сейчас
//   POST /api/bot/restart                  — перезапуск бота (systemd поднимет заново)

import { deleteAnnouncement, listTargets, sendAnnouncement } from './announce.js';
import { makeBackup } from './backup.js';
import { describeSettings, updateSettings } from './bot-settings.js';
import { checkModUpdates } from './modules/modupdates.js';

const STEAM_RE = /^\d{17}$/;
const DISCORD_RE = /^\d{17,20}$/;

const ok = (body) => ({ status: 200, body });
const bad = (status, error) => ({ status, body: { error } });

export function createSiteApi(ctx) {
  const { db, links } = ctx;
  const q = {
    warns: db.prepare('SELECT id, mod_id, reason, created_at FROM warns WHERE discord_id = ? ORDER BY id DESC LIMIT 50'),
    punishments: db.prepare(
      'SELECT id, type, mod_id, reason, created_at, expires_at, removed_at, removed_by FROM punishments WHERE discord_id = ? ORDER BY id DESC LIMIT 50',
    ),
    applications: db.prepare(
      'SELECT id, status, reviewer_id, reason, created_at, decided_at FROM applications WHERE discord_id = ? ORDER BY id DESC LIMIT 20',
    ),
    tickets: db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status = 'open'), 0) AS open FROM tickets WHERE discord_id = ?"),
  };

  const routes = {
    'GET /api/health': () => ok({ bot: ctx.client?.isReady?.() ?? false, agent: ctx.agent.online }),

    'GET /api/profile': (url) => {
      const discordId = url.searchParams.get('discordId');
      const steamId = url.searchParams.get('steamId');
      if (discordId && !DISCORD_RE.test(discordId)) return bad(400, 'discordId');
      if (steamId && !STEAM_RE.test(steamId)) return bad(400, 'steamId');
      const link = links.find({ discordId, steamId });
      const id = discordId ?? link?.discord_id;
      if (!id) return ok({ link: null, warns: [], punishments: [], applications: [], tickets: { total: 0, open: 0 } });
      const t = q.tickets.get(id);
      return ok({
        discordId: id,
        link,
        warns: q.warns.all(id),
        punishments: q.punishments.all(id),
        applications: q.applications.all(id),
        tickets: { total: Number(t.total), open: Number(t.open) },
      });
    },

    'POST /api/link': async (_url, body) => {
      const { discordId, steamId } = body;
      if (!DISCORD_RE.test(discordId ?? '') || !STEAM_RE.test(steamId ?? '')) return bad(400, 'discordId/steamId');
      const r = links.setVerified(discordId, steamId);
      if (!r.ok) return bad(409, r.message);
      if (r.changed) {
        ctx.emitLinked?.(discordId, steamId, r.previous, 'site').catch((e) => ctx.log.warn(`после привязки с сайта: ${e.message}`));
      }
      return ok({ ok: true, changed: r.changed, previous: r.previous });
    },

    // Последняя проверка обновлений модов (modules/modupdates.js); ?refresh=1 — проверить сейчас.
    'GET /api/mods/updates': async (url) => {
      if (url.searchParams.get('refresh') === '1') await checkModUpdates(ctx);
      return ok(ctx.db.kv.get('mods.updates', null));
    },

    'GET /api/whitelist': async () => ok({ ids: await ctx.whitelist.list() }),

    'POST /api/whitelist': async (_url, body) => {
      const { op, steamId, note } = body;
      if (op !== 'add' && op !== 'remove') return bad(400, 'op');
      if (!STEAM_RE.test(steamId ?? '')) return bad(400, 'steamId');
      const applied = await ctx.whitelist.change(op, steamId, typeof note === 'string' ? note : undefined);
      return ok({ ok: true, applied });
    },

    // Оповещения ивентологов и новостей (bot/src/announce.js).
    'GET /api/discord/targets': async () => ok(await listTargets(ctx)),
    'POST /api/discord/announce': async (_url, body) => ok(await sendAnnouncement(ctx, body)),
    'POST /api/discord/delete': async (_url, body) => ok(await deleteAnnouncement(ctx, body)),

    // Вкладка «Бот» в админке сайта.
    'GET /api/settings': async () => ok(await describeSettings(ctx)),
    'POST /api/settings': async (_url, body) => ok(await updateSettings(ctx, body)),
    'POST /api/bot/backup': () => ok(makeBackup(ctx.db, ctx.cfg.backup.dir, ctx.cfg.backup.keep)),
    'POST /api/bot/restart': (_url, body) => {
      ctx.log.info(`перезапуск с сайта (${typeof body.actor?.name === 'string' ? body.actor.name : 'сайт'})`);
      // Ответ успевает уйти; SIGTERM — обычная остановка, systemd (Restart=always) поднимет бота заново.
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500);
      return ok({ ok: true });
    },
  };

  return {
    // null — маршрут не наш, http.js ответит 404.
    async handle(method, url, readBody) {
      const route = routes[`${method} ${url.pathname}`];
      if (!route) return null;
      try {
        return await route(url, method === 'POST' ? await readBody() : {});
      } catch (e) {
        if (e.code === 'agent_offline') return bad(503, 'Агент сервера не в сети');
        if (e.status) return bad(e.status, e.message);
        if (e.code) return bad(502, e.message);
        throw e;
      }
    },
  };
}
