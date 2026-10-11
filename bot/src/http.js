// HTTP-часть службы (за nginx сайта):
//   /agent-ws                 — подключение агента с VDS (WebSocket)
//   /link/steam/start?t=…     — начало привязки Steam (ссылку выдаёт бот в Discord)
//   /link/steam/callback?t=…  — возврат из Steam
//   /api/…                    — внутренний API для админки сайта (Bearer API_TOKEN)

import crypto from 'node:crypto';
import http from 'node:http';
import { steamLoginUrl, verifySteamCallback } from './steam.js';

const page = (title, text, ok = true) => `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f10;color:#e6e6e6;font:16px system-ui,sans-serif}
main{max-width:420px;padding:32px;border:1px solid #2a2c2e;border-radius:12px;background:#151719;text-align:center}
h1{font-size:20px;color:${ok ? '#7bd88f' : '#ff6b6b'}}</style></head>
<body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

function send(res, status, body, type = 'text/html; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
  res.end(body);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

async function readJson(req, limit = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function createHttpServer({ cfg, links, agent, log, onLinked }) {
  const callbackBase = `${cfg.publicUrl}/link/steam/callback`;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, cfg.publicUrl);

      if (req.method === 'GET' && url.pathname === '/link/steam/start') {
        const t = url.searchParams.get('t') ?? '';
        if (!links.peekToken(t)) return send(res, 400, page('Ссылка устарела', 'Запроси новую командой /steam в Discord.', false));
        const returnTo = `${callbackBase}?t=${encodeURIComponent(t)}`;
        return send(res, 302, '', 'text/plain', { location: steamLoginUrl({ returnTo, realm: cfg.publicUrl }) });
      }

      if (req.method === 'GET' && url.pathname === '/link/steam/callback') {
        const t = url.searchParams.get('t') ?? '';
        const discordId = links.peekToken(t);
        if (!discordId) return send(res, 400, page('Ссылка устарела', 'Запроси новую командой /steam в Discord.', false));
        const steamId = await verifySteamCallback(url.searchParams, { expectedReturnTo: `${callbackBase}?t=${encodeURIComponent(t)}` });
        if (!steamId) return send(res, 400, page('Не получилось', 'Steam не подтвердил вход. Попробуй ещё раз.', false));
        const result = links.complete(t, steamId);
        if (!result.ok) return send(res, 409, page('Не получилось', result.message, false));
        onLinked?.(discordId, steamId, result.previous).catch((e) => log.error(`после привязки: ${e.message}`));
        return send(res, 200, page('Steam привязан', 'Можно закрыть страницу и вернуться в Discord.'));
      }

      if (url.pathname.startsWith('/api/')) {
        if (!cfg.secrets.apiToken) return send(res, 404, 'not found', 'text/plain');
        const auth = req.headers.authorization ?? '';
        if (!safeEqual(auth, `Bearer ${cfg.secrets.apiToken}`)) return send(res, 401, '{"error":"unauthorized"}', 'application/json');

        // Админка сайта вызывает агента через бота. Права админа проверяет сайт, actor уходит в журнал агента.
        if (req.method === 'POST' && url.pathname === '/api/agent/call') {
          const { action, params, actor } = await readJson(req);
          if (typeof action !== 'string') return send(res, 400, '{"error":"action"}', 'application/json');
          try {
            const result = await agent.call(action, params ?? {}, actor ?? 'site');
            return send(res, 200, JSON.stringify({ ok: true, result }), 'application/json');
          } catch (e) {
            return send(res, 200, JSON.stringify({ ok: false, error: { code: e.code ?? 'error', message: e.message } }), 'application/json');
          }
        }
        if (req.method === 'GET' && url.pathname === '/api/links') {
          const id = url.searchParams.get('discordId');
          const steam = url.searchParams.get('steamId');
          return send(res, 200, JSON.stringify(links.find({ discordId: id, steamId: steam })), 'application/json');
        }
        return send(res, 404, '{"error":"not found"}', 'application/json');
      }

      send(res, 404, 'not found', 'text/plain');
    } catch (e) {
      log.error(`http: ${e.stack}`);
      if (!res.headersSent) send(res, e.status ?? 500, 'error', 'text/plain');
    }
  });

  agent.attach(server);
  return server;
}
