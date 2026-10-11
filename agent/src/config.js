import fs from 'node:fs';
import path from 'node:path';

// config.json — несекретные настройки. Секреты (RCON_PASSWORD, STEAM_USER) — только в .env.
export function loadConfig(file) {
  const configPath = path.resolve(file);
  const baseDir = path.dirname(configPath);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const rel = (p) => (p ? path.resolve(baseDir, p) : p);

  const required = ['agentId', 'hubUrl', 'keys', 'server', 'files'];
  for (const key of required) {
    if (!cfg[key]) throw new Error(`config.json: не задано поле "${key}"`);
  }
  if (!/^[a-z0-9-]{3,40}$/.test(cfg.agentId)) throw new Error('config.json: agentId — только a-z, 0-9, "-"');
  if (!cfg.hubUrl.startsWith('wss://') && !cfg.allowInsecureForDev) {
    throw new Error('config.json: hubUrl должен начинаться с wss:// (шифрованное соединение)');
  }

  const server = {
    exe: 'DayZServer_x64.exe',
    config: 'serverDZ.cfg',
    port: 2302,
    profiles: 'profiles',
    bePath: 'battleye',
    extraArgs: [],
    mods: [],
    serverMods: [],
    autoRestartOnCrash: true,
    stopTimeoutSec: 60,
    ...cfg.server,
  };
  server.dir = rel(server.dir);

  const files = {
    extensions: ['.cfg', '.xml', '.json', '.txt'],
    deny: ['beserver', 'battleye', 'keys', '.exe', '.dll', '.bikey'],
    maskedCfgKeys: ['passwordAdmin'],
    maxSizeMb: 10,
    keepBackups: 50,
    ...cfg.files,
  };
  files.roots = Object.fromEntries(Object.entries(files.roots ?? {}).map(([k, v]) => [k, rel(v)]));
  files.backupDir = rel(files.backupDir ?? './backups');

  return {
    ...cfg,
    tlsPinSha256: cfg.tlsPinSha256 || null,
    keys: {
      agentPrivateKey: rel(cfg.keys.agentPrivateKey),
      sitePublicKey: rel(cfg.keys.sitePublicKey),
    },
    server,
    files,
    schedule: { restarts: [], warnMinutes: [15, 5, 1], warnMessage: 'Рестарт сервера через {min} мин.', ...cfg.schedule },
    rcon: { host: '127.0.0.1', port: 2306, allowRaw: false, ...cfg.rcon },
    logs: {
      extensions: ['.rpt', '.adm', '.log'],
      ...cfg.logs,
      dir: cfg.logs?.dir ? rel(cfg.logs.dir) : path.join(server.dir, server.profiles),
    },
    steamcmd: cfg.steamcmd ? { ...cfg.steamcmd, path: rel(cfg.steamcmd.path) } : null,
    stateFile: rel(cfg.stateFile ?? './state.json'),
    auditLog: rel(cfg.auditLog ?? './audit.log'),
  };
}
