// Полный список того, что агент умеет. Ничего за пределами этого списка сайт сделать не может:
// нет выполнения произвольных команд и доступа к файлам вне разрешённых папок.

import { AgentError, check } from './errors.js';
import { parseBans, parsePlayers } from './rcon.js';

const MOD_LIST = (v, name) => {
  if (!Array.isArray(v)) throw new AgentError('bad_params', `${name}: ожидается список`);
  return v;
};

export function createActions({ server, rcon, files, logs, mods, rconCfg }) {
  const rconCmd = (cmd) => rcon.command(cmd);

  return {
    // --- Сервер ---
    'server.status': () => server.status(),
    'server.start': () => server.start(),
    'server.stop': (p) => server.stop({ graceful: p.force !== true }),
    'server.restart': (p) =>
      server.restart({
        beforeStart: p.updateMods
          ? () => {
              const { mods: client, serverMods } = server.mods();
              return mods.update(mods.workshopOnly([...client, ...serverMods]));
            }
          : undefined,
      }),
    'server.restartIn': (p) => server.restartIn(check.int(p.minutes, 'minutes', { min: 1, max: 180 })),
    'server.cancelRestart': () => (server.cancelPlannedRestart(), { cancelled: true }),
    'server.getSchedule': () => ({ restarts: server.getSchedule() }),
    'server.setSchedule': (p) => ({ restarts: server.setSchedule(p.restarts) }),

    // --- Файлы и конфиги ---
    'files.roots': () => files.roots(),
    'files.list': (p) => files.list(p.root, p.dir ?? ''),
    'files.read': (p) => files.read(p.root, p.path),
    'files.write': (p, actor) => files.write(p.root, p.path, p.content, p.baseSha, actor),
    'files.backups': (p) => files.backups(p.root, p.path),
    'files.readBackup': (p) => ({ content: files.readBackup(p.root, p.path, p.backupId).toString('utf8') }),
    'files.restore': (p) => files.restore(p.root, p.path, p.backupId),

    // --- RCon ---
    'rcon.players': async () => parsePlayers(await rconCmd('players')),
    'rcon.say': async (p) => {
      const to = p.to === undefined ? -1 : check.int(p.to, 'to', { min: -1, max: 1000 });
      await rconCmd(`say ${to} ${check.text(p.message, 'message')}`);
      return { sent: true };
    },
    'rcon.kick': async (p) => {
      const id = check.int(p.id, 'id', { max: 1000 });
      await rconCmd(`kick ${id} ${p.reason ? check.text(p.reason, 'reason', 100) : ''}`.trim());
      return { kicked: id };
    },
    // Бан онлайн-игрока по номеру или офлайн по GUID. minutes = 0 — навсегда.
    'rcon.ban': async (p) => {
      const minutes = check.int(p.minutes ?? 0, 'minutes', { max: 5_256_000 });
      const reason = p.reason ? check.text(p.reason, 'reason', 100) : 'Banned';
      if (p.guid !== undefined) {
        const guid = check.string(p.guid, 'guid', { pattern: /^[0-9a-f]{32}$/i });
        await rconCmd(`addBan ${guid} ${minutes} ${reason}`);
      } else {
        await rconCmd(`ban ${check.int(p.id, 'id', { max: 1000 })} ${minutes} ${reason}`);
      }
      await rconCmd('writeBans');
      return { banned: true };
    },
    'rcon.bans': async () => parseBans(await rconCmd('bans')),
    'rcon.unban': async (p) => {
      await rconCmd(`removeBan ${check.int(p.index, 'index', { max: 100000 })}`);
      await rconCmd('writeBans');
      return { unbanned: true };
    },
    // Произвольная команда BattlEye — выключено по умолчанию (rcon.allowRaw в config.json).
    'rcon.raw': async (p) => {
      if (!rconCfg.allowRaw) throw new AgentError('denied', 'rcon.raw выключен в config.json агента');
      return { output: await rconCmd(check.text(p.command, 'command', 300)) };
    },

    // --- Логи ---
    'logs.list': () => logs.list(),
    'logs.tail': (p) => logs.tail(p.file, p.lines ?? 200),
    'logs.follow': (p) => logs.follow(p.file),
    'logs.unfollow': (p) => logs.unfollow(p.file),

    // --- Моды ---
    'mods.list': () => mods.list(server.mods()),
    'mods.set': (p) => server.setMods({ mods: MOD_LIST(p.mods, 'mods'), serverMods: MOD_LIST(p.serverMods ?? [], 'serverMods') }),
    'mods.update': async (p) => {
      if ((await server.status()).running) {
        throw new AgentError('server_running', 'Останови сервер или используй рестарт с обновлением модов');
      }
      return mods.update(MOD_LIST(p.folders, 'folders'));
    },
  };
}
