// Общий протокол сайт <-> агент.
//
// Команда (сайт -> агент), подписана приватным ключом САЙТА:
//   { type: 'cmd', v, id, agent, ts, nonce, action, params, actor, sig }
// Ответ (агент -> сайт):
//   { type: 'res', id, ok, result } | { type: 'res', id, ok: false, error }
// Событие (агент -> сайт):
//   { type: 'event', topic, data }
// Рукопожатие:
//   сайт -> { type: 'challenge', nonce }
//   агент -> { type: 'hello', v, agent, nonce, ts, sig } (подписано приватным ключом АГЕНТА)
//   сайт -> { type: 'welcome' }

import crypto from 'node:crypto';
import fs from 'node:fs';

export const PROTOCOL_VERSION = 1;
export const MAX_CLOCK_SKEW_MS = 30_000;

// Детерминированная сериализация: ключи объектов сортируются, undefined пропускается.
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

export function loadPrivateKey(file) {
  return crypto.createPrivateKey(fs.readFileSync(file));
}

export function loadPublicKey(fileOrPem) {
  const pem = fileOrPem.includes('BEGIN PUBLIC KEY') ? fileOrPem : fs.readFileSync(fileOrPem);
  return crypto.createPublicKey(pem);
}

export function sign(message, privateKey) {
  const body = { ...message };
  delete body.sig;
  const sig = crypto.sign(null, Buffer.from(canonicalize(body)), privateKey).toString('base64');
  return { ...body, sig };
}

export function verify(message, publicKey) {
  const { sig, ...body } = message;
  if (typeof sig !== 'string') return false;
  try {
    return crypto.verify(null, Buffer.from(canonicalize(body)), publicKey, Buffer.from(sig, 'base64'));
  } catch {
    return false;
  }
}

export function newNonce() {
  return crypto.randomBytes(18).toString('base64url');
}

// Защита от повторной отправки перехваченных команд.
export class ReplayGuard {
  #seen = new Map();

  check(nonce, ts, now = Date.now()) {
    if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128) return 'bad_nonce';
    if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_MS) return 'stale';
    for (const [n, t] of this.#seen) {
      if (now - t > MAX_CLOCK_SKEW_MS * 2) this.#seen.delete(n);
      else break;
    }
    if (this.#seen.has(nonce)) return 'replay';
    this.#seen.set(nonce, now);
    return null;
  }
}
