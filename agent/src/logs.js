// Логи сервера (RPT/ADM/script.log): список, хвост файла, трансляция новых строк на сайт.

import fs from 'node:fs';
import path from 'node:path';
import { AgentError, check } from './errors.js';

const TAIL_MAX_BYTES = 1024 * 1024;

export class LogManager {
  constructor(cfg, emit) {
    this.dir = cfg.dir;
    this.extensions = cfg.extensions.map((e) => e.toLowerCase());
    this.emit = emit;
    this.followers = new Map(); // file -> { offset, timer }
  }

  #resolve(file) {
    check.string(file, 'file', { max: 128, pattern: /^[\w.\- ]+$/ });
    if (!this.extensions.includes(path.extname(file).toLowerCase())) {
      throw new AgentError('denied', 'Это не файл лога');
    }
    const abs = path.join(this.dir, file);
    if (!fs.existsSync(abs)) throw new AgentError('not_found', 'Лог не найден');
    return abs;
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((e) => e.isFile() && this.extensions.includes(path.extname(e.name).toLowerCase()))
      .map((e) => {
        const st = fs.statSync(path.join(this.dir, e.name));
        return { file: e.name, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }

  tail(file, lines = 200) {
    check.int(lines, 'lines', { min: 1, max: 5000 });
    const abs = this.#resolve(file);
    const size = fs.statSync(abs).size;
    const start = Math.max(0, size - TAIL_MAX_BYTES);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(abs, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, start);
    } finally {
      fs.closeSync(fd);
    }
    const all = buf.toString('utf8').split(/\r?\n/);
    if (start > 0) all.shift(); // первая строка обрезана
    return { file, size, lines: all.slice(-lines) };
  }

  // Новые строки уходят событием { topic: 'log', data: { file, lines } }.
  follow(file) {
    const abs = this.#resolve(file);
    if (this.followers.has(file)) return { following: true };
    if (this.followers.size >= 5) throw new AgentError('limit', 'Не больше 5 логов одновременно');
    const f = { offset: fs.statSync(abs).size, rest: '' };
    f.timer = setInterval(() => this.#poll(file, abs, f), 1000);
    this.followers.set(file, f);
    return { following: true };
  }

  unfollow(file) {
    const f = this.followers.get(file);
    if (f) clearInterval(f.timer);
    this.followers.delete(file);
    return { following: false };
  }

  unfollowAll() {
    for (const file of [...this.followers.keys()]) this.unfollow(file);
  }

  #poll(file, abs, f) {
    let size;
    try {
      size = fs.statSync(abs).size;
    } catch {
      return this.unfollow(file);
    }
    if (size < f.offset) f.offset = 0; // файл пересоздан
    if (size === f.offset) return;
    const len = Math.min(size - f.offset, TAIL_MAX_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(abs, 'r');
    try {
      fs.readSync(fd, buf, 0, len, f.offset);
    } finally {
      fs.closeSync(fd);
    }
    f.offset += len;
    const parts = (f.rest + buf.toString('utf8')).split(/\r?\n/);
    f.rest = parts.pop();
    if (parts.length) this.emit('log', { file, lines: parts });
  }
}
