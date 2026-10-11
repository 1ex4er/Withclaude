// Модуль для сайта: принимает подключения агентов и отправляет им подписанные команды.
//
//   import { AgentHub } from './site-kit/hub.js';
//   const hub = new AgentHub({
//     sitePrivateKey: './keys/site_private.pem',
//     agents: { 'blackout-main': './keys/agent_public.pem' },
//   });
//   hub.attach(httpServer, '/agent-ws');
//   const status = await hub.call('blackout-main', 'server.status', {}, { steamId, name });
//
// Права админов проверяет САЙТ до вызова hub.call (вход через Steam + список SteamID + 2FA).

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, loadPrivateKey, loadPublicKey, newNonce, sign, verify } from '../shared/protocol.js';

const AUTH_TIMEOUT_MS = 10_000;

export class AgentHub extends EventEmitter {
  constructor({ sitePrivateKey, agents, callTimeoutMs = 30_000 }) {
    super();
    this.key = typeof sitePrivateKey === 'string' ? loadPrivateKey(sitePrivateKey) : sitePrivateKey;
    this.agentKeys = new Map(Object.entries(agents).map(([id, k]) => [id, typeof k === 'string' ? loadPublicKey(k) : k]));
    this.callTimeoutMs = callTimeoutMs;
    this.sockets = new Map(); // agentId -> ws
    this.pending = new Map(); // callId -> { resolve, reject, timer, agentId }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  }

  // Подключает обработчик к существующему HTTP(S)-серверу сайта.
  attach(httpServer, path = '/agent-ws') {
    httpServer.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://x').pathname !== path) return;
      this.wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, req));
    });
  }

  isOnline(agentId) {
    return this.sockets.has(agentId);
  }

  #onConnection(ws, req) {
    const nonce = newNonce();
    let agentId = null;
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? req.socket.remoteAddress;
    const timer = setTimeout(() => ws.terminate(), AUTH_TIMEOUT_MS);
    ws.send(JSON.stringify({ type: 'challenge', nonce }));

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return ws.terminate();
      }
      if (!agentId) {
        const key = msg.type === 'hello' ? this.agentKeys.get(msg.agent) : null;
        const fresh = Math.abs(Date.now() - msg.ts) < 30_000;
        if (!key || msg.nonce !== nonce || !fresh || msg.v !== PROTOCOL_VERSION || !verify(msg, key)) {
          this.emit('authFailed', { ip, agent: msg.agent });
          return ws.terminate();
        }
        clearTimeout(timer);
        agentId = msg.agent;
        this.sockets.get(agentId)?.terminate(); // старое соединение того же агента
        this.sockets.set(agentId, ws);
        ws.send(JSON.stringify({ type: 'welcome' }));
        this.emit('online', agentId, { ip, version: msg.version });
        return;
      }
      if (msg.type === 'res') {
        const p = this.pending.get(msg.id);
        if (!p || p.agentId !== agentId) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(Object.assign(new Error(msg.error?.message ?? 'error'), { code: msg.error?.code }));
      } else if (msg.type === 'event') {
        this.emit('event', agentId, msg.topic, msg.data);
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (agentId && this.sockets.get(agentId) === ws) {
        this.sockets.delete(agentId);
        for (const [id, p] of this.pending) {
          if (p.agentId !== agentId) continue;
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.reject(Object.assign(new Error('Агент отключился'), { code: 'agent_offline' }));
        }
        this.emit('offline', agentId);
      }
    });
    ws.on('error', () => {});
  }

  // actor — кто из админов выполняет действие (пишется в журнал агента).
  call(agentId, action, params = {}, actor = null, { timeoutMs = this.callTimeoutMs } = {}) {
    const ws = this.sockets.get(agentId);
    if (!ws) return Promise.reject(Object.assign(new Error('Агент не в сети'), { code: 'agent_offline' }));
    const id = crypto.randomUUID();
    const msg = sign(
      { type: 'cmd', v: PROTOCOL_VERSION, id, agent: agentId, ts: Date.now(), nonce: newNonce(), action, params, actor },
      this.key,
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('Агент не ответил вовремя'), { code: 'timeout' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, agentId });
      ws.send(JSON.stringify(msg));
    });
  }

  close() {
    for (const ws of this.sockets.values()) ws.terminate();
    this.wss.close();
  }
}
