// Клиент BattlEye RCon (UDP). Протокол: https://www.battleye.com/downloads/BERConProtocol.txt
// Агент подключается к RCon только локально (127.0.0.1), пароль берётся из .env и на сайт не уходит.

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { AgentError } from './errors.js';

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

export function crc32(buf) {
  let crc = -1;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

export function buildPacket(type, body) {
  const payload = Buffer.concat([Buffer.from([0xff, type]), body]);
  const header = Buffer.alloc(6);
  header.write('BE', 0, 'ascii');
  header.writeUInt32LE(crc32(payload), 2);
  return Buffer.concat([header, payload]);
}

export function parsePacket(msg) {
  if (msg.length < 8 || msg.toString('ascii', 0, 2) !== 'BE' || msg[6] !== 0xff) return null;
  const payload = msg.subarray(6);
  if (msg.readUInt32LE(2) !== crc32(payload)) return null;
  return { type: msg[7], body: msg.subarray(8) };
}

const LOGIN = 0x00;
const COMMAND = 0x01;
const SERVER_MSG = 0x02;

export class BERcon extends EventEmitter {
  // passwords — кандидаты по порядку (конфиги BattlEye, которые нашлись); подошедший запоминается.
  constructor({ host, port, password, passwords = [], timeoutMs = 5000 }) {
    super();
    this.host = host;
    this.port = port;
    this.passwords = [...new Set([password, ...passwords].filter(Boolean))];
    this.password = this.passwords[0] ?? null;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.connected = false;
    this.seq = 0;
    this.pending = new Map(); // seq -> { resolve, reject, parts, timer }
    this.loginWaiter = null;
    this.keepAlive = null;
  }

  async connect() {
    if (this.connected) return;
    if (!this.password) throw new AgentError('rcon_unconfigured', 'RCON_PASSWORD не задан в .env');
    // Неверный пароль — пробуем следующий найденный (панель могла оставить старый конфиг рядом с действующим).
    const order = [this.password, ...this.passwords.filter((p) => p !== this.password)];
    for (let i = 0; i < order.length; i++) {
      try {
        await this.#login(order[i]);
        this.password = order[i];
        return;
      } catch (err) {
        if (err.code !== 'rcon_auth' || i === order.length - 1) throw err;
      }
    }
  }

  async #login(password) {
    this.close();
    const socket = dgram.createSocket('udp4');
    this.socket = socket;
    socket.on('message', (msg) => this.#onMessage(msg));
    socket.on('error', (err) => {
      this.emit('error', err);
      this.close();
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.loginWaiter = null;
        reject(new AgentError('rcon_timeout', 'RCon не отвечает (сервер запущен?)'));
      }, this.timeoutMs);
      this.loginWaiter = (ok) => {
        clearTimeout(timer);
        this.loginWaiter = null;
        ok ? resolve() : reject(new AgentError('rcon_auth', 'RCon: неверный пароль'));
      };
      this.#send(buildPacket(LOGIN, Buffer.from(password, 'ascii')));
    }).catch((err) => {
      this.close();
      throw err;
    });

    this.connected = true;
    // BattlEye отключает клиента после 45 с тишины.
    this.keepAlive = setInterval(() => {
      this.command('').catch(() => this.close());
    }, 30_000);
    this.emit('connected');
  }

  close() {
    clearInterval(this.keepAlive);
    this.keepAlive = null;
    const wasConnected = this.connected;
    this.connected = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AgentError('rcon_closed', 'RCon соединение закрыто'));
    }
    this.pending.clear();
    if (this.socket) {
      this.socket.removeAllListeners('message');
      try {
        this.socket.close();
      } catch {}
      this.socket = null;
    }
    if (wasConnected) this.emit('disconnected');
  }

  async command(cmd) {
    if (!this.connected && cmd !== '') await this.connect();
    if (!this.socket) throw new AgentError('rcon_closed', 'RCon не подключён');
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xff;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new AgentError('rcon_timeout', 'RCon не ответил'));
      }, this.timeoutMs);
      this.pending.set(seq, { resolve, reject, timer, parts: null });
      this.#send(buildPacket(COMMAND, Buffer.concat([Buffer.from([seq]), Buffer.from(cmd, 'utf8')])));
    });
  }

  #send(packet) {
    this.socket?.send(packet, this.port, this.host);
  }

  #onMessage(msg) {
    const pkt = parsePacket(msg);
    if (!pkt) return;
    if (pkt.type === LOGIN) {
      this.loginWaiter?.(pkt.body[0] === 0x01);
    } else if (pkt.type === SERVER_MSG) {
      const seq = pkt.body[0];
      this.#send(buildPacket(SERVER_MSG, Buffer.from([seq])));
      this.emit('message', pkt.body.subarray(1).toString('utf8'));
    } else if (pkt.type === COMMAND) {
      const seq = pkt.body[0];
      const p = this.pending.get(seq);
      if (!p) return;
      let data = pkt.body.subarray(1);
      if (data[0] === 0x00 && data.length >= 3) {
        // Многочастный ответ: 0x00, количество частей, индекс части.
        const total = data[1];
        const index = data[2];
        p.parts ??= new Array(total).fill(null);
        p.parts[index] = data.subarray(3);
        if (p.parts.some((x) => x === null)) return;
        data = Buffer.concat(p.parts);
      }
      clearTimeout(p.timer);
      this.pending.delete(seq);
      p.resolve(data.toString('utf8'));
    }
  }
}

// Разбор ответа команды "players".
export function parsePlayers(text) {
  const re = /^(\d+)\s+([\d.]+):(\d+)\s+(-?\d+)\s+([0-9a-f]{32}|-)(?:\(([^)\s]*)\))?\s+(.+?)(\s+\(Lobby\))?$/i;
  const players = [];
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (!m) continue;
    players.push({
      id: Number(m[1]),
      ip: m[2],
      port: Number(m[3]),
      ping: Number(m[4]),
      guid: m[5] === '-' ? null : m[5],
      verified: m[6] === 'OK',
      name: m[7],
      lobby: Boolean(m[8]),
    });
  }
  return players;
}

// Разбор ответа команды "bans" (GUID и IP баны).
export function parseBans(text) {
  const re = /^(\d+)\s+(\S+)\s+(-?\d+|perm|-)\s*(.*)$/i;
  const bans = [];
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (!m) continue;
    bans.push({ index: Number(m[1]), target: m[2], minutesLeft: m[3], reason: m[4] });
  }
  return bans;
}
