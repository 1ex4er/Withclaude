// Проверка игрока по внешним базам.
//  - Steam Web API (официальный): VAC/игровые баны, бан сообщества, возраст аккаунта, часы в DayZ.
//  - Любые базы банов проектов (HunterEye и т.п.) — через "providers" в config.json, когда у базы есть API.
//
// Пример провайдера:
//   { "name": "HunterEye", "url": "https://…/check?steamid={steamId}", "tokenEnv": "HUNTEREYE_TOKEN",
//     "listField": "bans", "reasonField": "reason", "projectField": "project", "dateField": "date" }
//   или вместо listField: "bannedField": "banned", "reasonField": "reason"

import https from 'node:https';

const DAYZ_APP_ID = 221100;
const TIMEOUT_MS = 10000;

// Запросы к Steam можно пустить через тот же прокси, что и Discord (в РФ Steam бывает недоступен).
let proxyAgent = null;
export function setBanCheckProxy(agent) {
  proxyAgent = agent;
}

function proxyFetch(agent) {
  return (url, { headers = {}, signal } = {}) =>
    new Promise((resolve, reject) => {
      const req = https.request(url, { headers, agent, signal }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text), text: async () => text });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
}

const defaultFetch = (...args) => (proxyAgent ? proxyFetch(proxyAgent)(...args) : fetch(...args));

const pick = (obj, field) => (field ? String(field).split('.').reduce((o, k) => (o == null ? o : o[k]), obj) : undefined);

async function getJson(fetchImpl, url, headers = {}) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function checkSteam(steamId, apiKey, fetchImpl = defaultFetch) {
  const base = 'https://api.steampowered.com';
  const q = `key=${encodeURIComponent(apiKey)}&steamids=${steamId}`;
  const [bans, summary, games] = await Promise.all([
    getJson(fetchImpl, `${base}/ISteamUser/GetPlayerBans/v1/?${q}`),
    getJson(fetchImpl, `${base}/ISteamUser/GetPlayerSummaries/v2/?${q}`),
    getJson(fetchImpl, `${base}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamId}&include_played_free_games=1&appids_filter[0]=${DAYZ_APP_ID}`).catch(() => null),
  ]);
  const b = bans.players?.[0] ?? {};
  const p = summary.response?.players?.[0] ?? {};
  const dayz = games?.response?.games?.find((g) => g.appid === DAYZ_APP_ID);
  const details = [];
  if (b.VACBanned) details.push({ reason: `VAC-баны: ${b.NumberOfVACBans}`, date: b.DaysSinceLastBan != null ? `${b.DaysSinceLastBan} дн. назад` : null });
  if (b.NumberOfGameBans) details.push({ reason: `Игровые баны: ${b.NumberOfGameBans}`, date: b.DaysSinceLastBan != null ? `${b.DaysSinceLastBan} дн. назад` : null });
  if (b.CommunityBanned) details.push({ reason: 'Бан сообщества Steam' });
  if (b.EconomyBan && b.EconomyBan !== 'none') details.push({ reason: `Торговый бан: ${b.EconomyBan}` });
  return {
    source: 'Steam',
    banned: details.length > 0,
    details,
    info: {
      name: p.personaname ?? null,
      createdAt: p.timecreated ? p.timecreated * 1000 : null,
      publicProfile: p.communityvisibilitystate === 3,
      dayzHours: dayz ? Math.round(dayz.playtime_forever / 60) : null,
      dayzHours2w: dayz ? Math.round((dayz.playtime_2weeks ?? 0) / 60) : null,
      lastOnline: p.lastlogoff ? p.lastlogoff * 1000 : null,
      inGame: p.gameextrainfo ?? null,
      country: p.loccountrycode ?? null,
    },
  };
}

export async function checkProvider(provider, steamId, fetchImpl = defaultFetch) {
  const url = provider.url.replace('{steamId}', encodeURIComponent(steamId));
  const headers = {};
  const token = provider.tokenEnv ? process.env[provider.tokenEnv] : null;
  if (token) headers[provider.tokenHeader ?? 'authorization'] = `${provider.tokenPrefix ?? 'Bearer '}${token}`;
  const data = await getJson(fetchImpl, url, headers);
  if (provider.listField) {
    const list = pick(data, provider.listField) ?? [];
    const details = (Array.isArray(list) ? list : []).map((x) => ({
      reason: String(pick(x, provider.reasonField) ?? 'без причины'),
      project: pick(x, provider.projectField) ?? null,
      date: pick(x, provider.dateField) ?? null,
    }));
    return { source: provider.name, banned: details.length > 0, details };
  }
  const banned = Boolean(pick(data, provider.bannedField ?? 'banned'));
  const reason = pick(data, provider.reasonField);
  return { source: provider.name, banned, details: banned ? [{ reason: String(reason ?? 'без причины') }] : [] };
}

// Все проверки параллельно; ошибка одной базы не мешает остальным.
export async function checkAll(cfg, steamId, fetchImpl = defaultFetch) {
  const jobs = [];
  if (process.env.STEAM_API_KEY) jobs.push(checkSteam(steamId, process.env.STEAM_API_KEY, fetchImpl));
  for (const p of cfg.banCheck.providers) jobs.push(checkProvider(p, steamId, fetchImpl).catch((e) => Promise.reject(Object.assign(e, { source: p.name }))));
  const settled = await Promise.allSettled(jobs);
  return settled.map((s) => (s.status === 'fulfilled' ? s.value : { source: s.reason.source ?? 'Steam', error: s.reason.message }));
}

// Поля для embed: баны по каждой базе + сведения о Steam-профиле.
const dts = (ms, style = 'D') => `<t:${Math.floor(ms / 1000)}:${style}>`;

export function banFields(results) {
  if (!results.length) return [{ name: '🔎 Баны', value: 'Проверка не настроена: добавь STEAM_API_KEY в bot/.env' }];
  const fields = [];
  for (const r of results) {
    let value;
    if (r.error) value = `⚠️ не удалось проверить: ${r.error}`;
    else if (!r.banned) value = '✅ банов нет';
    else
      value = r.details
        .slice(0, 8)
        .map((d) => `⛔ ${d.reason}${d.project ? ` — ${d.project}` : ''}${d.date ? ` (${d.date})` : ''}`)
        .join('\n');
    fields.push({ name: `🔎 Баны · ${r.source}`, value: value.slice(0, 1024) });
    if (r.info) {
      const i = r.info;
      const lines = [
        i.name && `Ник: **${i.name}**`,
        i.createdAt ? `Аккаунт создан: ${dts(i.createdAt)} (${dts(i.createdAt, 'R')})` : 'Дата создания скрыта',
        i.dayzHours != null ? `DayZ: **${i.dayzHours} ч**${i.dayzHours2w ? `, за 2 недели ${i.dayzHours2w} ч` : ''}` : 'Часы DayZ скрыты',
        i.inGame ? `Сейчас играет: ${i.inGame}` : i.lastOnline ? `Был в сети: ${dts(i.lastOnline, 'R')}` : null,
        i.country && `Страна: ${i.country}`,
        i.publicProfile ? null : '🔒 Профиль закрыт',
      ].filter(Boolean);
      fields.push({ name: '🎮 Steam-профиль', value: lines.join('\n').slice(0, 1024) });
    }
  }
  return fields;
}

export const hasBans = (results) => results.some((r) => r.banned);
