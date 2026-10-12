import fs from 'node:fs';
import path from 'node:path';

// Права сайта по умолчанию.
// Свой сайт (Blackout) — полное управление. Сайт LX у покупателей — только свои моды.
export const DEFAULT_ALLOW = {
  full: ['*'],
  lx: ['agent.info', 'server.status', 'lx.*'],
};

const ALLOW_PATTERN = /^(\*|[a-z]+\.\*|[a-z]+\.[A-Za-z]+)$/;

// config.json — несекретные настройки рядом с агентом.
export function loadConfig(file) {
  const configPath = path.resolve(file);
  const baseDir = path.dirname(configPath);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const rel = (p) => (p ? path.resolve(baseDir, p) : p);

  if (!cfg.server?.dir) throw new Error('config.json: не задан server.dir (папка DayZ-сервера)');
  if (!Array.isArray(cfg.hubs) || cfg.hubs.length === 0) throw new Error('config.json: не задан ни один сайт в hubs');

  const names = new Set();
  const hubs = cfg.hubs.map((h, i) => {
    const where = `config.json: hubs[${i}]`;
    if (!/^[a-z0-9-]{2,32}$/.test(h.name ?? '')) throw new Error(`${where}: name — a-z, 0-9, "-"`);
    if (names.has(h.name)) throw new Error(`${where}: повторяется name "${h.name}"`);
    names.add(h.name);
    if (!h.url?.startsWith('wss://') && !cfg.allowInsecureForDev) {
      throw new Error(`${where}: url должен начинаться с wss:// (шифрованное соединение)`);
    }
    if (h.agentId !== undefined && !/^[a-z0-9-]{3,40}$/.test(h.agentId)) throw new Error(`${where}: agentId — a-z, 0-9, "-"`);
    if (h.license !== undefined && !/^[A-Za-z0-9-]{8,64}$/.test(h.license)) throw new Error(`${where}: некорректный license`);
    const allow = h.allow ?? (h.license ? DEFAULT_ALLOW.lx : DEFAULT_ALLOW.full);
    if (!Array.isArray(allow) || !allow.every((a) => typeof a === 'string' && ALLOW_PATTERN.test(a))) {
      throw new Error(`${where}: allow — список вида ["server.*", "files.read", "*"]`);
    }
    return {
      name: h.name,
      url: h.url,
      agentId: h.agentId ?? null,
      license: h.license ?? null,
      sitePublicKey: h.sitePublicKey && !h.sitePublicKey.includes('BEGIN') ? rel(h.sitePublicKey) : h.sitePublicKey ?? null,
      tlsPinSha256: h.tlsPinSha256 || null,
      allow,
    };
  });

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
    showWindow: false,
    // Управлять процессом (перехват запущенного сервера, автоподъём, рестарты по расписанию) — только если
    // хоть одному сайту разрешены старт/стоп. Агент покупателя LX (allow: lx.*) сервер только наблюдает:
    // иначе он поднял бы упавший сервер своей строкой запуска, без модов из батника/панели.
    manage: hubs.some((h) => h.allow.some((a) => a === '*' || a === 'server.*' || /^server\.(start|stop|restart|restartIn|setSchedule)$/.test(a))),
    ...cfg.server,
  };
  server.dir = rel(server.dir);

  const fileDefaults = {
    extensions: ['.cfg', '.xml', '.json', '.txt'],
    deny: ['beserver', 'battleye', 'keys', '.exe', '.dll', '.bikey'],
    maskedCfgKeys: ['passwordAdmin'],
    maxSizeMb: 10,
    keepBackups: 50,
  };
  const backupDir = rel(cfg.files?.backupDir ?? './backups');
  const absRoots = (roots) => Object.fromEntries(Object.entries(roots ?? {}).map(([k, v]) => [k, rel(v)]));

  const files = { ...fileDefaults, ...cfg.files, backupDir };
  files.roots = absRoots(files.roots ?? { server: server.dir });

  // Папки конфигов модов LX — единственное, что видит сайт LX.
  const lx = {
    modPrefix: '@LX',
    ...cfg.lx,
    files: { ...fileDefaults, ...cfg.lx?.files, backupDir: path.join(backupDir, '_lx') },
  };
  lx.files.roots = absRoots(cfg.lx?.roots ?? { lx: path.join(server.dir, server.profiles, 'LX') });

  if (cfg.schedule?.timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: cfg.schedule.timeZone });
    } catch {
      throw new Error(`config.json: schedule.timeZone — часовой пояс вида "Europe/Moscow", получено: ${cfg.schedule.timeZone}`);
    }
  }

  return {
    allowInsecureForDev: Boolean(cfg.allowInsecureForDev),
    hubs,
    server,
    files,
    lx,
    // Рестарт: предупреждения за warnMinutes, затем за kick.beforeMinutes до времени рестарта —
    // предупреждение за kick.warnSeconds, #lock, кик всех и остановка с запуском. kick: null — без кика, рестарт ровно в срок.
    schedule: {
      restarts: [],
      warnMinutes: [30, 15, 5, 3],
      warnMessage: 'Рестарт сервера через {min} мин.',
      timeZone: 'Europe/Moscow',
      ...cfg.schedule,
      kick:
        cfg.schedule?.kick === null
          ? null
          : {
              beforeMinutes: 2,
              warnSeconds: 30,
              warnMessage: 'Через {sec} сек. все игроки будут отключены: рестарт сервера.',
              reason: 'Рестарт сервера',
              ...cfg.schedule?.kick,
            },
    },
    rcon: { host: '127.0.0.1', port: null, allowRaw: false, ...cfg.rcon },
    logs: {
      extensions: ['.rpt', '.adm', '.log'],
      ...cfg.logs,
      dir: cfg.logs?.dir ? rel(cfg.logs.dir) : path.join(server.dir, server.profiles),
    },
    steamcmd: cfg.steamcmd ? { ...cfg.steamcmd, path: rel(cfg.steamcmd.path) } : null,
    keysDir: rel(cfg.keysDir ?? './keys'),
    stateFile: rel(cfg.stateFile ?? './state.json'),
    auditLog: rel(cfg.auditLog ?? './audit.log'),
  };
}

