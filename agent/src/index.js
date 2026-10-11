// Агент управления DayZ-сервером Blackout. Запускается на Windows VDS рядом с сервером.
//   node agent/src/index.js [путь к config.json]

import fs from 'node:fs';
import path from 'node:path';
import { loadPrivateKey, loadPublicKey } from '../../shared/protocol.js';
import { createActions } from './actions.js';
import { loadConfig } from './config.js';
import { HubConnection } from './connection.js';
import { AgentError } from './errors.js';
import { FileManager } from './files.js';
import { LogManager } from './logs.js';
import { ModManager } from './mods.js';
import { ServerProcess } from './process.js';
import { BERcon } from './rcon.js';
import { AuditLog, StateStore } from './state.js';

const VERSION = '0.1.0';

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const log = {
  info: (m) => console.log(`${stamp()} [info] ${m}`),
  warn: (m) => console.warn(`${stamp()} [warn] ${m}`),
  error: (m) => console.error(`${stamp()} [error] ${m}`),
};

const configPath = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..', 'config.json'));
const envPath = path.join(path.dirname(configPath), '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const cfg = loadConfig(configPath);
const state = new StateStore(cfg.stateFile);
const audit = new AuditLog(cfg.auditLog);

const rcon = new BERcon({ host: cfg.rcon.host, port: cfg.rcon.port, password: process.env.RCON_PASSWORD });
const server = new ServerProcess({ cfg, state, rcon, log });
const files = new FileManager(cfg.files);
const mods = new ModManager({ serverDir: cfg.server.dir, steamcmd: cfg.steamcmd, steamUser: process.env.STEAM_USER, log });

let hub;
const emit = (topic, data) => hub?.send({ type: 'event', topic, data });
const logs = new LogManager(cfg.logs, emit);
const actions = createActions({ server, rcon, files, logs, mods, rconCfg: cfg.rcon });

// Из параметров для журнала убираем содержимое файлов — оно может быть большим.
const auditParams = (params) => {
  const { content, ...rest } = params;
  return content === undefined ? rest : { ...rest, content: `<${content.length} символов>` };
};

async function handle(action, params, actor) {
  const fn = Object.hasOwn(actions, action) ? actions[action] : null;
  const entry = { actor, action, params: params && typeof params === 'object' ? auditParams(params) : params };
  if (!fn) {
    audit.write({ ...entry, ok: false, error: 'unknown_action' });
    return { ok: false, error: { code: 'unknown_action', message: `Неизвестное действие: ${action}` } };
  }
  try {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new AgentError('bad_params', 'params должен быть объектом');
    const result = await fn(params, actor);
    if (!action.endsWith('.status') && !action.startsWith('logs.')) audit.write({ ...entry, ok: true });
    return { ok: true, result: result ?? null };
  } catch (e) {
    const known = e instanceof AgentError;
    if (!known) log.error(`${action}: ${e.stack}`);
    audit.write({ ...entry, ok: false, error: known ? e.code : 'internal' });
    return {
      ok: false,
      error: known ? { code: e.code, message: e.message } : { code: 'internal', message: 'Внутренняя ошибка агента, см. консоль агента' },
    };
  }
}

server.on('change', async (what) => emit('server', { what, status: await server.status().catch(() => null) }));
rcon.on('message', (text) => emit('rcon', { text }));
rcon.on('error', (e) => log.warn(`rcon: ${e.message}`));

hub = new HubConnection({
  url: cfg.hubUrl,
  agentId: cfg.agentId,
  agentKey: loadPrivateKey(cfg.keys.agentPrivateKey),
  siteKey: loadPublicKey(cfg.keys.sitePublicKey),
  tlsPinSha256: cfg.tlsPinSha256,
  handler: handle,
  onDisconnect: () => logs.unfollowAll(),
  log,
  version: VERSION,
});

const adopted = await server.adopt();
if (adopted) log.info(`найден запущенный сервер, pid ${adopted} — взят под управление`);
server.startWatchdog();
hub.start();
log.info(`агент ${cfg.agentId} v${VERSION} запущен, сайт: ${cfg.hubUrl}`);

const shutdown = () => {
  log.info('агент останавливается (сам DayZ-сервер продолжает работать)');
  server.stopWatchdog();
  logs.unfollowAll();
  rcon.close();
  hub.stop();
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
