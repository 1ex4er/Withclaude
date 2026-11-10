// Моды сервера: список папок @Mod, установка и обновление из Steam Workshop через SteamCMD.
//
// SteamCMD качает в свой кэш (steamcmd\steamapps\workshop\content\221100\<id>), агент копирует оттуда
// в папку сервера вместе с ключами. Пока сервер работает, его pbo заняты: обновление скачивается сразу,
// а копируется перед ближайшим запуском (applyPending вызывается при каждом старте сервера).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentError } from './errors.js';

const run = promisify(execFile);
const DAYZ_APP_ID = '221100';
// Пробелы и скобки встречаются в названиях модов Workshop ("@STALKER NewHorizon Objects (Legacy)").
export const MOD_FOLDER = /^@[\w.\-() ]{1,64}$/;
const WORKSHOP_ID = /^\d{6,12}$/;
const MAX_JOBS = 20;

export function readMeta(modDir) {
  const meta = path.join(modDir, 'meta.cpp');
  if (!fs.existsSync(meta)) return {};
  const text = fs.readFileSync(meta, 'utf8');
  return {
    name: /^\s*name\s*=\s*"([^"]*)"/m.exec(text)?.[1] ?? null,
    publishedId: /^\s*publishedid\s*=\s*(\d+)/m.exec(text)?.[1] ?? null,
    timestamp: Number(/^\s*timestamp\s*=\s*(-?\d+)/m.exec(text)?.[1]) || null,
  };
}

// Когда файлы мода последний раз менялись (meta.cpp и addons\*.pbo): по этому сравниваются
// дата в Workshop и копия на сервере, и решается, надо ли копировать скачанное.
export function filesUpdatedAt(modDir) {
  let latest = 0;
  const stamp = (file) => {
    try {
      latest = Math.max(latest, fs.statSync(file).mtimeMs);
    } catch {}
  };
  stamp(path.join(modDir, 'meta.cpp'));
  const addons = path.join(modDir, 'addons');
  try {
    for (const f of fs.readdirSync(addons)) if (/\.pbo$/i.test(f)) stamp(path.join(addons, f));
  } catch {}
  return latest ? Math.round(latest) : null;
}

