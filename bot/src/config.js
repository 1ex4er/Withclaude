import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  guildId: '',
  publicUrl: 'https://blackoutstalkerrp.ru',
  http: { host: '127.0.0.1', port: 3100 },
  commands: { hideFromPlayers: true },
  // Приём нажатий по HTTP (нужен DISCORD_PUBLIC_KEY в .env и адрес в Developer Portal).
  interactions: { path: '/discord/interactions' },
  agent: {
    id: 'blackout-main',
    sitePrivateKey: 'keys/site_private.pem',
    agentPublicKey: 'keys/agent_public.pem',
  },
  roles: {
    admin: [],
    moderator: [],
    support: [],
    verified: '',
    unverified: '',
    steamLinked: '',
    whitelisted: '',
    muted: '',
  },
  channels: {
    status: '',
    alerts: '',
    modLog: '',
    adminLog: '',
    joinLeave: '',
    killFeed: '',
    gameChat: '',
    applications: '',
    ticketLog: '',
    verifyReview: '',
  },
  status: { intervalSec: 60, maxPlayers: 60, connect: '109.248.4.96:2302' },
  logs: { admFollow: true },
  tickets: {
    categoryId: '',
    // Серверы группировок: тикеты оттуда пересылаются на основной сервер (выбираются в /setup factions).
    factionGuilds: [],
    maxOpenPerUser: 2,
    types: [
      { id: 'help', label: 'Вопрос', emoji: '❓' },
      { id: 'report', label: 'Жалоба на игрока', emoji: '⚠️' },
      { id: 'bug', label: 'Баг', emoji: '🐞' },
      { id: 'donate', label: 'Донат', emoji: '💰' },
      { id: 'appeal', label: 'Обжалование бана', emoji: '⚖️' },
    ],
  },
  applications: { acceptRoles: [], removeRoles: [], addToWhitelist: true, cooldownHours: 24, requireSteam: true },
  whitelist: { root: 'server', path: 'whitelist.txt' },
  // Внешние базы банов (HunterEye и т.п.), см. bot/src/bancheck.js. Steam проверяется при STEAM_API_KEY в .env.
  banCheck: { providers: [], alertOnLink: true },
  verify: { minAccountAgeDays: 3, askSteam: true, manualApproval: false },
  // RP-наказания: роль на каждый тип (выбираются в /setup roles).
  punishments: { roles: { nlr: '', nonrp: '', pg: '', rdm: '', meta: '', ban: '' } },
  backup: { keep: 14, intervalHours: 24 },
  // Проверка обновлений модов в Workshop: ids — Workshop ID для модов без publishedid в meta.cpp ({"@Папка": "123"}).
  modUpdates: { intervalMinutes: 30, ids: {} },
  automod: {
    exemptRoles: [],
    spam: { messages: 6, seconds: 8 },
    duplicates: 3,
    maxMentions: 5,
    blockInvites: true,
    blockScamLinks: true,
    extraBlockedPatterns: [],
    timeoutMinutes: 10,
  },
  antiraid: { joins: 8, seconds: 20, minAccountAgeDays: 1, lockMinutes: 15, action: 'kick' },
  antinuke: { actions: 4, seconds: 30, trusted: [] },
  warns: { muteAt: 3, muteMinutes: 60, banAt: 5 },
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

// config.json — ID каналов и ролей, настройки. Секреты (DISCORD_TOKEN, API_TOKEN) — только в .env.
export function loadConfig(file) {
  const configPath = path.resolve(file);
  const baseDir = path.dirname(configPath);
  const envPath = path.join(baseDir, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

  const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const cfg = merge(DEFAULTS, raw);
  if (!process.env.DISCORD_TOKEN) throw new Error('.env: не задан DISCORD_TOKEN');
  if (!/^\d{17,20}$/.test(cfg.guildId)) throw new Error('config.json: guildId — ID Discord-сервера');
  if (!cfg.publicUrl.startsWith('https://')) throw new Error('config.json: publicUrl должен быть https://');

  cfg.agent.sitePrivateKey = path.resolve(baseDir, cfg.agent.sitePrivateKey);
  cfg.agent.agentPublicKey = path.resolve(baseDir, cfg.agent.agentPublicKey);
  cfg.dbFile = path.resolve(baseDir, raw.dbFile ?? 'bot.db');
  cfg.transcriptsDir = path.resolve(baseDir, raw.transcriptsDir ?? 'transcripts');
  cfg.backup.dir = path.resolve(baseDir, raw.backup?.dir ?? 'backups');
  cfg.secrets = {
    discordToken: process.env.DISCORD_TOKEN,
    apiToken: process.env.API_TOKEN || null,
    publicKey: process.env.DISCORD_PUBLIC_KEY || null,
  };
  return cfg;
}

export { DEFAULTS };
