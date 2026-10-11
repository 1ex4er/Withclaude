// Бот Blackout + служба управления сервером.
//   node bot/src/index.js [путь к config.json]

// preload.js — первым: .env и прокси до загрузки discord.js.
import { proxyAgent } from './preload.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { AgentLink } from './agent.js';
import { loadConfig } from './config.js';
import { createContext, createRouter } from './core.js';
import { scheduleBackups } from './backup.js';
import { setBanCheckProxy } from './bancheck.js';
import { openDb } from './db.js';
import { proxiedMakeRequest } from './proxy-rest.js';
import { createHttpServer } from './http.js';
import { Links } from './links.js';
import { applySettings } from './settings.js';
import { MODULES } from './modules/index.js';
import { Whitelist } from './whitelist.js';

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = {
  info: (m) => console.log(`${stamp()} [info] ${m}`),
  warn: (m) => console.warn(`${stamp()} [warn] ${m}`),
  error: (m) => console.error(`${stamp()} [error] ${m}`),
};

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig(process.argv[2] ?? path.join(here, '..', 'config.json'));
const db = openDb(cfg.dbFile);
applySettings(cfg, db); // роли и каналы, выбранные через /setup
scheduleBackups(db, cfg.backup, log);
const links = new Links(db);
const agent = new AgentLink(cfg, log);
if (proxyAgent) setBanCheckProxy(proxyAgent);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // антирейд, верификация (включить в Developer Portal)
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // автомодерация (включить в Developer Portal)
    GatewayIntentBits.GuildModeration, // антинюк: баны и журнал аудита
  ],
  partials: [Partials.GuildMember],
  allowedMentions: { parse: [], repliedUser: false },
  ...(proxyAgent ? { rest: { makeRequest: proxiedMakeRequest(proxyAgent) } } : {}),
});

const ctx = createContext({ client, cfg, db, agent, links, log });
ctx.whitelist = new Whitelist(ctx);
const route = createRouter(MODULES, ctx);

client.once(Events.ClientReady, async () => {
  log.info(`бот вошёл как ${client.user.tag}`);
  setInterval(() => log.info(`ping Discord: ${client.ws.ping} мс`), 5 * 60_000).unref();
  const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
  if (!guild) {
    log.error(`бот не добавлен на сервер ${cfg.guildId}`);
    return;
  }
  let commands = MODULES.flatMap((m) => m.commands ?? []).map((c) => c.toJSON());
  // commands.hideFromPlayers = false: команды персонала видны всем в Discord,
  // а кто может ими пользоваться, решают роли в боте (roles.admin/moderator/support).
  if (cfg.commands.hideFromPlayers === false) commands = commands.map((c) => ({ ...c, default_member_permissions: null }));
  await guild.commands.set(commands);
  log.info(`зарегистрировано команд: ${commands.length}`);
  for (const m of MODULES) {
    try {
      await m.init?.(ctx);
    } catch (e) {
      log.error(`модуль ${m.name}: ${e.stack}`);
    }
  }
});
client.on(Events.InteractionCreate, route);
client.on(Events.Error, (e) => log.error(`discord: ${e.message}`));

const server = createHttpServer({
  cfg,
  links,
  agent,
  log,
  onLinked: (discordId, steamId, previous) => ctx.emitLinked?.(discordId, steamId, previous) ?? Promise.resolve(),
});
server.listen(cfg.http.port, cfg.http.host, () => log.info(`HTTP: http://${cfg.http.host}:${cfg.http.port} (за nginx)`));

await client.login(cfg.secrets.discordToken);

const shutdown = async () => {
  log.info('остановка');
  server.close();
  agent.hub?.close();
  await client.destroy();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
