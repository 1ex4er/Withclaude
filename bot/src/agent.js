// Связь бота с агентом на VDS: бот сам принимает подключение агента (site-kit/hub.js).

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { AgentHub } from '../../site-kit/hub.js';

export class AgentLink extends EventEmitter {
  constructor(cfg, log) {
    super();
    this.id = cfg.agent.id;
    this.log = log;
    this.hub = null;
    // Пока ключи не созданы, бот работает без управления игровым сервером.
    const missing = [cfg.agent.sitePrivateKey, cfg.agent.agentPublicKey].filter((f) => !fs.existsSync(f));
    if (missing.length) {
      log.warn(`управление сервером выключено: нет ${missing.join(', ')}`);
      return;
    }
    this.hub = new AgentHub({
      sitePrivateKey: cfg.agent.sitePrivateKey,
      agents: { [this.id]: cfg.agent.agentPublicKey },
      trustProxy: cfg.http.host === '127.0.0.1',
    });
    this.hub.on('online', (id, info) => {
      log.info(`агент ${id} подключился (${info.ip}, v${info.version})`);
      this.emit('online', info);
    });
    this.hub.on('offline', (id) => {
      log.warn(`агент ${id} отключился`);
      this.emit('offline');
    });
    this.hub.on('authFailed', ({ ip }) => log.warn(`отклонено подключение агента с ${ip}`));
    this.hub.on('event', (id, topic, data) => this.emit(topic, data));
  }

  get online() {
    return this.hub?.isOnline(this.id) ?? false;
  }

  attach(httpServer) {
    this.hub?.attach(httpServer, '/agent-ws');
  }

  // actor — кто выполняет (для журнала агента): участник Discord или строка.
  call(action, params = {}, actor = null, opts) {
    let who;
    if (actor && typeof actor === 'object' && !actor.user && typeof actor.name === 'string') who = actor; // от сайта: { steamId, name }
    else if (actor && typeof actor === 'object') who = { discordId: actor.id, name: actor.user?.tag ?? actor.tag ?? actor.displayName ?? actor.id };
    else who = { name: actor ?? 'bot' };
    if (!this.hub) return Promise.reject(Object.assign(new Error('Агент сервера не настроен'), { code: 'agent_offline' }));
    return this.hub.call(this.id, action, params, who, opts);
  }
}
