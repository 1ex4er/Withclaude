// Генерация пары ключей Ed25519.
//   node tools/keygen.js site   -> keys/site_private.pem, keys/site_public.pem
//   node tools/keygen.js agent  -> keys/agent_private.pem, keys/agent_public.pem
// Приватный ключ никогда не покидает свою машину. Обмениваются только *_public.pem.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const who = process.argv[2];
if (!['site', 'agent'].includes(who)) {
  console.error('Использование: node tools/keygen.js <site|agent> [папка]');
  process.exit(1);
}
const dir = path.resolve(process.argv[3] ?? 'keys');
fs.mkdirSync(dir, { recursive: true });

const privFile = path.join(dir, `${who}_private.pem`);
if (fs.existsSync(privFile)) {
  console.error(`${privFile} уже существует — не перезаписываю.`);
  process.exit(1);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
fs.writeFileSync(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(path.join(dir, `${who}_public.pem`), publicKey.export({ type: 'spki', format: 'pem' }));
console.log(`Готово: ${dir}`);
console.log(`Приватный ключ (${who}_private.pem) оставь на этой машине, публичный передай второй стороне.`);
