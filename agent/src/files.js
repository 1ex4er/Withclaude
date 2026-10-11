import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentError, check } from './errors.js';

const MASK = '********';
const isWin = process.platform === 'win32';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function inside(parent, child) {
  const p = isWin ? parent.toLowerCase() : parent;
  const c = isWin ? child.toLowerCase() : child;
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// Работа с файлами конфигов: только внутри разрешённых корней, только разрешённые расширения,
// с бэкапом перед каждой записью.
export class FileManager {
  constructor(cfg) {
    this.cfg = cfg;
  }

  // Возвращает абсолютный путь, гарантированно лежащий внутри корня (с учётом симлинков).
  resolve(rootName, relPath, { mustExist = true, kind = 'file' } = {}) {
    const root = this.cfg.roots[rootName];
    if (!root) throw new AgentError('bad_root', `Неизвестный корень: ${rootName}`);
    check.string(relPath, 'path', { max: 512, allowEmpty: kind === 'dir' });
    if (relPath.includes('\0')) throw new AgentError('bad_path', 'Недопустимый путь');

    const abs = path.resolve(root, relPath);
    if (!inside(root, abs)) throw new AgentError('bad_path', 'Путь вне разрешённой папки');

    const rel = path.relative(root, abs);
    if (this.#denied(rel)) throw new AgentError('denied', 'Доступ к этому файлу запрещён');
    if (kind === 'file' && !this.cfg.extensions.includes(path.extname(abs).toLowerCase())) {
      throw new AgentError('denied', `Разрешены только: ${this.cfg.extensions.join(', ')}`);
    }

    if (!fs.existsSync(root)) throw new AgentError('not_found', `Папка ${rootName} не найдена на сервере`);
    const realRoot = fs.realpathSync(root);
    const exists = fs.existsSync(abs);
    if (!exists && mustExist) throw new AgentError('not_found', 'Файл не найден');
    let real;
    try {
      real = fs.realpathSync(exists ? abs : path.dirname(abs));
    } catch {
      throw new AgentError('not_found', 'Папка не найдена');
    }
    if (!inside(realRoot, real)) throw new AgentError('bad_path', 'Путь вне разрешённой папки');
    return { abs, rel, exists };
  }

  #denied(rel) {
    const segments = rel.toLowerCase().split(/[\\/]+/).filter(Boolean);
    const base = segments.at(-1) ?? '';
    return this.cfg.deny.some((token) => {
      const t = token.toLowerCase();
      if (t.startsWith('.')) return path.extname(base) === t;
      return segments.includes(t) || base.startsWith(t);
    });
  }

  roots() {
    return Object.keys(this.cfg.roots);
  }

  list(rootName, dir = '') {
    const { abs } = this.resolve(rootName, dir, { kind: 'dir' });
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      const rel = path.join(dir, e.name);
      if (this.#denied(rel)) continue;
      if (e.isDirectory()) {
        out.push({ name: e.name, path: rel, type: 'dir' });
      } else if (e.isFile() && this.cfg.extensions.includes(path.extname(e.name).toLowerCase())) {
        const st = fs.statSync(path.join(abs, e.name));
        out.push({ name: e.name, path: rel, type: 'file', size: st.size, mtime: st.mtimeMs });
      }
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  read(rootName, relPath) {
    const { abs } = this.resolve(rootName, relPath);
    const raw = this.#readRaw(abs);
    const { text, masked } = this.#mask(abs, raw.toString('utf8'));
    return { path: relPath, content: text, sha: sha256(raw), masked };
  }

  write(rootName, relPath, content, baseSha, actor) {
    check.string(content, 'content', { max: this.#maxBytes(), allowEmpty: true });
    const { abs, rel, exists } = this.resolve(rootName, relPath, { mustExist: false });

    let current = null;
    if (exists) {
      current = this.#readRaw(abs);
      if (baseSha !== sha256(current)) {
        throw new AgentError('conflict', 'Файл изменился с момента открытия. Обнови страницу и повтори правку.');
      }
      content = this.#unmask(abs, content, current.toString('utf8'));
    }
    validateContent(abs, content);

    if (current) this.#backup(rootName, rel, current);
    const tmp = abs + '.agent-tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, abs);
    return { path: relPath, sha: sha256(Buffer.from(content, 'utf8')), by: actor?.name ?? null };
  }

  backups(rootName, relPath) {
    const { rel } = this.resolve(rootName, relPath, { mustExist: false });
    const dir = path.join(this.cfg.backupDir, rootName, rel);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.bak'))
      .sort()
      .reverse()
      .map((id) => ({ id, size: fs.statSync(path.join(dir, id)).size }));
  }

  readBackup(rootName, relPath, backupId) {
    check.string(backupId, 'backupId', { max: 64, pattern: /^[0-9TZ-]+\.bak$/ });
    const { rel } = this.resolve(rootName, relPath, { mustExist: false });
    const file = path.join(this.cfg.backupDir, rootName, rel, backupId);
    if (!fs.existsSync(file)) throw new AgentError('not_found', 'Бэкап не найден');
    return fs.readFileSync(file);
  }

  restore(rootName, relPath, backupId) {
    const data = this.readBackup(rootName, relPath, backupId);
    const { abs, rel, exists } = this.resolve(rootName, relPath, { mustExist: false });
    if (exists) this.#backup(rootName, rel, fs.readFileSync(abs));
    fs.writeFileSync(abs, data);
    return { path: relPath, sha: sha256(data) };
  }

  #maxBytes() {
    return this.cfg.maxSizeMb * 1024 * 1024;
  }

  #readRaw(abs) {
    const st = fs.statSync(abs);
    if (st.size > this.#maxBytes()) throw new AgentError('too_large', `Файл больше ${this.cfg.maxSizeMb} МБ`);
    return fs.readFileSync(abs);
  }

  #backup(rootName, rel, data) {
    const dir = path.join(this.cfg.backupDir, rootName, rel);
    fs.mkdirSync(dir, { recursive: true });
    const id = new Date().toISOString().replace(/[:.]/g, '-') + '.bak';
    fs.writeFileSync(path.join(dir, id), data);
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.bak')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - this.cfg.keepBackups))) {
      fs.unlinkSync(path.join(dir, old));
    }
  }

  // В .cfg значения секретных ключей (passwordAdmin и т.п.) не уходят на сайт.
  #maskRegex(key) {
    return new RegExp(`^(\\s*${key}\\s*=\\s*")([^"]*)(")`, 'gmi');
  }

  #mask(abs, text) {
    if (path.extname(abs).toLowerCase() !== '.cfg') return { text, masked: [] };
    const masked = [];
    for (const key of this.cfg.maskedCfgKeys) {
      text = text.replace(this.#maskRegex(key), (_m, a, _v, c) => {
        masked.push(key);
        return a + MASK + c;
      });
    }
    return { text, masked };
  }

  #unmask(abs, text, currentText) {
    if (path.extname(abs).toLowerCase() !== '.cfg') return text;
    for (const key of this.cfg.maskedCfgKeys) {
      const original = [...currentText.matchAll(this.#maskRegex(key))][0]?.[2];
      text = text.replace(this.#maskRegex(key), (m, a, v, c) => {
        if (v !== MASK) return m;
        if (original === undefined) throw new AgentError('bad_params', `${key}: задай значение явно`);
        return a + original + c;
      });
    }
    return text;
  }
}

