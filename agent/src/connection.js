// Соединение агента с сайтом. Агент сам подключается к сайту по WSS (входящие порты на VDS не нужны),
// доказывает, что он — это он (подпись ключом агента), и выполняет только команды,
// подписанные ключом сайта.

import tls from 'node:tls';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, ReplayGuard, sign, verify } from '../../shared/protocol.js';

const PING_MS = 25_000;

export class HubConnection {
  constructor({ url, agentId, agentKey, siteKey, tlsPinSha256, handler, onDisconnect, log, version }) {
    this.url = url;
    this.agentId = agentId;
    this.agentKey = agentKey;
    this.siteKey = siteKey;
    this.pin = tlsPinSha256?.replace(/:/g, '').toLowerCase() ?? null;
    this.handler = handler;
    this.onDisconnect = onDisconnect;
    this.log = log;
    this.version = version;
    this.replay = new ReplayGuard();
    this.ws = null;
    this.authed = false;
    this.backoff = 1000;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  send(msg) {
    if (this.authed && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  #connect() {
    const opts = { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 15_000 };
    if (this.pin) {
      // Дополнительно к обычной проверке сертификата сверяем его отпечаток с заданным в конфиге.
      opts.checkServerIdentity = (host, cert) => {
        const err = tls.checkServerIdentity(host, cert);
        if (err) return err;
        if (cert.fingerprint256.replace(/:/g, '').toLowerCase() !== this.pin) {
          return new Error('Отпечаток TLS-сертификата сайта не совпадает с tlsPinSha256');
        }
        return undefined;
      };
    }
    const ws = new WebSocket(this.url, { ...opts, headers: { 'x-agent-id': this.agentId } });
    this.ws = ws;
    let alive = true;
    let pingTimer;
    const authTimer = setTimeout(() => {
      if (!this.authed) {
        this.log.warn('сайт не завершил рукопожатие — переподключение');
        ws.terminate();
      }
    }, 15_000);

    ws.on('open', () => {
      pingTimer = setInterval(() => {
        if (!alive) return ws.terminate();
        alive = false;
        ws.ping();
      }, PING_MS);
    });
    ws.on('pong', () => (alive = true));
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      this.#onMessage(msg).catch((e) => this.log.error(`обработка сообщения: ${e.message}`));
    });
    ws.on('error', (err) => this.log.warn(`соединение с сайтом: ${err.message}`));
    ws.on('close', () => {
      clearInterval(pingTimer);
      clearTimeout(authTimer);
      const wasAuthed = this.authed;
      this.authed = false;
      if (wasAuthed) {
        this.log.warn('соединение с сайтом потеряно');
        this.onDisconnect?.();
      }
      if (this.stopped) return;
      const delay = this.backoff + Math.random() * 1000;
      this.backoff = Math.min(this.backoff * 2, 60_000);
      this.reconnectTimer = setTimeout(() => this.#connect(), delay);
    });
  }

  async #onMessage(msg) {
    if (msg.type === 'challenge' && !this.authed && typeof msg.nonce === 'string') {
      const hello = sign(
        { type: 'hello', v: PROTOCOL_VERSION, agent: this.agentId, nonce: msg.nonce, ts: Date.now(), version: this.version },
        this.agentKey,
      );
      this.ws.send(JSON.stringify(hello));
    } else if (msg.type === 'welcome') {
      this.authed = true;
      this.backoff = 1000;
      this.log.info('подключён к сайту');
    } else if (msg.type === 'cmd' && this.authed) {
      await this.#onCommand(msg);
    }
  }

  async #onCommand(msg) {
    const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : null;
    const reject = (code, message) => {
      this.log.warn(`команда отклонена (${code}): ${msg.action}`);
      this.send({ type: 'res', id, ok: false, error: { code, message } });
    };
    if (!verify(msg, this.siteKey)) return reject('bad_signature', 'Неверная подпись команды');
    if (msg.v !== PROTOCOL_VERSION) return reject('bad_version', 'Несовместимая версия протокола');
    if (msg.agent !== this.agentId) return reject('wrong_agent', 'Команда для другого агента');
    const replay = this.replay.check(msg.nonce, msg.ts);
    if (replay) return reject(replay, 'Команда устарела или уже выполнялась (проверь время на сервере)');

    const res = await this.handler(msg.action, msg.params ?? {}, msg.actor ?? null);
    this.send({ type: 'res', id, ...res });
  }
}
