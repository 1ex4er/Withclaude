// Разбор того, что игрок вписал как свой Steam: SteamID64, ссылка на профиль, STEAM_0:X:Y, [U:1:N]
// или короткая ссылка /id/имя (её превращаем в SteamID64 через Steam Web API, нужен STEAM_API_KEY).

const BASE = 76561197960265728n;

export function parseSteamInput(input) {
  const text = String(input ?? '').trim();
  let m = /^(7656119\d{10})$/.exec(text);
  if (m) return { steamId: m[1] };
  m = /steamcommunity\.com\/profiles\/(7656119\d{10})/i.exec(text);
  if (m) return { steamId: m[1] };
  m = /^STEAM_[0-5]:([01]):(\d{1,10})$/i.exec(text);
  if (m) return { steamId: String(BASE + BigInt(m[2]) * 2n + BigInt(m[1])) };
  m = /^\[?U:1:(\d{1,10})\]?$/i.exec(text);
  if (m) return { steamId: String(BASE + BigInt(m[1])) };
  m = /steamcommunity\.com\/id\/([\w-]{2,32})/i.exec(text);
  if (m) return { vanity: m[1] };
  if (/^[\w-]{2,32}$/.test(text) && !/^\d+$/.test(text)) return { vanity: text };
  return { error: 'Не похоже на SteamID. Вставь ссылку на профиль Steam или SteamID64 (17 цифр, начинается с 7656119).' };
}

export async function resolveSteamInput(input, { apiKey = process.env.STEAM_API_KEY, fetchImpl = fetch } = {}) {
  const parsed = parseSteamInput(input);
  if (!parsed.vanity) return parsed;
  if (!apiKey) return { error: 'Ссылку вида /id/имя бот разобрать не может — вставь ссылку /profiles/7656119… или SteamID64 (его покажет steamid.io).' };
  try {
    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(parsed.vanity)}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    if (data?.response?.success === 1 && /^7656119\d{10}$/.test(data.response.steamid)) return { steamId: data.response.steamid };
    return { error: `Профиль «${parsed.vanity}» не найден в Steam.` };
  } catch {
    return { error: 'Steam не ответил. Вставь SteamID64 (17 цифр) — его покажет steamid.io.' };
  }
}
