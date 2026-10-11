// Связь бота с агентом на VDS: бот сам принимает подключение агента (site-kit/hub.js).

import { EventEmitter } from 'node:events';
import { AgentHub } from '../../site-kit/hub.js';

export class AgentLink extends EventEmitter {
  constructor(cfg, log) {
    super();
    this.id = cfg.agent.id;
    this.log = log;
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
    return this.hub.isOnline(this.id);
  }

  attach(httpServer) {
    this.hub.attach(httpServer, '/agent-ws');
  }

  // actor — кто выполняет (для журнала агента): участник Discord или строка.
  call(action, params = {}, actor = null, opts) {
    const who =
      actor && typeof actor === 'object'
        ? { discordId: actor.id, name: actor.user?.tag ?? actor.tag ?? actor.displayName ?? actor.id }
        : { name: actor ?? 'bot' };
    return this.hub.call(this.id, action, params, who, opts);
  }
}