export function isAllowed(allow, action) {
  return allow.some((p) => p === '*' || p === action || (p.endsWith('.*') && action.startsWith(p.slice(0, -1))));
}

// Пароль и порт RCon читаются прямо из конфига BattlEye — вписывать их ещё куда-то не нужно.
// Панели хостингов раскладывают их по разным файлам (ark-hoster: пароль в battleye\BEServer_x64.cfg
// устаревший, действующий — в BEServer_x64_active_*.cfg, RConPort — только в active и profiles\BattlEye).
// Первым идёт самый свежий active: его BattlEye создаёт при запуске из того, с чем реально работает.
// passwords — все найденные пароли по этому порядку: RCon перебирает их, если первый не подошёл.
export function readBattlEyeConfig(server) {
  const dirs = [path.resolve(server.dir, server.bePath), path.join(server.dir, server.profiles, 'BattlEye')];
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((name) => /^beserver_x64(_active_\w+)?\.cfg$/i.test(name))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      files.push({
        active: /_active_/i.test(f),
        mtime: fs.statSync(path.join(dir, f)).mtimeMs,
        password: /^\s*RConPassword\s+(\S+)/im.exec(text)?.[1] ?? null,
        port: Number(/^\s*RConPort\s+(\d+)/im.exec(text)?.[1]) || null,
      });
    }
  }
  files.sort((a, b) => Number(b.active) - Number(a.active) || b.mtime - a.mtime);
  const passwords = [...new Set(files.map((f) => f.password).filter(Boolean))];
  if (!passwords.length) return { password: null, port: null, passwords };
  const withPassword = files.find((f) => f.password);
  const port = withPassword.port ?? files.find((f) => f.port)?.port ?? null;
  return { password: passwords[0], port, passwords };
}
