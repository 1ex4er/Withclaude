// Управление процессом DayZServer_x64.exe: старт, стоп, рестарт, автоподъём после падения,
// рестарты по расписанию с предупреждениями игроков.

import { execFile, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentError } from './errors.js';
import { parsePlayers } from './rcon.js';

const run = promisify(execFile);
const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Календарная дата и время в часовом поясе tz (IANA, например Europe/Moscow).
function zonedDate(ms, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(ms)
      .map((p) => [p.type, Number(p.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

// Момент, когда в поясе tz на часах {year, month, day, hour, minute} (day может выходить за месяц — Date.UTC перенесёт).
function zonedToEpoch({ year, month, day, hour, minute }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const seen = zonedDate(guess, tz);
  const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - guess;
  return guess - offset;
}

// Из списка процессов (Win32_Process: ProcessId, ExecutablePath, ThreadCount, Created) — самый свежий из папки сервера, без зависших.
// Если путь не виден (нет прав на чужой процесс), процесс всё равно годится: имя exe уже совпало.
export function pickServerProcess(list, exePath, zombies = new Set()) {
  const want = path.resolve(exePath).toLowerCase();
  const candidates = list
    .filter((p) => p && Number.isInteger(p.ProcessId) && !zombies.has(p.ProcessId))
    // 0 потоков — процесс уже завершился, но Windows держит его в списке (открытые дескрипторы): это не сервер.
    .filter((p) => p.ThreadCount === undefined || p.ThreadCount === null || p.ThreadCount > 0)
    .filter((p) => !p.ExecutablePath || path.resolve(p.ExecutablePath).toLowerCase() === want)
    .map((p) => ({ pid: p.ProcessId, startedAt: p.Created ? Date.parse(p.Created) || null : null }))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return candidates[0] ?? null;
}

// Занят ли UDP-порт (игровой порт DayZ): пробуем занять его сами и сразу отпускаем.
export function udpPortBusy(port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', (e) => {
      sock.close();
      resolve(e.code === 'EADDRINUSE' || e.code === 'EACCES');
    });
    sock.bind({ port, address: '0.0.0.0', exclusive: true }, () => sock.close(() => resolve(false)));
  });
}

// Пробелы и скобки встречаются в названиях модов Workshop ("@STALKER NewHorizon Objects (Legacy)").
const MOD_NAME = /^@[\w.\-() ]{1,64}$/;

export class ServerProcess extends EventEmitter {
  constructor({ cfg, state, rcon, log }) {
    super();
    this.cfg = cfg.server;
    this.schedule = cfg.schedule;
    this.state = state;
    this.rcon = rcon;
    this.log = log;
    this.pid = state.get('pid', null);
    this.startedAt = state.get('startedAt', null);
    this.busy = null; // текущая операция: 'start' | 'stop' | 'restart'
    this.crashes = [];
    this.nextRestart = null;
    this.warned = new Set();
    this.kickWarnedAt = null;
    this.zombies = new Set(state.get('zombies', []));
    this.checkedThreads = new Map();
  }

  get exePath() {
    return path.join(this.cfg.dir, this.cfg.exe);
  }

  mods() {
    return {
      mods: this.state.get('mods', this.cfg.mods),
      serverMods: this.state.get('serverMods', this.cfg.serverMods),
    };
  }

  setMods({ mods, serverMods }) {
    for (const list of [mods, serverMods]) {
      if (!Array.isArray(list) || list.length > 100) throw new AgentError('bad_params', 'Ожидается список модов');
      for (const m of list) {
        if (typeof m !== 'string' || !MOD_NAME.test(m)) throw new AgentError('bad_params', `Недопустимое имя мода: ${m}`);
        if (!fs.existsSync(path.join(this.cfg.dir, m))) throw new AgentError('not_found', `Папка мода не найдена: ${m}`);
      }
    }
    this.state.set('mods', mods);
    this.state.set('serverMods', serverMods);
    return { ...this.mods(), appliesOn: 'next_restart' };
  }

  // Строка запуска собирается только из конфига агента и проверенного списка модов.
  buildArgs() {
    const { mods, serverMods } = this.mods();
    // Полные пути, как у панелей хостинга: относительный -BEpath DayZ ищет не от папки сервера,
    // и BattlEye брал чужой BEServer_x64.cfg (без пароля — RCon не включался).
    const abs = (p) => path.resolve(this.cfg.dir, p);
    const args = [
      `-config=${abs(this.cfg.config)}`,
      `-port=${this.cfg.port}`,
      `-profiles=${abs(this.cfg.profiles)}`,
      `-BEpath=${abs(this.cfg.bePath)}`,
      ...this.cfg.extraArgs,
    ];
    if (mods.length) args.push(`-mod=${mods.join(';')}`);
    if (serverMods.length) args.push(`-serverMod=${serverMods.join(';')}`);
    return args;
  }

