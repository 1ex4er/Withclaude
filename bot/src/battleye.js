import crypto from 'node:crypto';

// BattlEye GUID из SteamID64: MD5("BE" + SteamID64 как 8 байт little-endian).
export function steamToBeGuid(steamId) {
  if (!/^\d{17}$/.test(String(steamId))) throw new Error('SteamID64 — 17 цифр');
  const buf = Buffer.alloc(10);
  buf.write('BE', 0, 'ascii');
  buf.writeBigUInt64LE(BigInt(steamId), 2);
  return crypto.createHash('md5').update(buf).digest('hex');
}
