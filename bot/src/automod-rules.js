// Правила автомодерации — чистые функции (тестируются без Discord).

const OFFICIAL = new Set([
  'discord.com',
  'discord.gg',
  'discordapp.com',
  'discordapp.net',
  'discord.gift',
  'discord.media',
  'steamcommunity.com',
  'steampowered.com',
  'store.steampowered.com',
  'help.steampowered.com',
  'steamcdn-a.akamaihd.net',
]);

const URL_RE = /\bhttps?:\/\/([^\s/?#<>]+)[^\s<>]*/gi;
const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg)\/[\w-]{2,}/i;
// Похожие на Discord/Steam домены: dlscord, disc0rd, steamcomrnunity, stearncommunity…
const LOOKALIKE = [/d[i1l!|]+[s5][ck]+[o0]+r+[dcl]/i, /st[e3][a@]?[mrn]+[-.]?c[o0]+m+[mrn]*[uv]+n[i1l]+t[yi]/i, /st[e3][a@]?[mrn]+p[o0]w[e3]r/i];
const SCAM_TEXT = /(free|бесплатн|раздач|получи|забери).{0,40}(nitro|нитро|скин|skin|gift|подар)|nitro.{0,20}(free|бесплатн)|@everyone.{0,80}https?:\/\//i;

export function extractHosts(text) {
  const hosts = [];
  for (const m of text.matchAll(URL_RE)) hosts.push(m[1].toLowerCase().replace(/^www\./, '').replace(/:\d+$/, ''));
  return hosts;
}

const isOfficial = (host) => [...OFFICIAL].some((d) => host === d || host.endsWith('.' + d));

export function detectScam(text, extraPatterns = []) {
  const hosts = extractHosts(text);
  for (const h of hosts) {
    if (!isOfficial(h) && LOOKALIKE.some((re) => re.test(h))) return `поддельный домен ${h}`;
  }
  if (hosts.some((h) => !isOfficial(h)) && SCAM_TEXT.test(text)) return 'похоже на раздачу-скам';
  for (const p of extraPatterns) {
    try {
      if (new RegExp(p, 'i').test(text)) return 'запрещённая ссылка/фраза';
    } catch {}
  }
  return null;
}

export const hasInvite = (text) => INVITE_RE.test(text);

// Скользящее окно сообщений участника: частота и повторы.
export class SpamTracker {
  constructor({ messages, seconds }, duplicates) {
    this.limit = messages;
    this.windowMs = seconds * 1000;
    this.duplicates = duplicates;
    this.users = new Map(); // userId -> [{ at, text }]
  }

  // Возвращает причину или null.
  hit(userId, text, now = Date.now()) {
    const list = (this.users.get(userId) ?? []).filter((x) => now - x.at < Math.max(this.windowMs, 30_000));
    list.push({ at: now, text: text.trim().toLowerCase() });
    this.users.set(userId, list);
    const recent = list.filter((x) => now - x.at < this.windowMs);
    if (recent.length >= this.limit) return `флуд (${recent.length} сообщений за ${this.windowMs / 1000} с)`;
    const key = list.at(-1).text;
    if (key.length >= 3 && list.filter((x) => x.text === key).length >= this.duplicates) return 'повтор одного и того же сообщения';
    return null;
  }

  forget(userId) {
    this.users.delete(userId);
  }
}
