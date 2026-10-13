// Точка входа lx-agent.exe (и `node agent/src/main.js` при запуске из исходников).
//
//   lx-agent.exe init --server-dir C:\DayZServer --license LX-XXXX-XXXX     покупатель модов LX
//   lx-agent.exe init --server-dir C:\DayZServer --site-url wss://… --site-key site_public.pem --agent-id blackout-main
//   lx-agent.exe pubkey        показать публичный ключ агента (для подключения к своему сайту)
//   lx-agent.exe install [--user .\dayzagent --password …]   автозапуск при загрузке Windows
//   lx-agent.exe install --interactive   при входе текущего пользователя: окна агента и сервера видны (нужен вход по RDP)
//   lx-agent.exe uninstall
//   lx-agent.exe run           запуск в этом окне (по умолчанию)
//   lx-agent.exe update        скачать новую версию с lxmodschngz.ru и перезапустить агента (сервер не трогается)
//   lx-agent.exe version

import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from './agent.js';
import { DEFAULT_ALLOW } from './config.js';
import { fingerprint, loadOrCreateAgentKey } from './keys.js';
import { IS_EXE, VERSION, appDir } from './paths.js';
import { install, uninstall } from './service.js';

const LX_HUB_URL = 'wss://lxmodschngz.ru/agent-ws';
const UPDATE_URL = 'https://lxmodschngz.ru/lx-agent.exe';