  async isAlive(pid = this.pid) {
    if (!pid) return false;
    if (this.zombies.has(pid)) return false;
    if (isWin) {
      try {
        const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
        if (!stdout.toLowerCase().includes(this.cfg.exe.toLowerCase())) return false;
        // Раз в минуту — проверка, что у процесса есть потоки (иначе это зависший «мертвец»).
        if (Date.now() - (this.checkedThreads.get(pid) ?? 0) > 60_000) {
          if (!(await this.#hasThreads(pid))) {
            this.#markZombie(pid);
            return false;
          }
          this.checkedThreads.set(pid, Date.now());
        }
        return true;
      } catch {
        return false;
      }
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async #hasThreads(pid) {
    try {
      const { stdout } = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ThreadCount`],
        { windowsHide: true, timeout: 20_000 },
      );
      const n = Number(stdout.trim());
      return stdout.trim() === '' ? false : !(n === 0);
    } catch {
      return true; // не смогли проверить — не объявляем мёртвым
    }
  }

  #markZombie(pid) {
    if (this.zombies.has(pid)) return;
    this.zombies.add(pid);
    this.state.set('zombies', [...this.zombies].slice(-50));
    this.log.warn(`процесс ${pid} завис или уже завершён (не считается сервером)`);
  }

  // Если сервер уже запущен (например, раньше через .bat) — берём его под управление
  // (или, при manage = false, только под наблюдение: статус и RCon).
  //
  // На Windows бывают «мёртвые» DayZServer_x64.exe — процессы прошлых запусков, которые не завершаются даже
  // через taskkill /F. Поэтому берётся самый свежий процесс из папки этого сервера, а зависшие (не убились
  // при остановке) запоминаются в state.zombies и больше не считаются сервером.
  async adopt() {
    const found = await this.findServerProcess();
    if (found) {
      if (found.pid !== this.pid) this.#setPid(found.pid, found.startedAt ?? Date.now());
      // Сервер работает и он наш: после перезапуска агента автоподъём должен остаться включённым.
      if (this.cfg.manage !== false) this.state.set('desired', 'running');
      return this.pid;
    }
    if (!isWin && (await this.isAlive())) return this.pid;
    return null;
  }

  // Самый свежий живой процесс сервера: только exe из папки сервера (не другой DayZ на этой машине), без зависших.
  async findServerProcess() {
    if (!isWin) return null;
    const exe = this.cfg.exe.replace(/'/g, "''");
    const ps =
      `Get-CimInstance Win32_Process -Filter "Name='${exe}'" | ` +
      "Select-Object ProcessId,ExecutablePath,ThreadCount,@{n='Created';e={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
    try {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 });
      const list = stdout.trim() ? [].concat(JSON.parse(stdout)) : [];
      return pickServerProcess(list, this.exePath, this.zombies);
    } catch (e) {
      this.log.warn(`поиск процесса сервера: ${e.message}`);
      return null;
    }
  }

  #setPid(pid, startedAt) {
    this.pid = pid;
    this.startedAt = startedAt;
    this.state.set('pid', pid);
    this.state.set('startedAt', startedAt);
  }

  async status() {
    const running = await this.isAlive();
    return {
      running,
      pid: running ? this.pid : null,
      startedAt: running ? this.startedAt : null,
      busy: this.busy,
      desired: this.state.get('desired', 'stopped'),
      manage: this.cfg.manage !== false,
      rcon: this.rcon.connected,
      ...this.mods(),
      nextRestart: this.nextRestart,
      schedule: this.getSchedule(),
    };
  }

  async start() {
    return this.#exclusive('start', () => this.#startInner());
  }

  async #startInner() {
    this.state.set('desired', 'running');
    if (await this.isAlive()) return { alreadyRunning: true, pid: this.pid };
    // Сервер мог запустить кто-то другой (панель хостинга, батник): второй на тех же файлах поднимать нельзя.
    const other = await this.findServerProcess();
    if (other) {
      this.#setPid(other.pid, other.startedAt ?? Date.now());
      this.log.warn(`сервер уже запущен не агентом (pid ${other.pid}) — взят под управление`);
      return { alreadyRunning: true, pid: other.pid };
    }
    // Последний рубеж: игровой порт занят — значит, сервер уже работает (другой агент, панель, вручную).
    if (await udpPortBusy(this.cfg.port)) {
      throw new AgentError('already_running', `Порт ${this.cfg.port} уже занят — сервер уже запущен, второй не запускаю`);
    }
    if (!fs.existsSync(this.exePath)) throw new AgentError('not_found', `Не найден ${this.exePath}`);
    const child = spawn(this.exePath, this.buildArgs(), {
      cwd: this.cfg.dir,
      detached: true,
      stdio: 'ignore',
      // showWindow — окно консоли DayZ на рабочем столе (видно, только если агент запущен в сеансе пользователя).
      windowsHide: !this.cfg.showWindow,
    });
    child.unref();
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (e) => reject(new AgentError('start_failed', e.message)));
    });
    this.#setPid(child.pid, Date.now());
    this.log.info(`сервер запущен, pid ${child.pid}`);
    this.emit('change', 'started');
    return { pid: child.pid };
  }

  async stop({ graceful = true } = {}) {
    return this.#exclusive('stop', () => this.#stopInner(graceful));
  }

  async #stopInner(graceful) {
    this.state.set('desired', 'stopped');
    if (!(await this.isAlive())) return { alreadyStopped: true };
    if (graceful) {
      try {
        await this.rcon.command('#shutdown');
        const deadline = Date.now() + this.cfg.stopTimeoutSec * 1000;
        while (Date.now() < deadline && (await this.isAlive())) await sleep(1000);
      } catch (e) {
        this.log.warn(`мягкая остановка не удалась: ${e.message}`);
      }
    }
    if (await this.isAlive()) await this.#kill();
    this.rcon.close();
    // Не умер даже от taskkill /F — зависший процесс: больше не считаем его сервером.
    if (await this.isAlive()) this.#markZombie(this.pid);
    this.log.info('сервер остановлен');
    this.emit('change', 'stopped');
    return { stopped: true };
  }

  async #kill() {
    if (isWin) {
      await run('taskkill', ['/PID', String(this.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
    } else {
      try {
        process.kill(this.pid, 'SIGKILL');
      } catch {}
    }
    for (let i = 0; i < 10 && (await this.isAlive()); i++) await sleep(500);
  }

  // beforeStart — действие между остановкой и запуском (например, обновление модов).
  // Если оно упало, сервер всё равно поднимается, а ошибка возвращается в ответе.
  async restart({ beforeStart } = {}) {
    return this.#exclusive('restart', async () => {
      await this.#stopInner(true);
      let beforeStartError = null;
      if (beforeStart) {
        try {
          await beforeStart();
        } catch (e) {
          beforeStartError = e.message;
          this.log.error(`перед запуском: ${e.message}`);
        }
      }
      return { ...(await this.#startInner()), beforeStartError };
    });
  }

  async #exclusive(name, fn) {
    if (this.busy) throw new AgentError('busy', `Выполняется операция: ${this.busy}`);
    this.busy = name;
    try {
      return await fn();
    } finally {
      this.busy = null;
    }
  }

  // ---------- Слежение за процессом и расписание ----------

  startWatchdog() {
    this.timer = setInterval(() => this.#tick().catch((e) => this.log.error(`watchdog: ${e.message}`)), 5000);
  }

  stopWatchdog() {
    clearInterval(this.timer);
  }

  async #tick() {
    if (this.busy) return;
    const desired = this.state.get('desired', 'stopped');
    let alive = await this.isAlive();
    // Сервер запустили не мы (панель, батник) — подхватываем, но ищем не чаще раза в 30 с: это вызов PowerShell.
    if (!alive && !this.cfg.manage && Date.now() - (this.lastAdoptAt ?? 0) > 30_000) {
      this.lastAdoptAt = Date.now();
      alive = (await this.adopt()) !== null;
    }

    // Режим наблюдения: сервер запускает панель хостинга/батник, агент только подключает RCon.
    if (!this.cfg.manage) {
      if (alive && !this.rcon.connected) this.rcon.connect().catch(() => {});
      return;
    }

    if (desired === 'running' && !alive) {
      this.log.warn('сервер упал');
      this.rcon.close();
      this.emit('change', 'crashed');
      const now = Date.now();
      this.crashes = this.crashes.filter((t) => now - t < 10 * 60_000).concat(now);
      if (!this.cfg.autoRestartOnCrash) {
        this.state.set('desired', 'stopped');
      } else if (this.crashes.length > 5) {
        this.log.error('сервер падает слишком часто — автоподъём отключён до ручного старта');
        this.state.set('desired', 'stopped');
        this.emit('change', 'crash_loop');
      } else {
        await this.start().catch((e) => this.log.error(`автоподъём не удался: ${e.message}`));
      }
      return;
    }

    if (alive && !this.rcon.connected && this.startedAt && Date.now() - this.startedAt > 60_000) {
      this.rcon.connect().catch(() => {});
    }

    await this.scheduleStep(alive);
  }

  getSchedule() {
    return this.state.get('schedule', this.schedule.restarts);
  }

  setSchedule(times) {
    if (!Array.isArray(times) || times.length > 48) throw new AgentError('bad_params', 'Ожидается список времени');
    for (const t of times) {
      if (typeof t !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) {
        throw new AgentError('bad_params', `Время в формате ЧЧ:ММ, получено: ${t}`);
      }
    }
    this.state.set('schedule', [...new Set(times)].sort());
    this.nextRestart = null;
    return this.getSchedule();
  }

  // Разовый рестарт через N минут с предупреждениями.
  restartIn(minutes) {
    this.nextRestart = Date.now() + minutes * 60_000;
    this.manualRestart = true;
    this.warned.clear();
    this.kickWarnedAt = null;
    return { at: this.nextRestart };
  }

  cancelPlannedRestart() {
    this.manualRestart = false;
    this.nextRestart = null;
    this.warned.clear();
    this.kickWarnedAt = null;
  }

  // Ближайший рестарт, до которого ещё не дошёл кик (lead): после рестарта в 15:58 «16:00» уже выполнен.
  // Время в расписании — по schedule.timeZone (по умолчанию МСК), часовой пояс самой Windows не важен.
  #computeNext(now = new Date()) {
    const lead = this.schedule.kick ? this.schedule.kick.beforeMinutes * 60_000 : 0;
    const tz = this.schedule.timeZone;
    const today = zonedDate(now.getTime(), tz);
    let best = null;
    for (const t of this.getSchedule()) {
      const [h, m] = t.split(':').map(Number);
      for (const dayShift of [0, 1]) {
        const at = zonedToEpoch({ ...today, day: today.day + dayShift, hour: h, minute: m }, tz);
        if (at - lead > now.getTime()) {
          if (best === null || at < best) best = at;
          break;
        }
      }
    }
    return best;
  }

  #say(text) {
    return this.rcon.command(`say -1 ${text}`).catch(() => {});
  }

  // Шаг расписания (вызывается раз в 5 с; now — для тестов).
  // Следующий плановый рестарт считается один раз и держится, пока не выполнится: иначе в момент
  // рестарта пересчёт отдал бы «завтра» и рестарт бы пропал. setSchedule и сам рестарт его сбрасывают.
  async scheduleStep(alive, now = Date.now()) {
    if (!this.manualRestart && this.nextRestart === null) {
      this.nextRestart = this.#computeNext(new Date(now));
      this.warned.clear();
      this.kickWarnedAt = null;
    }
    if (!this.nextRestart || !alive) return;

    const kick = this.schedule.kick;
    const restartAt = kick ? this.nextRestart - kick.beforeMinutes * 60_000 : this.nextRestart;
    const left = this.nextRestart - now;

    // Наступившие пороги объявляются одним сообщением с настоящим остатком:
    // «рестарт через 5 мин» не превращается в серию «через 30… 15… 5».
    const due = this.schedule.warnMinutes.filter((w) => left <= w * 60_000 && !this.warned.has(w));
    if (due.length && left > 0) {
      for (const w of due) this.warned.add(w);
      await this.#say(this.schedule.warnMessage.replace('{min}', String(Math.ceil(left / 60_000))));
    }

    if (kick) {
      const warnAt = restartAt - kick.warnSeconds * 1000;
      if (now >= warnAt && this.kickWarnedAt === null) {
        this.kickWarnedAt = now;
        await this.#say(kick.warnMessage.replace('{sec}', String(kick.warnSeconds)));
      }
      // Кик не раньше чем через warnSeconds после предупреждения (важно для «рестарт через 1 мин»).
      if (now < restartAt || this.kickWarnedAt === null || now - this.kickWarnedAt < kick.warnSeconds * 1000) return;
    } else if (now < restartAt) {
      return;
    }

    this.manualRestart = false;
    this.nextRestart = null;
    this.log.info('плановый рестарт');
    if (kick) await this.#kickAll(kick.reason);
    await this.restart().catch((e) => this.log.error(`плановый рестарт не удался: ${e.message}`));
  }

  // Закрыть вход и отключить всех перед остановкой (сохранение мира делает #shutdown при остановке).
  async #kickAll(reason) {
    try {
      await this.rcon.command('#lock');
      const players = parsePlayers(await this.rcon.command('players'));
      for (const p of players) await this.rcon.command(`kick ${p.id} ${reason}`).catch(() => {});
      this.log.info(`перед рестартом отключено игроков: ${players.length}`);
    } catch (e) {
      this.log.warn(`кик перед рестартом не удался: ${e.message}`);
    }
  }
}
