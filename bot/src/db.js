// Встроенный в Node.js SQLite (22.13+): без нативных модулей и компиляции на хостинге.
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS links (
  discord_id TEXT PRIMARY KEY,
  steam_id   TEXT NOT NULL UNIQUE,
  linked_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS link_tokens (
  token      TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id  TEXT NOT NULL,
  answers     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  reviewer_id TEXT,
  reason      TEXT,
  message_id  TEXT,
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER
);
CREATE INDEX IF NOT EXISTS applications_user ON applications(discord_id);

CREATE TABLE IF NOT EXISTS tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT UNIQUE,
  discord_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  claimed_by TEXT,
  created_at INTEGER NOT NULL,
  closed_by  TEXT,
  closed_at  INTEGER
);

CREATE TABLE IF NOT EXISTS warns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  mod_id     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS warns_user ON warns(discord_id);
`;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Миграция: способ привязки Steam — 'openid' (вход через Steam) или 'manual' (вписан вручную).
  try {
    db.exec("ALTER TABLE links ADD COLUMN method TEXT NOT NULL DEFAULT 'openid'");
  } catch {}

  db.transaction =
    (fn) =>
    (...args) => {
      db.exec('BEGIN');
      try {
        const result = fn(...args);
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    };

  const kvGet = db.prepare('SELECT value FROM kv WHERE key = ?');
  const kvSet = db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.kv = {
    get: (key, fallback = null) => {
      const row = kvGet.get(key);
      return row ? JSON.parse(row.value) : fallback;
    },
    set: (key, value) => kvSet.run(key, JSON.stringify(value)),
  };
  return db;
}
