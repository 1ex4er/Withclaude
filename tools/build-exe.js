// Сборка dist/lx-agent.exe — один файл, Node.js на сервере не нужен.
//   npm run build:exe
//
// Используется встроенная в Node.js упаковка (Single Executable Applications):
// код агента собирается в один файл и встраивается в официальный node.exe для Windows,
// контрольная сумма которого сверяется с nodejs.org.
//
// Публичный ключ сайта LX вшивается в .exe из release/lx_site_public.pem (он публичный, его можно коммитить).

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const cache = path.join(root, '.cache');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const nodeVersion = process.version;

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(cache, { recursive: true });

// 1. Один JS-файл со всем кодом агента.
const lxKeyFile = path.join(root, 'release', 'lx_site_public.pem');
const lxKey = fs.existsSync(lxKeyFile) ? fs.readFileSync(lxKeyFile, 'utf8') : null;
console.log(lxKey ? 'Ключ сайта LX: вшит' : 'Ключ сайта LX: нет release/lx_site_public.pem — sitePublicKey придётся указывать в config.json');

await esbuild.build({
  entryPoints: [path.join(root, 'agent', 'src', 'main.js')],
  outfile: path.join(dist, 'agent.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${nodeVersion.slice(1).split('.')[0]}`,
  minify: true,
  legalComments: 'none',
  external: ['bufferutil', 'utf-8-validate'],
  define: {
    __IS_EXE__: 'true',
    __VERSION__: JSON.stringify(pkg.version),
    __LX_SITE_PUBLIC_KEY__: JSON.stringify(lxKey),
    'import.meta.url': '"file:///"',
  },
  logLevel: 'warning',
});

// 2. Блоб для встраивания.
const seaConfig = path.join(dist, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify({
    main: path.join(dist, 'agent.cjs'),
    output: path.join(dist, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 3. Официальный node.exe той же версии, с проверкой SHA-256.
async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const nodeExe = path.join(cache, `node-${nodeVersion}-win-x64.exe`);
if (!fs.existsSync(nodeExe)) {
  const base = `https://nodejs.org/dist/${nodeVersion}`;
  const sums = (await download(`${base}/SHASUMS256.txt`)).toString();
  const expected = /^([0-9a-f]{64})\s+win-x64\/node\.exe$/m.exec(sums)?.[1];
  if (!expected) throw new Error('В SHASUMS256.txt нет win-x64/node.exe');
  console.log(`Скачиваю node.exe ${nodeVersion}...`);
  const bin = await download(`${base}/win-x64/node.exe`);
  const actual = crypto.createHash('sha256').update(bin).digest('hex');
  if (actual !== expected) throw new Error(`Контрольная сумма node.exe не совпала: ${actual}`);
  fs.writeFileSync(nodeExe, bin);
}

// 4. Встраиваем код.
const out = path.join(dist, 'lx-agent.exe');
fs.copyFileSync(nodeExe, out);
const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(
  process.execPath,
  [postject, out, 'NODE_SEA_BLOB', path.join(dist, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', '--overwrite'],
  { stdio: 'inherit' },
);

for (const f of ['agent.cjs', 'sea-prep.blob', 'sea-config.json']) fs.rmSync(path.join(dist, f));
const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`Готово: ${out} (${size} МБ, Node ${nodeVersion}, агент ${pkg.version})`);
