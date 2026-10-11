import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';

export const COLORS = { ok: 0x3ba55d, warn: 0xfaa61a, bad: 0xed4245, info: 0x5865f2, neutral: 0x2b2d31 };

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).filter(Boolean);

// Уровни персонала: admin > moderator > support. Администратор Discord-сервера — всегда admin.
export function staffLevel(member, roles) {
  if (!member) return 0;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return 3;
  const has = (ids) => asList(ids).some((id) => member.roles?.cache?.has(id));
  if (has(roles.admin)) return 3;
  if (has(roles.moderator)) return 2;
  if (has(roles.support)) return 1;
  return 0;
}

export const LEVEL = { support: 1, moderator: 2, admin: 3 };
export const LEVEL_NAME = { 1: 'поддержка', 2: 'модератор', 3: 'администратор' };

export function embed(color, title, description) {
  const e = new EmbedBuilder().setColor(COLORS[color] ?? color);
  if (title) e.setTitle(title.slice(0, 256));
  if (description) e.setDescription(String(description).slice(0, 4096));
  return e.setTimestamp();
}

// "10m", "2h", "3d", "1w" -> миллисекунды. Пусто/0 -> null (навсегда).
export function parseDuration(text) {
  if (!text) return null;
  const m = /^(\d{1,5})\s*(s|m|h|d|w|с|м|ч|д|н)$/i.exec(String(text).trim());
  if (!m) return undefined;
  const mult = { s: 1, с: 1, m: 60, м: 60, h: 3600, ч: 3600, d: 86400, д: 86400, w: 604800, н: 604800 }[m[2].toLowerCase()];
  const ms = Number(m[1]) * mult * 1000;
  return ms > 0 ? ms : null;
}

export function formatDuration(ms) {
  if (!ms) return 'навсегда';
  const parts = [];
  for (const [unit, size] of [['д', 86400e3], ['ч', 3600e3], ['мин', 60e3]]) {
    const n = Math.floor(ms / size);
    if (n) parts.push(`${n} ${unit}`);
    ms -= n * size;
  }
  return parts.join(' ') || 'меньше минуты';
}

// Discord-время: <t:...:R> — "через 5 минут" в часовом поясе читателя.
export const ts = (ms, style = 'R') => `<t:${Math.floor(ms / 1000)}:${style}>`;

export const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Экранирование markdown в именах игроков/текстах из игры.
export const escapeMd = (s) => String(s).replace(/([\\*_`~|>])/g, '\\$1').replace(/@/g, '@\u200b');
