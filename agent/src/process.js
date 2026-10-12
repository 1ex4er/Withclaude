// Управление процессом DayZServer_x64.exe: старт, стоп, рестарт, автоподъём после падения,
// рестарты по расписанию с предупреждениями игроков.

import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentError } from './errors.js';

const run = promisify(execFile);
const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOD_NAME = /^@[\w.\- ]{1,64}$/;

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
    const args = [
      `-config=${this.cfg.config}`,
      `-port=${this.cfg.port}`,
      `-profiles=${this.cfg.profiles}`,
      `-BEpath=${this.cfg.bePath}`,
      ...this.cfg.extraArgs,
    ];
    if (mods.length) args.push(`-mod=${mods.join(';')}`);
    if (serverMods.length) args.push(`-serverMod=${serverMods.join(';')}`);
    return args;
  }

  async isAlive(pid = this.pid) {
    if (!pid) return false;
    if (isWin) {
      try {
        const { stdout } = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
        return stdout.toLowerCase().includes(this.cfg.exe.toLowerCase());
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

  // Если сервер уже запущен (например, раньше через .bat) — берём его под управление
  // (или, при manage = false, только под наблюдение: статус и RCon).
  async adopt() {
    if (await this.isAlive()) return this.pid;
    if (!isWin) return null;
    try {
      const { stdout } = await run('tasklist', ['/FI', `IMAGENAME eq ${this.cfg.exe}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
      const m = /^"[^"]+","(\d+)"/m.exec(stdout);
      if (m) {
        this.#setPid(Number(m[1]), this.startedAt ?? Date.now());
        if (this.cfg.manage !== false) this.state.set('desired', 'running');
        return this.pid;
      }
    } catch {}
    return null;
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
    if (!fs.existsSync(this.exePath)) throw new AgentError('not_found', `Не найден ${this.exePath}`);
    const child = spawn(this.exePath, this.buildArgs(), {
      cwd: this.cfg.dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
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
    const alive = (await this.isAlive()) || (!this.cfg.manage && (await this.adopt()) !== null);

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

    await this.#scheduleTick(alive);
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
    return { at: this.nextRestart };
  }

  cancelPlannedRestart() {
    this.manualRestart = false;
    this.nextRestart = null;
    this.warned.clear();
  }

  #computeNext(now = new Date()) {
    let best = null;
    for (const t of this.getSchedule()) {
      const [h, m] = t.split(':').map(Number);
      const d = new Date(now);
      d.setHours(h, m, 0, 0);
      if (d <= now) d.setDate(d.getDate() + 1);
      if (!best || d < best) best = d;
    }
    return best ? best.getTime() : null;
  }

  async #scheduleTick(alive) {
    if (!this.manualRestart) {
      const next = this.#computeNext();
      if (next !== this.nextRestart) {
        this.nextRestart = next;
        this.warned.clear();
      }
    }
    if (!this.nextRestart || !alive) return;
    const left = this.nextRestart - Date.now();
    for (const w of this.schedule.warnMinutes) {
      if (left <= w * 60_000 && left > 0 && !this.warned.has(w)) {
        this.warned.add(w);
        const text = this.schedule.warnMessage.replace('{min}', String(w));
        this.rcon.command(`say -1 ${text}`).catch(() => {});
      }
    }
    if (left <= 0) {
      this.manualRestart = false;
      this.nextRestart = null;
      this.log.info('плановый рестарт');
      await this.restart().catch((e) => this.log.error(`плановый рестарт не удался: ${e.message}`));
    }
  }
}