// lx-agent.exe update: скачать новую версию, подменить файл (работающий exe Windows разрешает переименовать),
// остановить старого агента и запустить задачу «LX Agent» заново. DayZ-сервер при этом продолжает работать.
async function selfUpdate(url) {
  if (!IS_EXE || process.platform !== 'win32') throw new Error('update работает только у собранного lx-agent.exe на Windows');
  const exe = process.execPath;
  const dir = path.dirname(exe);
  console.log(`Скачиваю ${url} …`);
  const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`не удалось скачать: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length < 5 * 1024 * 1024 || data[0] !== 0x4d || data[1] !== 0x5a) throw new Error('скачанный файл не похож на lx-agent.exe');
  const fresh = path.join(dir, 'lx-agent.new.exe');
  const old = path.join(dir, 'lx-agent.old.exe');
  fs.writeFileSync(fresh, data);
  fs.rmSync(old, { force: true });
  fs.renameSync(exe, old);
  fs.renameSync(fresh, exe);
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync('taskkill', ['/F', '/IM', 'lx-agent.exe', '/FI', `PID ne ${process.pid}`], { stdio: 'ignore', windowsHide: true });
  } catch {}
  try {
    execFileSync('schtasks.exe', ['/Run', '/TN', 'LX Agent'], { stdio: 'ignore', windowsHide: true });
    console.log(`Готово: новая версия (${(data.length / 1048576).toFixed(1)} МБ) запущена. Журнал: ${path.join(dir, 'agent.log')}`);
  } catch {
    console.log('Файл обновлён. Задачи «LX Agent» нет — запусти агента сам: lx-agent.exe run');
  }
}

function parseArgs(argv) {
  const [command = 'run', ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([a-z-]+)$/.exec(rest[i]);
    if (!m) throw new Error(`Непонятный аргумент: ${rest[i]}`);
    opts[m[1]] = rest[i + 1] === undefined || rest[i + 1].startsWith('--') ? true : rest[++i];
  }
  return { command, opts };
}

function init(dir, opts) {
  const configPath = path.join(dir, 'config.json');
  if (fs.existsSync(configPath) && !opts.force) throw new Error(`${configPath} уже есть (--force, чтобы перезаписать)`);
  if (typeof opts['server-dir'] !== 'string') throw new Error('Укажи --server-dir <папка DayZ-сервера>');
  const serverDir = path.resolve(opts['server-dir']);
  if (!fs.existsSync(path.join(serverDir, 'DayZServer_x64.exe'))) {
    console.warn(`Внимание: в ${serverDir} нет DayZServer_x64.exe`);
  }

  const roots = { server: serverDir };
  const serverCfg = path.join(serverDir, 'serverDZ.cfg');
  if (fs.existsSync(serverCfg)) {
    const template = /^\s*template\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(serverCfg, 'utf8'))?.[1];
    if (template && fs.existsSync(path.join(serverDir, 'mpmissions', template))) {
      roots.mission = path.join(serverDir, 'mpmissions', template);
    }
  }

  const hubs = [];
  if (opts['site-url']) {
    if (!opts['site-key'] || !opts['agent-id']) throw new Error('Для своего сайта нужны ещё --site-key и --agent-id');
    const keysDir = path.join(dir, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    fs.copyFileSync(path.resolve(opts['site-key']), path.join(keysDir, 'site_public.pem'));
    hubs.push({ name: 'site', url: opts['site-url'], agentId: opts['agent-id'], sitePublicKey: 'keys/site_public.pem', allow: DEFAULT_ALLOW.full });
  }
  if (opts.license) {
    hubs.push({ name: 'lx', url: LX_HUB_URL, license: opts.license, allow: DEFAULT_ALLOW.lx });
  }
  if (!hubs.length) throw new Error('Укажи --license (покупатель LX) и/или --site-url (свой сайт)');

  const config = {
    hubs,
    server: { dir: serverDir, mods: [], serverMods: [] },
    files: { roots },
    schedule: { restarts: [] },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const key = loadOrCreateAgentKey(path.join(dir, 'keys'));
  console.log(`Создан ${configPath}`);
  console.log(`Ключ агента: ${fingerprint(key.publicPem)}`);
  for (const h of hubs) console.log(`  сайт ${h.name}: ${h.url}, разрешено: ${h.allow.join(', ')}`);
  console.log('Дальше: проверь config.json, запусти "lx-agent.exe run", затем "lx-agent.exe install".');
}

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  const dir = appDir();
  const configPath = typeof opts.config === 'string' ? path.resolve(opts.config) : path.join(dir, 'config.json');

  switch (command) {
    case 'run':
      if (!fs.existsSync(configPath)) throw new Error(`Нет ${configPath}. Сначала выполни: lx-agent.exe init --server-dir <папка> --license <ключ>`);
      return runAgent(configPath);
    case 'init':
      return init(path.dirname(configPath), opts);
    case 'pubkey': {
      const key = loadOrCreateAgentKey(path.join(path.dirname(configPath), 'keys'));
      console.log(key.publicPem.trim());
      console.log(`Отпечаток: ${fingerprint(key.publicPem)}\nФайл: ${key.pubFile}`);
      return;
    }
    case 'install': {
      loadOrCreateAgentKey(path.join(dir, 'keys'));
      const runArgs = IS_EXE ? 'run' : `"${path.join(dir, 'src', 'main.js')}" run`;
      // В сеансе пользователя агент работает без своего окна (conhost --headless): клик в консоль включал
      // «Выделение» и замораживал агента. Окно DayZ-сервера — собственное окно сервера, оно остаётся видимым.
      const headless = opts.interactive === true;
      install({
        exe: headless ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe') : process.execPath,
        args: headless ? `--headless "${process.execPath}" ${runArgs}` : runArgs,
        workDir: dir,
        user: opts.user,
        password: opts.password,
        interactive: opts.interactive === true,
      });
      console.log(
        opts.interactive === true
          ? 'Агент работает без окна при входе этого пользователя, окно DayZ-сервера — на рабочем столе. Из сеанса не выходи — просто закрывай RDP. Журнал: agent.log'
          : 'Агент добавлен в автозапуск и запущен (Планировщик заданий → "LX Agent"). Журнал: agent.log',
      );
      return;
    }
    case 'uninstall':
      uninstall();
      console.log('Агент убран из автозапуска.');
      return;
    case 'version':
    case '--version':
      console.log(VERSION);
      return;
    case 'update':
      await selfUpdate(typeof opts.url === 'string' ? opts.url : UPDATE_URL);
      return;
    default:
      throw new Error(`Неизвестная команда: ${command}. Доступно: init, run, pubkey, install, uninstall, update, version`);
  }
}

main().catch((e) => {
  console.error(`Ошибка: ${e.message}`);
  process.exit(1);
});
