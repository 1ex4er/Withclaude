// Работа агента: подключение к сайтам из config.json и выполнение их команд в пределах allow.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPublicKey } from '../../shared/protocol.js';
import { createActions } from './actions.js';
import { loadConfig, readBattlEyeConfig } from './config.js';
import { HubConnection } from './connection.js';
import { AgentError } from './errors.js';
import { FileManager } from './files.js';
import { fingerprint, loadOrCreateAgentKey } from './keys.js';
import { LogManager } from './logs.js';
import { ModManager } from './mods.js';
import { LX_SITE_PUBLIC_KEY, VERSION } from './paths.js';
import { ServerProcess } from './process.js';
import { BERcon } from './rcon.js';
import { AuditLog, StateStore } from './state.js';

// Журнал работы пишется и в консоль, и в agent.log (при запуске из Планировщика консоли не видно).
const LOG_MAX_BYTES = 5 * 1024 * 1024;
let logFile = null;
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
function write(level, m) {
  const line = `${stamp()} [${level}] ${m}`;
  (level === 'info' ? console.log : console.error)(line);
  if (!logFile) return;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, logFile + '.1');
    fs.appendFileSync(logFile, line + '\n');
  } catch {}
}
export const log = {
  info: (m) => write('info', m),
  warn: (m) => write('warn', m),
  error: (m) => write('error', m),
};

// Из параметров для журнала убираем содержимое файлов — оно может быть большим.
const auditParams = (params) => {
  if (!params || typeof params !== 'object') return params;
  const { content, ...rest } = params;
  return typeof content === 'string' ? { ...rest, content: `<${content.length} символов>` } : rest;
};

export async function runAgent(configPath) {
  const envPath = path.join(path.dirname(configPath), '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

  logFile = path.join(path.dirname(configPath), 'agent.log');
  const cfg = loadConfig(configPath);
  const state = new StateStore(cfg.stateFile);
  const audit = new AuditLog(cfg.auditLog);
  const key = loadOrCreateAgentKey(cfg.keysDir);
  const fp = fingerprint(key.publicPem);

  const be = readBattlEyeConfig(cfg.server);
  const rconPort = cfg.rcon.port ?? be.port ?? 2306;
  const rcon = new BERcon({ host: cfg.rcon.host, port: rconPort, password: process.env.RCON_PASSWORD || be.password });
  if (!rcon.password) log.warn('пароль RCon не найден (beserver_x64.cfg или RCON_PASSWORD в .env) — RCon недоступен');

  const server = new ServerProcess({ cfg, state, rcon, log });
  const mods = new ModManager({ serverDir: cfg.server.dir, steamcmd: cfg.steamcmd, steamUser: process.env.STEAM_USER, log });

  const hubs = new Map();
  const emitTo = (hubName, topic, data) => hubs.get(hubName)?.send({ type: 'event', topic, data });
  // Событие получают только сайты, которым разрешено соответствующее действие.
  const broadcast = (topic, data, requiredAction) => {
    for (const h of hubs.values()) if (h.allows(requiredAction)) h.send({ type: 'event', topic, data });
  };

  const logs = new LogManager(cfg.logs, emitTo);
  const actions = createActions({
    server,
    rcon,
    files: new FileManager(cfg.files),
    lxFiles: new FileManager(cfg.lx.files),
    lxModPrefix: cfg.lx.modPrefix,
    logs,
    mods,
    rconCfg: cfg.rcon,
    info: () => ({ version: VERSION, os: `${os.platform()} ${os.release()}`, fingerprint: fp, gamePort: cfg.server.port }),
  });

  async function handle(action, params, actor, hub) {
    const fn = Object.hasOwn(actions, action) ? actions[action] : null;
    const entry = { hub, actor, action, params: auditParams(params) };
    if (!fn) {
      audit.write({ ...entry, ok: false, error: 'unknown_action' });
      return { ok: false, error: { code: 'unknown_action', message: `Неизвестное действие: ${action}` } };
    }
    try {
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new AgentError('bad_params', 'params должен быть объектом');
      const result = await fn(params, actor, hub);
      if (!/\.(status|info|list|tail|roots|players|mods)$/.test(action)) audit.write({ ...entry, ok: true });
      return { ok: true, result: result ?? null };
    } catch (e) {
      const known = e instanceof AgentError;
      if (!known) log.error(`${action}: ${e.stack}`);
      audit.write({ ...entry, ok: false, error: known ? e.code : 'internal' });
      return {
        ok: false,
        error: known ? { code: e.code, message: e.message } : { code: 'internal', message: 'Внутренняя ошибка агента, см. журнал агента' },
      };
    }
  }

  for (const hub of cfg.hubs) {
    const sitePem = hub.sitePublicKey ?? (hub.license ? LX_SITE_PUBLIC_KEY : null);
    if (!sitePem) throw new Error(`config.json: для сайта ${hub.name} не задан sitePublicKey`);
    hubs.set(
      hub.name,
      new HubConnection({
        hub,
        agentId: hub.agentId ?? `lx-${fp}`,
        agentKey: key.privateKey,
        agentPublicPem: key.publicPem,
        siteKey: loadPublicKey(sitePem),
        handler: handle,
        onDisconnect: () => logs.unfollowAll(hub.name),
        log,
        version: VERSION,
      }),
    );
  }

  server.on('change', async (what) => broadcast('server', { what, status: await server.status().catch(() => null) }, 'server.status'));
  rcon.on('message', (text) => broadcast('rcon', { text }, 'rcon.players'));
  rcon.on('error', (e) => log.warn(`rcon: ${e.message}`));

  const adopted = await server.adopt();
  if (adopted) log.info(`найден запущенный сервер, pid ${adopted} — ${cfg.server.manage ? 'взят под управление' : 'только наблюдение (сайтам не разрешены старт/стоп)'}`);
  server.startWatchdog();
  for (const h of hubs.values()) h.start();
  log.info(`агент v${VERSION} запущен (ключ ${fp}), сайты: ${cfg.hubs.map((h) => `${h.name} [${h.allow.join(', ')}]`).join('; ')}`);

  const shutdown = () => {
    log.info('агент останавливается (сам DayZ-сервер продолжает работать)');
    server.stopWatchdog();
    logs.unfollowAll();
    rcon.close();
    for (const h of hubs.values()) h.stop();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
