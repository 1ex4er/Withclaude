// Моды сервера: список папок @Mod, обновление из Steam Workshop через SteamCMD.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentError } from './errors.js';

const run = promisify(execFile);
const DAYZ_APP_ID = '221100';

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

export class ModManager {
  constructor({ serverDir, steamcmd, steamUser, log }) {
    this.serverDir = serverDir;
    this.steamcmd = steamcmd;
    this.steamUser = steamUser;
    this.log = log;
  }

  list(enabled) {
    const on = new Set([...enabled.mods, ...enabled.serverMods]);
    return fs
      .readdirSync(this.serverDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('@'))
      .map((e) => ({
        folder: e.name,
        enabled: on.has(e.name),
        serverSide: enabled.serverMods.includes(e.name),
        ...readMeta(path.join(this.serverDir, e.name)),
      }));
  }

  // Из списка включённых модов — только те, что из Workshop (у локальных нет publishedid).
  workshopOnly(folders) {
    return folders.filter((f) => readMeta(path.join(this.serverDir, f)).publishedId);
  }

  // Скачивает моды через SteamCMD и копирует в папку сервера вместе с ключами.
  // Вход в Steam: один раз вручную выполни "steamcmd +login <логин>" (с кодом Steam Guard),
  // дальше SteamCMD помнит сессию, и пароль агенту не нужен.
  async update(folders) {
    if (!this.steamcmd?.path) throw new AgentError('unconfigured', 'steamcmd.path не задан в config.json');
    if (!this.steamUser) throw new AgentError('unconfigured', 'STEAM_USER не задан в .env');
    if (folders.length === 0 || folders.length > 100) throw new AgentError('bad_params', 'Пустой список модов');
    const targets = folders.map((folder) => {
      if (typeof folder !== 'string' || !/^@[\w.\- ]{1,64}$/.test(folder)) {
        throw new AgentError('bad_params', `Недопустимое имя мода: ${folder}`);
      }
      const id = readMeta(path.join(this.serverDir, folder)).publishedId;
      if (!id) throw new AgentError('bad_params', `${folder}: в meta.cpp нет publishedid`);
      return { folder, id };
    });

    const args = ['+login', this.steamUser];
    for (const t of targets) args.push('+workshop_download_item', DAYZ_APP_ID, t.id, 'validate');
    args.push('+quit');
    this.log.info(`steamcmd: обновление ${targets.map((t) => t.folder).join(', ')}`);
    try {
      await run(this.steamcmd.path, args, { windowsHide: true, timeout: 30 * 60_000, maxBuffer: 32 * 1024 * 1024 });
    } catch (e) {
      // SteamCMD часто завершается с ненулевым кодом даже при успехе — проверяем результат по файлам.
      this.log.warn(`steamcmd завершился с ошибкой: ${e.message.split('\n')[0]}`);
    }

    const contentRoot = path.join(path.dirname(this.steamcmd.path), 'steamapps', 'workshop', 'content', DAYZ_APP_ID);
    const keysDir = path.join(this.serverDir, 'keys');
    const results = [];
    for (const t of targets) {
      const src = path.join(contentRoot, t.id);
      if (!fs.existsSync(src)) {
        results.push({ folder: t.folder, ok: false, error: 'не скачался' });
        continue;
      }
      fs.cpSync(src, path.join(this.serverDir, t.folder), { recursive: true, force: true });
      for (const sub of ['keys', 'Keys', 'key', 'Key']) {
        const k = path.join(src, sub);
        if (!fs.existsSync(k)) continue;
        fs.mkdirSync(keysDir, { recursive: true });
        for (const f of fs.readdirSync(k).filter((f) => f.toLowerCase().endsWith('.bikey'))) {
          fs.copyFileSync(path.join(k, f), path.join(keysDir, f));
        }
      }
      results.push({ folder: t.folder, ok: true });
    }
    return results;
  }
}