// Имя папки для нового мода: "@" + название из meta.cpp, только разрешённые символы.
export function folderNameFor(name, id) {
  const clean = String(name ?? '')
    .replace(/[^\w.\-() ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return clean.length >= 2 ? `@${clean}` : `@${id}`;
}

export class ModManager {
  // state — StateStore агента: там хранятся обновления, которые ждут остановки сервера.
  constructor({ serverDir, steamcmd, steamUser, log, state, runImpl = run }) {
    this.serverDir = serverDir;
    this.steamcmd = steamcmd;
    this.steamUser = steamUser;
    this.log = log;
    this.state = state;
    this.run = runImpl;
    this.jobs = [];
    // SteamCMD один на всех: загрузки идут строго по очереди.
    this.queue = Promise.resolve();
  }

  get configured() {
    return Boolean(this.steamcmd?.path && this.steamUser);
  }

  list(enabled) {
    const on = new Set([...enabled.mods, ...enabled.serverMods]);
    const pending = new Set(this.pending());
    return fs
      .readdirSync(this.serverDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('@'))
      .map((e) => ({
        folder: e.name,
        enabled: on.has(e.name),
        serverSide: enabled.serverMods.includes(e.name),
        pendingUpdate: pending.has(e.name),
        ...readMeta(path.join(this.serverDir, e.name)),
        filesUpdatedAt: filesUpdatedAt(path.join(this.serverDir, e.name)),
      }));
  }

  // Из списка включённых модов — только те, что из Workshop (у локальных нет publishedid).
  workshopOnly(folders) {
    return folders.filter((f) => readMeta(path.join(this.serverDir, f)).publishedId);
  }

  pending() {
    return this.state?.get('mods.pending', []) ?? [];
  }

  #setPending(list) {
    this.state?.set('mods.pending', [...new Set(list)]);
  }

  #requireSteam() {
    if (!this.steamcmd?.path) throw new AgentError('unconfigured', 'steamcmd.path не задан в config.json агента');
    if (!this.steamUser) throw new AgentError('unconfigured', 'STEAM_USER не задан в .env агента');
  }

  #contentDir(id) {
    return path.join(path.dirname(this.steamcmd.path), 'steamapps', 'workshop', 'content', DAYZ_APP_ID, id);
  }

  #folderOf(folder) {
    if (typeof folder !== 'string' || !MOD_FOLDER.test(folder)) throw new AgentError('bad_params', `Недопустимое имя мода: ${folder}`);
    const id = readMeta(path.join(this.serverDir, folder)).publishedId;
    if (!id) throw new AgentError('bad_params', `${folder}: в meta.cpp нет publishedid — мод не из Workshop`);
    return { folder, id };
  }

  #enqueue(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  // SteamCMD: скачать (или докачать обновление) моды в кэш. Без validate: он перечитывает гигабайты
  // при каждом рестарте; SteamCMD и так качает только то, что изменилось. Не скачавшиеся — второй попыткой.
  async #download(ids, timeoutMs) {
    const attempt = async (list) => {
      const args = ['+login', this.steamUser];
      for (const id of list) args.push('+workshop_download_item', DAYZ_APP_ID, id);
      args.push('+quit');
      try {
        await this.run(this.steamcmd.path, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
      } catch (e) {
        // SteamCMD часто завершается с ненулевым кодом даже при успехе — результат проверяется по файлам.
        this.log.warn(`steamcmd завершился с ошибкой: ${String(e.message).split('\n')[0]}`);
      }
    };
    await attempt(ids);
    const missing = ids.filter((id) => !fs.existsSync(path.join(this.#contentDir(id), 'meta.cpp')));
    if (missing.length) await attempt(missing);
    return new Set(ids.filter((id) => fs.existsSync(path.join(this.#contentDir(id), 'meta.cpp'))));
  }

  // Скопировать скачанное в папку сервера (только если в кэше новее) и разложить ключи.
  #copy(id, folder, { force = false } = {}) {
    const src = this.#contentDir(id);
    const dst = path.join(this.serverDir, folder);
    const changed = force || !fs.existsSync(dst) || (filesUpdatedAt(src) ?? 0) > (filesUpdatedAt(dst) ?? 0);
    if (changed) fs.cpSync(src, dst, { recursive: true, force: true });
    const keysDir = path.join(this.serverDir, 'keys');
    for (const sub of ['keys', 'Keys', 'key', 'Key']) {
      const k = path.join(src, sub);
      if (!fs.existsSync(k)) continue;
      fs.mkdirSync(keysDir, { recursive: true });
      for (const f of fs.readdirSync(k).filter((name) => name.toLowerCase().endsWith('.bikey'))) {
        fs.copyFileSync(path.join(k, f), path.join(keysDir, f));
      }
    }
    return changed;
  }

  // Скачать и сразу поставить (сервер остановлен). Используется рестартом с обновлением модов
  // и плановыми рестартами; копирует и всё, что ждало остановки.
  async update(folders) {
    this.#requireSteam();
    if (folders.length > 100) throw new AgentError('bad_params', 'Слишком много модов');
    const targets = folders.map((f) => this.#folderOf(f));
    if (targets.length === 0) return this.applyPending();
    return this.#enqueue(async () => {
      this.log.info(`steamcmd: обновление ${targets.map((t) => t.folder).join(', ')}`);
      const ok = await this.#download(targets.map((t) => t.id), 60 * 60_000);
      const results = [];
      for (const t of targets) {
        if (!ok.has(t.id)) {
          results.push({ folder: t.folder, ok: false, error: 'не скачался' });
          continue;
        }
        const changed = this.#copy(t.id, t.folder);
        if (changed) this.log.info(`мод ${t.folder} обновлён`);
        results.push({ folder: t.folder, ok: true, changed });
      }
      results.push(...this.#applyPendingNow(new Set(targets.map((t) => t.folder))));
      return results;
    });
  }

  // Перед запуском сервера: поставить скачанные, пока он работал, обновления.
  async applyPending() {
    if (!this.pending().length) return [];
    return this.#enqueue(async () => this.#applyPendingNow(new Set()));
  }

  #applyPendingNow(skip) {
    const results = [];
    const left = [];
    for (const folder of this.pending()) {
      if (skip.has(folder)) continue;
      try {
        const { id } = this.#folderOf(folder);
        this.#copy(id, folder, { force: true });
        this.log.info(`мод ${folder}: установлено скачанное обновление`);
        results.push({ folder, ok: true, changed: true });
      } catch (e) {
        this.log.error(`мод ${folder}: не удалось поставить обновление: ${e.message}`);
        left.push(folder);
        results.push({ folder, ok: false, error: e.message });
      }
    }
    this.#setPending(left);
    return results;
  }

  // --- Фоновые задачи из админки: ответ сразу, ход виден в jobsList() ---

  jobsList() {
    return this.jobs.slice().reverse();
  }

  #job(kind, target) {
    const job = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind, target, status: 'queued', message: 'в очереди', at: Date.now() };
    this.jobs.push(job);
    if (this.jobs.length > MAX_JOBS) this.jobs.splice(0, this.jobs.length - MAX_JOBS);
    return job;
  }

  #runJob(job, fn) {
    this.#enqueue(async () => {
      job.status = 'running';
      job.message = 'скачивается из Workshop';
      job.at = Date.now();
      try {
        const done = await fn();
        Object.assign(job, { status: done.status ?? 'done', message: done.message, folder: done.folder, at: Date.now() });
      } catch (e) {
        Object.assign(job, { status: 'error', message: e.message, at: Date.now() });
        this.log.error(`${job.kind} ${job.target}: ${e.message}`);
      }
    });
    return job;
  }

  // Установить новый мод по ID из Workshop. Новая папка сервером не занята — ставится сразу, даже на работающем.
  // folder — своё имя папки (например, то, что уже стоит в списке модов после переезда); без него — по названию мода.
  install(id, folder = null) {
    this.#requireSteam();
    if (typeof id !== 'string' || !WORKSHOP_ID.test(id)) throw new AgentError('bad_params', 'ID мода из Workshop — это 6–12 цифр');
    if (folder !== null && (typeof folder !== 'string' || !MOD_FOLDER.test(folder))) throw new AgentError('bad_params', `Недопустимое имя папки: ${folder}`);
    if (folder !== null && fs.existsSync(path.join(this.serverDir, folder))) throw new AgentError('exists', `Папка ${folder} уже есть на сервере`);
    const existing = this.#findById(id);
    if (existing) throw new AgentError('exists', `Мод уже установлен: ${existing}. Обновить его можно кнопкой «Обновить»`);
    if (this.jobs.some((j) => j.target === id && (j.status === 'queued' || j.status === 'running'))) {
      throw new AgentError('busy', `Мод ${id} уже скачивается`);
    }
    const job = this.#job('install', id);
    this.log.info(`установка мода ${id} из Workshop`);
    return this.#runJob(job, async () => {
      const ok = await this.#download([id], 3 * 60 * 60_000);
      if (!ok.has(id)) throw new Error('не скачался (проверь ID и вход в Steam у SteamCMD)');
      const meta = readMeta(this.#contentDir(id));
      let target = folder ?? folderNameFor(meta.name, id);
      if (!folder && fs.existsSync(path.join(this.serverDir, target))) target = folderNameFor(`${meta.name ?? ''} ${id}`, id);
      this.#copy(id, target, { force: true });
      this.log.info(`мод ${id} установлен в ${target}`);
      return { folder: target, message: `установлен в ${target}, включи его в списке модов` };
    });
  }

  // Обновить один мод. Сервер остановлен — ставится сразу, работает — после скачивания ждёт рестарта.
  updateOne(folder, { serverRunning }) {
    this.#requireSteam();
    const { id } = this.#folderOf(folder);
    if (this.jobs.some((j) => j.target === folder && (j.status === 'queued' || j.status === 'running'))) {
      throw new AgentError('busy', `${folder} уже обновляется`);
    }
    const job = this.#job('update', folder);
    return this.#runJob(job, async () => {
      const ok = await this.#download([id], 3 * 60 * 60_000);
      if (!ok.has(id)) throw new Error('не скачался (проверь вход в Steam у SteamCMD)');
      if (await serverRunning()) {
        this.#setPending([...this.pending(), folder]);
        return { status: 'pending', folder, message: 'скачано, установится при ближайшем рестарте' };
      }
      const changed = this.#copy(id, folder);
      return { folder, message: changed ? 'обновлён' : 'уже последняя версия' };
    });
  }

  #findById(id) {
    for (const e of fs.readdirSync(this.serverDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('@') && readMeta(path.join(this.serverDir, e.name)).publishedId === id) return e.name;
    }
    return null;
  }
}
