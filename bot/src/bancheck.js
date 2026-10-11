// Проверка игрока по внешним базам.
//  - Steam Web API (официальный): VAC/игровые баны, бан сообщества, возраст аккаунта, часы в DayZ.
//  - Любые базы банов проектов (HunterEye и т.п.) — через "providers" в config.json, когда у базы есть API.
//
// Пример провайдера:
//   { "name": "HunterEye", "url": "https://…/check?steamid={steamId}", "tokenEnv": "HUNTEREYE_TOKEN",
//     "listField": "bans", "reasonField": "reason", "projectField": "project", "dateField": "date" }
//   или вместо listField: "bannedField": "banned", "reasonField": "reason"

const DAYZ_APP_ID = 221100;
const TIMEOUT_MS = 8000;

const pick = (obj, field) => (field ? String(field).split('.').reduce((o, k) => (o == null ? o : o[k]), obj) : undefined);

async function getJson(fetchImpl, url, headers = {}) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function checkSteam(steamId, apiKey, fetchImpl = fetch) {
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
    },
  };
}

export async function checkProvider(provider, steamId, fetchImpl = fetch) {
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
export async function checkAll(cfg, steamId, fetchImpl = fetch) {
  const jobs = [];
  if (process.env.STEAM_API_KEY) jobs.push(checkSteam(steamId, process.env.STEAM_API_KEY, fetchImpl));
  for (const p of cfg.banCheck.providers) jobs.push(checkProvider(p, steamId, fetchImpl).catch((e) => Promise.reject(Object.assign(e, { source: p.name }))));
  const settled = await Promise.allSettled(jobs);
  return settled.map((s) => (s.status === 'fulfilled' ? s.value : { source: s.reason.source ?? 'Steam', error: s.reason.message }));
}

// Поля для embed: сводка по всем базам.
export function banFields(results) {
  if (!results.length) return [{ name: 'Проверка банов', value: 'Не настроена (STEAM_API_KEY / banCheck.providers)' }];
  return results.map((r) => {
    let value;
    if (r.error) value = `⚠️ не удалось проверить: ${r.error}`;
    else if (!r.banned) value = '✅ банов нет';
    else
      value = r.details
        .slice(0, 8)
        .map((d) => `⛔ ${d.reason}${d.project ? ` — ${d.project}` : ''}${d.date ? ` (${d.date})` : ''}`)
        .join('\n');
    if (r.info) {
      const extra = [
        r.info.createdAt ? `аккаунт с ${new Date(r.info.createdAt).toLocaleDateString('ru-RU')}` : 'дата создания скрыта',
        r.info.dayzHours != null ? `DayZ: ${r.info.dayzHours} ч` : 'часы DayZ скрыты',
        r.info.publicProfile ? null : 'профиль закрыт',
      ].filter(Boolean);
      value += `\n${extra.join(' · ')}`;
    }
    return { name: `🔎 ${r.source}`, value: value.slice(0, 1024) };
  });
}

export const hasBans = (results) => results.some((r) => r.banned);
