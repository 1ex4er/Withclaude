import crypto from 'node:crypto';

const TOKEN_TTL_MS = 15 * 60_000;

// Привязка Discord <-> Steam. Один Steam — один Discord.
export class Links {
  constructor(db) {
    this.db = db;
    this.q = {
      insertToken: db.prepare('INSERT INTO link_tokens (token, discord_id, expires_at) VALUES (?, ?, ?)'),
      getToken: db.prepare('SELECT discord_id FROM link_tokens WHERE token = ? AND expires_at > ?'),
      deleteToken: db.prepare('DELETE FROM link_tokens WHERE token = ? OR expires_at <= ?'),
      deleteUserTokens: db.prepare('DELETE FROM link_tokens WHERE discord_id = ?'),
      byDiscord: db.prepare('SELECT * FROM links WHERE discord_id = ?'),
      bySteam: db.prepare('SELECT * FROM links WHERE steam_id = ?'),
      upsert: db.prepare(
        'INSERT INTO links (discord_id, steam_id, linked_at, method) VALUES (?, ?, ?, ?) ON CONFLICT(discord_id) DO UPDATE SET steam_id = excluded.steam_id, linked_at = excluded.linked_at, method = excluded.method',
      ),
      remove: db.prepare('DELETE FROM links WHERE discord_id = ?'),
    };
  }

  createToken(discordId, now = Date.now()) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.q.deleteUserTokens.run(discordId);
    this.q.insertToken.run(token, discordId, now + TOKEN_TTL_MS);
    return token;
  }

  peekToken(token, now = Date.now()) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 64) return null;
    return this.q.getToken.get(token, now)?.discord_id ?? null;
  }

  complete(token, steamId, now = Date.now()) {
    const discordId = this.peekToken(token, now);
    if (!discordId) return { ok: false, message: 'Ссылка устарела.' };
    const other = this.q.bySteam.get(steamId);
    if (other && other.discord_id !== discordId) {
      return { ok: false, message: 'Этот Steam уже привязан к другому Discord. Обратись к администрации через тикет.' };
    }
    const previous = this.q.byDiscord.get(discordId)?.steam_id ?? null;
    this.db.transaction(() => {
      this.q.upsert.run(discordId, steamId, now, 'openid');
      this.q.deleteToken.run(token, now);
    })();
    return { ok: true, discordId, steamId, previous };
  }

  // SteamID вписан игроком вручную — владение не подтверждено.
  setManual(discordId, steamId, now = Date.now()) {
    const other = this.q.bySteam.get(steamId);
    if (other && other.discord_id !== discordId) {
      return { ok: false, message: 'Этот Steam уже привязан к другому участнику. Если это твой аккаунт — создай тикет.' };
    }
    const current = this.q.byDiscord.get(discordId);
    // Подтверждённый через Steam аккаунт вручную не перезаписываем.
    if (current?.method === 'openid' && current.steam_id !== steamId) {
      return { ok: false, message: 'У тебя уже привязан Steam через вход Steam. Сменить его можно через /steam.' };
    }
    this.q.upsert.run(discordId, steamId, now, current?.method === 'openid' ? 'openid' : 'manual');
    return { ok: true, discordId, steamId, previous: current?.steam_id ?? null };
  }

  get(discordId) {
    return this.q.byDiscord.get(discordId) ?? null;
  }

  bySteam(steamId) {
    return this.q.bySteam.get(steamId) ?? null;
  }

  find({ discordId, steamId }) {
    if (discordId) return this.get(discordId);
    if (steamId) return this.bySteam(steamId);
    return null;
  }

  unlink(discordId) {
    return this.q.remove.run(discordId).changes > 0;
  }
}
