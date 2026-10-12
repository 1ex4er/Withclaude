// Внутренний API для сайта blackoutstalkerrp.ru (Bearer API_TOKEN проверяет http.js).
// Права админа проверяет сайт; сюда приходят только его запросы.
//   GET  /api/health                      — бот и агент в сети
//   GET  /api/profile?discordId=|steamId= — привязка, варны, наказания, анкеты, тикеты
//   POST /api/link      { discordId, steamId }        — привязка, подтверждённая сайтом (вход Steam + Discord OAuth)
//   GET  /api/whitelist                    — SteamID из whitelist.txt (нужен агент)
//   POST /api/whitelist { op, steamId, note }         — add | remove; без агента ждёт в очереди
//   GET  /api/mods/updates[?refresh=1]     — какие моды обновились в Workshop

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
        if (e.code) return bad(502, e.message);
        throw e;
      }
    },
  };
}
