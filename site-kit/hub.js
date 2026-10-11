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
//
// Для магазина LX агенты покупателей не прописываются заранее — их пускает authorize:
//   new AgentHub({ sitePrivateKey, authorize: async (hello, ip) => {
//     // hello.license, hello.pub (публичный ключ агента), hello.allow, ip
//     // найти лицензию, проверить IP, при первом подключении привязать hello.pub к лицензии
//     return { id: 'lic-123', publicKey: storedPubPem } // или null — не пускать
//   }})

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION, loadPrivateKey, loadPublicKey, newNonce, sign, verify } from '../shared/protocol.js';

const AUTH_TIMEOUT_MS = 10_000;

export class AgentHub extends EventEmitter {
  // trustProxy: true, только если хаб стоит за nginx и слушает 127.0.0.1 — иначе X-Forwarded-For можно подделать.
  constructor({ sitePrivateKey, agents = {}, authorize = null, callTimeoutMs = 30_000, trustProxy = false }) {
    super();
    this.key = typeof sitePrivateKey === 'string' ? loadPrivateKey(sitePrivateKey) : sitePrivateKey;
    this.agentKeys = new Map(Object.entries(agents).map(([id, k]) => [id, typeof k === 'string' ? loadPublicKey(k) : k]));
    this.authorize = authorize;
    this.trustProxy = trustProxy;
    this.callTimeoutMs = callTimeoutMs;
    this.info = new Map(); // agentId -> { ip, version, allow, license }
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

  // Публичный ключ агента: из списка agents или через authorize(hello, ip).
  async #resolveAgent(hello, ip) {
    if (typeof hello.agent !== 'string') return null;
    if (this.agentKeys.has(hello.agent)) return { id: hello.agent, publicKey: this.agentKeys.get(hello.agent) };
    if (!this.authorize) return null;
    const res = await this.authorize(hello, ip);
    if (!res?.publicKey || !res.id) return null;
    return { id: res.id, publicKey: typeof res.publicKey === 'string' ? loadPublicKey(res.publicKey) : res.publicKey };
  }

  #onConnection(ws, req) {
    const nonce = newNonce();
    let agentId = null;
    let authing = false;
    const forwarded = this.trustProxy ? req.headers['x-forwarded-for']?.split(',').at(-1).trim() : null;
    const ip = forwarded || req.socket.remoteAddress;
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
        if (authing || msg.type !== 'hello') return ws.terminate();
        authing = true;
        this.#handshake(ws, msg, nonce, ip)
          .then((id) => {
            if (!id) {
              this.emit('authFailed', { ip, agent: msg.agent, license: msg.license });
              return ws.terminate();
            }
            clearTimeout(timer);
            agentId = id;
            this.sockets.get(agentId)?.terminate(); // старое соединение того же агента
            this.sockets.set(agentId, ws);
            // agent — как агент называет себя сам; в командах он ждёт именно это имя.
            const info = { agent: msg.agent, ip, version: msg.version, allow: msg.allow, license: msg.license ?? null };
            this.info.set(agentId, info);
            ws.send(JSON.stringify({ type: 'welcome' }));
            this.emit('online', agentId, info);
          })
          .catch(() => ws.terminate());
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
        this.info.delete(agentId);
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

  async #handshake(ws, msg, nonce, ip) {
    const fresh = Math.abs(Date.now() - msg.ts) < 30_000;
    if (msg.nonce !== nonce || !fresh || msg.v !== PROTOCOL_VERSION) return null;
    const agent = await this.#resolveAgent(msg, ip);
    if (!agent || !verify(msg, agent.publicKey)) return null;
    return agent.id;
  }

  // actor — кто из админов выполняет действие (пишется в журнал агента).
  call(agentId, action, params = {}, actor = null, { timeoutMs = this.callTimeoutMs } = {}) {
    const ws = this.sockets.get(agentId);
    if (!ws) return Promise.reject(Object.assign(new Error('Агент не в сети'), { code: 'agent_offline' }));
    const id = crypto.randomUUID();
    const msg = sign(
      { type: 'cmd', v: PROTOCOL_VERSION, id, agent: this.info.get(agentId)?.agent ?? agentId, ts: Date.now(), nonce: newNonce(), action, params, actor },
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
