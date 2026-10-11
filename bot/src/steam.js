// Вход через Steam (OpenID 2.0) — так игрок доказывает, что Steam-аккаунт его.
// Пароль Steam бот не видит: игрок входит на steamcommunity.com, Steam возвращает подписанный ответ,
// бот проверяет подпись запросом к самому Steam.

const STEAM_LOGIN = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
const SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';

export function steamLoginUrl({ returnTo, realm }) {
  const p = new URLSearchParams({
    'openid.ns': NS,
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': realm,
    'openid.identity': SELECT,
    'openid.claimed_id': SELECT,
  });
  return `${STEAM_LOGIN}?${p}`;
}

// Возвращает SteamID64 или null. fetchImpl — для тестов.
export async function verifySteamCallback(query, { expectedReturnTo, fetchImpl = fetch }) {
  const get = (k) => query.get(`openid.${k}`);
  if (get('mode') !== 'id_res') return null;
  if (get('op_endpoint') !== STEAM_LOGIN) return null;
  if (get('return_to') !== expectedReturnTo) return null;
  const claimed = get('claimed_id') ?? '';
  const m = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimed);
  if (!m || get('identity') !== claimed) return null;

  const body = new URLSearchParams();
  for (const [k, v] of query) if (k.startsWith('openid.')) body.set(k, v);
  body.set('openid.mode', 'check_authentication');
  const res = await fetchImpl(STEAM_LOGIN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  return /^is_valid\s*:\s*true$/m.test(text) ? m[1] : null;
}
