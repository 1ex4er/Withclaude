// REST-запросы discord.js через прокси (см. preload.js). Тело запроса кодируется тем же undici,
// что и в discord.js (FormData с файлами — тоже), отправляется через node:https с agent прокси.

import { STATUS_CODES } from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';

const restRequire = createRequire(createRequire(import.meta.url).resolve('@discordjs/rest'));
const { Response: UndiciResponse } = restRequire('undici');

async function encodeBody(body) {
  if (body == null) return { data: null, type: null };
  if (typeof body === 'string' || body instanceof Uint8Array) return { data: Buffer.from(body), type: null };
  const r = new UndiciResponse(body);
  return { data: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') };
}

export function proxiedMakeRequest(agent) {
  return async function makeRequest(url, init) {
    const { data, type } = await encodeBody(init.body);
    const headers = { ...(init.headers ?? {}) };
    if (type && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = type;
    if (data) headers['content-length'] = String(data.length);

    const res = await new Promise((resolve, reject) => {
      const req = https.request(url, { method: init.method ?? 'GET', headers, agent, signal: init.signal }, resolve);
      req.on('error', reject);
      req.end(data ?? undefined);
    });
    const chunks = [];
    for await (const c of res) chunks.push(c);
    const buf = Buffer.concat(chunks);

    const h = new Headers();
    for (const [k, v] of Object.entries(res.headers)) for (const one of [].concat(v)) h.append(k, one);
    const status = res.statusCode;
    const response = new Response(status === 204 || status === 304 ? null : buf, { status, statusText: STATUS_CODES[status], headers: h });
    return {
      body: response.body,
      arrayBuffer: () => response.arrayBuffer(),
      json: () => response.json(),
      text: () => response.text(),
      get bodyUsed() {
        return response.bodyUsed;
      },
      headers: h,
      status,
      statusText: STATUS_CODES[status],
      ok: status >= 200 && status < 300,
    };
  };
}
