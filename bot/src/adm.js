// Разбор ADM-лога DayZ (profiles/*.ADM) на события для Discord.
// Примеры строк:
//   12:00:01 | Player "Ivan" (id=AbC123= pos=<1.0, 2.0, 3.0>) is connected
//   12:00:01 | Player "Ivan"(id=AbC123=) has been disconnected
//   12:00:01 | Player "Ivan" (DEAD) (id=AbC123= pos=<...>) killed by Player "Petr" (id=XyZ= pos=<...>) with M4A1 from 42.5 meters
//   12:00:01 | Player "Ivan" (DEAD) (id=AbC123= pos=<...>) killed by Wolf
//   12:00:01 | Player "Ivan" (DEAD) (id=AbC123= pos=<...>) died. Stats> Water: 0 Energy: 0 Bleed sources: 0
//   12:00:01 | Chat("Ivan"(id=AbC123=)): привет

const TIME = /^(\d{1,2}:\d{2}:\d{2})\s*\|\s*/;
const NAME = '"((?:[^"\\\\]|\\\\.)*)"';

const PATTERNS = [
  {
    type: 'chat',
    re: new RegExp(`^Chat\\(${NAME}\\s*\\(id=([^\\s)]+)\\)\\):\\s?(.*)$`),
    map: (m) => ({ name: m[1], id: m[2], text: m[3] }),
  },
  {
    type: 'connect',
    re: new RegExp(`^Player ${NAME}\\s*\\(id=([^\\s)]+)[^)]*\\)\\s+is connected`),
    map: (m) => ({ name: m[1], id: m[2] }),
  },
  {
    type: 'disconnect',
    re: new RegExp(`^Player ${NAME}\\s*\\(id=([^\\s)]+)[^)]*\\)\\s+has been disconnected`),
    map: (m) => ({ name: m[1], id: m[2] }),
  },
  {
    type: 'pvp',
    re: new RegExp(
      `^Player ${NAME}\\s*(?:\\(DEAD\\)\\s*)?\\(id=([^\\s)]+)[^)]*\\)\\s+killed by Player ${NAME}\\s*\\(id=([^\\s)]+)[^)]*\\)(?:\\s+with\\s+(.+?))?(?:\\s+from\\s+([\\d.]+)\\s+meters)?\\s*$`,
    ),
    map: (m) => ({ victim: m[1], victimId: m[2], killer: m[3], killerId: m[4], weapon: m[5] ?? null, distance: m[6] ? Number(m[6]) : null }),
  },
  {
    type: 'death',
    re: new RegExp(`^Player ${NAME}\\s*(?:\\(DEAD\\)\\s*)?\\(id=([^\\s)]+)[^)]*\\)\\s+(?:killed by (.+)|died\\..*|committed suicide.*|bled out.*)$`),
    map: (m) => ({ name: m[1], id: m[2], cause: m[3]?.trim() ?? null }),
  },
];

export function parseAdmLine(line) {
  const t = TIME.exec(line);
  if (!t) return null;
  const body = line.slice(t[0].length).trim();
  for (const p of PATTERNS) {
    const m = p.re.exec(body);
    if (m) return { type: p.type, time: t[1], ...p.map(m) };
  }
  return null;
}

// Самый свежий ADM-файл из списка logs.list агента.
export function newestAdm(files) {
  return files.filter((f) => f.file.toLowerCase().endsWith('.adm')).sort((a, b) => b.mtime - a.mtime)[0]?.file ?? null;
}
