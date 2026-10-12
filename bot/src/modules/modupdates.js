// Обновления модов: раз в modUpdates.intervalMinutes бот сравнивает дату обновления каждого включённого мода
// в Steam Workshop с датой его файлов на сервере (агент, mods.list). Устаревшие — в мод-лог Discord
// (один раз на каждое обновление) и на сайт (/api/mods/updates → админка «Сервер»).

import { steamFetch } from '../bancheck.js';
import { embed } from '../util.js';

const STEAM_API = 'https://api.steampowered.com/IPublishedFileService/GetDetails/v1/';
// Небольшой запас: копирование файлов при обновлении идёт уже после публикации в Workshop.
const SLACK_MS = 60_000;

// mods — из агента (mods.list), details — { [id]: { title, updatedAt } } из Workshop.
export function findOutdated(mods, details, overrides = {}) {
  const rows = [];
  for (const m of mods) {
    if (!m.enabled) continue;
    const id = overrides[m.folder] ?? (m.publishedId && m.publishedId !== '0' ? m.publishedId : null);
    if (!id) {
      rows.push({ folder: m.folder, name: m.name ?? m.folder, id: null, workshopAt: null, localAt: m.filesUpdatedAt ?? null, outdated: false });
      continue;
    }
    const w = details[id];
    const workshopAt = w?.updatedAt ?? null;
    const localAt = m.filesUpdatedAt ?? null;
    rows.push({
      folder: m.folder,
      name: w?.title || m.name || m.folder,
      id,
      workshopAt,
      localAt,
      outdated: Boolean(workshopAt && localAt && workshopAt > localAt + SLACK_MS),
    });
  }
  return rows;
}

export async function fetchWorkshop(ids, apiKey, fetchImpl = steamFetch) {
  if (!ids.length) return {};
  const q = new URLSearchParams({ key: apiKey });
  ids.forEach((id, i) => q.set(`publishedfileids[${i}]`, id));
  const res = await fetchImpl(`${STEAM_API}?${q}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Steam: HTTP ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const d of data?.response?.publishedfiledetails ?? []) {
    if (d.result === 1 && d.time_updated) out[String(d.publishedfileid)] = { title: d.title ?? '', updatedAt: d.time_updated * 1000 };
  }
  return out;
}

const workshopUrl = (id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
const unix = (ms) => `<t:${Math.floor(ms / 1000)}:f>`;

export async function checkModUpdates(ctx, fetchImpl = steamFetch) {
  const apiKey = process.env.STEAM_API_KEY;
  if (!apiKey || !ctx.agent.online) return null;
  const mods = await ctx.agent.call('mods.list', {}, 'mod-updates');
  const overrides = ctx.cfg.modUpdates.ids ?? {};
  const ids = [...new Set(mods.filter((m) => m.enabled).map((m) => overrides[m.folder] ?? m.publishedId).filter((id) => id && id !== '0'))];
  const details = await fetchWorkshop(ids, apiKey, fetchImpl);
  const rows = findOutdated(mods, details, overrides);
  const result = { checkedAt: Date.now(), mods: rows };
  ctx.db.kv.set('mods.updates', result);

  // В мод-лог — только новые обновления (каждое один раз).
  const notified = new Set(ctx.db.kv.get('mods.notified', []));
  const fresh = rows.filter((r) => r.outdated && !notified.has(`${r.id}:${r.workshopAt}`));
  if (fresh.length) {
    const lines = fresh.map((r) => `• [${r.name}](${workshopUrl(r.id)}) — в Workshop ${unix(r.workshopAt)}, на сервере ${unix(r.localAt)}`);
    await ctx.post('modLog', {
      embeds: [
        embed('warn', '🧩 Обновились моды в Workshop', `${lines.join('\n')}\n\nОбнови их в панели хостинга («Управление модами» → «Обновить/Исправить») и перезапусти сервер, иначе игроков с новой версией не пустит.`.slice(0, 4000)),
      ],
    });
    for (const r of fresh) notified.add(`${r.id}:${r.workshopAt}`);
    ctx.db.kv.set('mods.notified', [...notified].slice(-500));
  }
  return result;
}

export default {
  name: 'modupdates',

  init(ctx) {
    const run = () => checkModUpdates(ctx).catch((e) => ctx.log.warn(`проверка обновлений модов: ${e.message}`));
    setTimeout(run, 60_000).unref();
    setInterval(run, Math.max(5, ctx.cfg.modUpdates.intervalMinutes) * 60_000).unref();
  },
};
