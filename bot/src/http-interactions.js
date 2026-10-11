// Приём взаимодействий Discord по HTTP (Interactions Endpoint URL) вместо постоянного соединения.
// Зачем: в РФ постоянное соединение с Discord периодически «замерзает», и нажатия приходят с опозданием
// в минуту. По HTTP Discord сам присылает нажатие на сайт, а первый ответ уходит в том же HTTP-ответе.
//
// Как это встроено в discord.js: пришедшее нажатие отдаём обычному обработчику (как будто оно пришло
// через gateway), а первый вызов callback-API, который делает discord.js (reply/defer/update/showModal),
// перехватываем на уровне REST и отправляем телом HTTP-ответа.

import crypto from 'node:crypto';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // Ed25519 SPKI-заголовок
const CALLBACK_RE = /\/interactions\/(\d+)\/[^/]+\/callback/;
const ACK_DEADLINE_MS = 2700;

export function publicKeyFromHex(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex ?? '')) throw new Error('DISCORD_PUBLIC_KEY: 64 hex-символа (Developer Portal → General Information → Public Key)');
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}

export function verifyDiscordSignature(key, signatureHex, timestamp, rawBody) {
  if (!/^[0-9a-f]{128}$/i.test(signatureHex ?? '') || !timestamp) return false;
  try {
    return crypto.verify(null, Buffer.concat([Buffer.from(String(timestamp)), rawBody]), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

const fakeNoContent = () => ({
  body: null,
  bodyUsed: false,
  arrayBuffer: async () => new ArrayBuffer(0),
  json: async () => null,
  text: async () => '',
  headers: new Headers(),
  status: 204,
  statusText: 'No Content',
  ok: true,
});

export class HttpInteractions {
  constructor({ publicKeyHex, log }) {
    this.key = publicKeyFromHex(publicKeyHex);
    this.log = log;
    this.client = null; // задаётся после создания клиента
    this.pending = new Map(); // id взаимодействия -> resolve(тело HTTP-ответа)
  }

  // Обёртка над REST: первый callback ожидающего взаимодействия уходит в HTTP-ответ.
  intercept(baseMakeRequest) {
    return async (url, init) => {
      const m = CALLBACK_RE.exec(url);
      const p = m && this.pending.get(m[1]);
      if (p && typeof init.body === 'string') {
        this.pending.delete(m[1]);
        clearTimeout(p.timer);
        p.resolve(JSON.parse(init.body));
        return fakeNoContent();
      }
      return baseMakeRequest(url, init);
    };
  }

  // Возвращает { status, body } для HTTP-ответа.
  async handle(headers, rawBody) {
    if (!verifyDiscordSignature(this.key, headers['x-signature-ed25519'], headers['x-signature-timestamp'], rawBody)) {
      return { status: 401, body: { error: 'bad signature' } };
    }
    const data = JSON.parse(rawBody.toString('utf8'));
    if (data.type === 1) return { status: 200, body: { type: 1 } }; // PING при сохранении адреса в Developer Portal
    if (!this.client?.isReady()) return { status: 503, body: { error: 'not ready' } };

    const body = await new Promise((resolve) => {
      // Подстраховка: если бот вообще не ответил — «думает…», чтобы Discord не показал ошибку.
      const timer = setTimeout(() => {
        this.pending.delete(data.id);
        this.log.warn(`взаимодействие ${data.data?.custom_id ?? data.data?.name} без ответа за ${ACK_DEADLINE_MS} мс`);
        resolve(data.type === 2 ? { type: 5, data: { flags: 64 } } : { type: 6 });
      }, ACK_DEADLINE_MS);
      this.pending.set(data.id, { resolve, timer });
      try {
        this.client.actions.InteractionCreate.handle(data);
      } catch (e) {
        this.log.error(`HTTP-взаимодействие: ${e.message}`);
      }
    });
    return { status: 200, body };
  }
}
