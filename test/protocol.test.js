import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { ReplayGuard, canonicalize, sign, verify } from '../shared/protocol.js';

const site = crypto.generateKeyPairSync('ed25519');
const other = crypto.generateKeyPairSync('ed25519');

test('canonicalize не зависит от порядка ключей', () => {
  assert.equal(canonicalize({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), canonicalize({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
});

test('подпись проверяется только правильным ключом и без изменений', () => {
  const msg = sign({ type: 'cmd', action: 'server.stop', params: { force: false } }, site.privateKey);
  assert.ok(verify(msg, site.publicKey));
  assert.ok(!verify(msg, other.publicKey));
  assert.ok(!verify({ ...msg, action: 'server.start' }, site.publicKey));
  assert.ok(!verify({ ...msg, params: { force: true } }, site.publicKey));
  assert.ok(!verify({ ...msg, sig: undefined }, site.publicKey));
  assert.ok(!verify({ ...msg, sig: 'мусор' }, site.publicKey));
});

test('ReplayGuard отклоняет повтор и старые команды', () => {
  const g = new ReplayGuard();
  const now = Date.now();
  assert.equal(g.check('n'.repeat(20), now, now), null);
  assert.equal(g.check('n'.repeat(20), now, now), 'replay');
  assert.equal(g.check('m'.repeat(20), now - 60_000, now), 'stale');
  assert.equal(g.check('short', now, now), 'bad_nonce');
});