function validateContent(abs, content) {
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(content.replace(/^﻿/, ''));
    } catch (e) {
      throw new AgentError('invalid', `Ошибка в JSON: ${e.message}`);
    }
  } else if (ext === '.xml') {
    const err = checkXml(content);
    if (err) throw new AgentError('invalid', `Ошибка в XML: ${err}`);
  }
}

// Проверка, что XML корректен (теги закрыты, один корень). Ошибка в types.xml ломает
// экономику сервера, поэтому лучше поймать её до сохранения.
export function checkXml(text) {
  const src = text.replace(/^﻿/, '');
  const lineAt = (i) => src.slice(0, i).split('\n').length;
  const markup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<[^>]*>?/g;
  const tag = /^<(\/)?([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/)?>$/;
  const stack = [];
  let rootSeen = false;
  let last = 0;

  const textOk = (from, to) => {
    const chunk = src.slice(from, to);
    if (chunk.includes('<')) return `строка ${lineAt(from + chunk.indexOf('<'))}: лишний символ "<"`;
    if (stack.length === 0 && chunk.trim()) return `строка ${lineAt(from)}: текст вне корневого тега`;
    return null;
  };

  for (const m of src.matchAll(markup)) {
    const err = textOk(last, m.index);
    if (err) return err;
    last = m.index + m[0].length;
    const s = m[0];
    const special =
      (s.startsWith('<!--') && s.endsWith('-->')) ||
      (s.startsWith('<![CDATA[') && s.endsWith(']]>')) ||
      (s.startsWith('<?') && s.endsWith('?>')) ||
      /^<!DOCTYPE[^>]*>$/.test(s);
    if (special) {
      if (s.startsWith('<![CDATA[') && stack.length === 0) return `строка ${lineAt(m.index)}: CDATA вне корня`;
      continue;
    }
    const t = tag.exec(s);
    if (!t) return `строка ${lineAt(m.index)}: некорректный тег ${s.slice(0, 60)}`;
    const [, closing, name, attrs, selfClosing] = t;
    if (closing) {
      if (attrs || selfClosing) return `строка ${lineAt(m.index)}: некорректный закрывающий тег`;
      const open = stack.pop();
      if (open !== name) {
        return `строка ${lineAt(m.index)}: </${name}> закрывает ${open ? `<${open}>` : 'ничего'}`;
      }
    } else {
      if (stack.length === 0) {
        if (rootSeen) return `строка ${lineAt(m.index)}: второй корневой тег <${name}>`;
        rootSeen = true;
      }
      if (!selfClosing) stack.push(name);
    }
  }
  const err = textOk(last, src.length);
  if (err) return err;
  if (stack.length) return `не закрыт тег <${stack.at(-1)}>`;
  if (!rootSeen) return 'нет корневого тега';
  return null;
}
