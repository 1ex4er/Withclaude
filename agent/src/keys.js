// Ключ агента. Создаётся один раз при первом запуске.
// На Windows приватный ключ шифруется через DPAPI (область компьютера): скопированный на другую
// машину файл бесполезен. Публичный ключ лежит рядом открыто — его передают сайту.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PS = (op) =>
  'Add-Type -AssemblyName System.Security;' +
  '$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
  `$o=[System.Security.Cryptography.ProtectedData]::${op}($b,$null,'LocalMachine');` +
  '[Console]::Out.Write([Convert]::ToBase64String($o))';

function dpapi(op, data) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS(op)], {
    input: data.toString('base64'),
    windowsHide: true,
  });
  return Buffer.from(out.toString().trim(), 'base64');
}

export function loadOrCreateAgentKey(dir) {
  const keyFile = path.join(dir, 'agent.key');
  const pubFile = path.join(dir, 'agent_public.pem');
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(keyFile)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const der = privateKey.export({ type: 'pkcs8', format: 'der' });
    const stored =
      process.platform === 'win32'
        ? { format: 'dpapi', data: dpapi('Protect', der).toString('base64') }
        : { format: 'der', data: der.toString('base64') };
    fs.writeFileSync(keyFile, JSON.stringify(stored), { mode: 0o600 });
    fs.writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }));
  }

  const stored = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  let der = Buffer.from(stored.data, 'base64');
  if (stored.format === 'dpapi') der = dpapi('Unprotect', der);
  const privateKey = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
  return { privateKey, publicPem, pubFile };
}

export function fingerprint(publicPem) {
  return crypto.createHash('sha256').update(publicPem).digest('hex').slice(0, 16);
}
