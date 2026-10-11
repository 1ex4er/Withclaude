// Бэкап базы бота: копия через SQLite VACUUM INTO (согласованная, без остановки бота).
// Раз в сутки + при запуске, если последнему бэкапу больше суток. Хранятся последние N.

import fs from 'node:fs';
import path from 'node:path';

const NAME = /^bot-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/;

export function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => NAME.test(f))
    .sort()
    .map((f) => ({ file: f, size: fs.statSync(path.join(dir, f)).size }));
}

export function makeBackup(db, dir, keep, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  const file = path.join(dir, `bot-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const all = listBackups(dir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, old.file), { force: true });
  return { file: path.basename(file), size: fs.statSync(file).size };
}

export function scheduleBackups(db, { dir, keep, intervalHours }, log) {
  const run = () => {
    try {
      const b = makeBackup(db, dir, keep);
      log.info(`бэкап базы: ${b.file} (${Math.round(b.size / 1024)} КБ)`);
    } catch (e) {
      log.error(`бэкап базы не удался: ${e.message}`);
    }
  };
  const last = listBackups(dir).at(-1);
  const lastAt = last ? fs.statSync(path.join(dir, last.file)).mtimeMs : 0;
  if (Date.now() - lastAt > intervalHours * 3600e3) run();
  setInterval(run, intervalHours * 3600e3).unref();
}
