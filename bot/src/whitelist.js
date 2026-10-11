// Вайтлист DayZ (whitelist.txt) через агента: читаем файл, меняем строку, пишем с проверкой версии.
// Если агент не в сети, изменения копятся в очереди и применяются при подключении.
// В serverDZ.cfg должно быть enableWhitelist = 1;

const STEAM_RE = /^\d{17}$/;

export function applyWhitelistChange(text, { op, steamId, note }) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const idOf = (line) => /^\s*(\d{17})\b/.exec(line)?.[1];
  const kept = lines.filter((l) => idOf(l) !== steamId);
  if (op === 'add') {
    while (kept.length && kept.at(-1).trim() === '') kept.pop();
    const comment = note ? `\t//${String(note).replace(/[\r\n]/g, ' ').slice(0, 64)}` : '';
    kept.push(`${steamId}${comment}`);
  }
  return kept.join(eol).replace(/\s*$/, '') + eol;
}

export function whitelistIds(text) {
  return text
    .split(/\r?\n/)
    .map((l) => /^\s*(\d{17})\b/.exec(l)?.[1])
    .filter(Boolean);
}

export class Whitelist {
  constructor(ctx) {
    this.ctx = ctx;
    this.file = ctx.cfg.whitelist;
    this.chain = Promise.resolve();
    ctx.agent.on('online', () => this.flush().catch((e) => ctx.log.warn(`вайтлист: ${e.message}`)));
  }

  #queue() {
    return this.ctx.db.kv.get('whitelist.queue', []);
  }

  // Изменения выполняются строго по очереди.
  change(op, steamId, note) {
    if (!STEAM_RE.test(steamId)) return Promise.reject(new Error('SteamID64 — 17 цифр'));
    const q = this.#queue().filter((x) => x.steamId !== steamId);
    q.push({ op, steamId, note });
    this.ctx.db.kv.set('whitelist.queue', q);
    return this.flush();
  }

  // Возвращает true, если всё применено, false — если ждём агента.
  flush() {
    this.chain = this.chain.then(() => this.#flush()).catch((e) => {
      this.ctx.log.warn(`вайтлист: ${e.message}`);
      return false;
    });
    return this.chain;
  }

  async #flush() {
    const q = this.#queue();
    if (!q.length) return true;
    if (!this.ctx.agent.online) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      let text = '';
      let sha;
      try {
        const r = await this.ctx.agent.call('files.read', { root: this.file.root, path: this.file.path }, 'whitelist');
        text = r.content;
        sha = r.sha;
      } catch (e) {
        if (e.code !== 'not_found') throw e;
      }
      for (const change of q) text = applyWhitelistChange(text, change);
      try {
        await this.ctx.agent.call('files.write', { root: this.file.root, path: this.file.path, content: text, baseSha: sha }, 'whitelist');
        this.ctx.db.kv.set('whitelist.queue', this.#queue().filter((x) => !q.some((y) => y.steamId === x.steamId && y.op === x.op)));
        return true;
      } catch (e) {
        if (e.code !== 'conflict') throw e;
      }
    }
    throw new Error('не удалось записать whitelist.txt (файл постоянно меняется)');
  }

  async list() {
    const r = await this.ctx.agent.call('files.read', { root: this.file.root, path: this.file.path }, 'whitelist');
    return whitelistIds(r.content);
  }
}
