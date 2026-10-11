import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { test } from 'node:test';
import { HubConnection } from '../agent/src/connection.js';
import { AgentHub } from '../site-kit/hub.js';

const quiet = { info() {}, warn() {}, error() {} };
const site = crypto.generateKeyPairSync('ed25519');
const agent = crypto.generateKeyPairSync('ed25519');
const stranger = crypto.generateKeyPairSync('ed25519');

const agentPem = agent.publicKey.export({ type: 'spki', format: 'pem' });

async function setup({ agentKey = agent.privateKey, siteKeyForAgent = site.publicKey, allow = ['*'], license, authorize } = {}) {
  const hub = new AgentHub({
    sitePrivateKey: site.privateKey,
    agents: authorize ? {} : { 'blackout-main': agent.publicKey },
    authorize,
    callTimeoutMs: 2000,
  });
  const srv = http.createServer();
  hub.attach(srv, '/agent-ws');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const calls = [];
  const conn = new HubConnection({
    hub: { name: 'test', url: `ws://127.0.0.1:${srv.address().port}/agent-ws`, allow, license },
    agentId: 'blackout-main',
    agentKey,
    agentPublicPem: agentPem,
    siteKey: siteKeyForAgent,
    handler: async (action, params, actor, hubName) => {
      calls.push({ action, params, actor, hubName });
      return action === 'fail' ? { ok: false, error: { code: 'x', message: 'boom' } } : { ok: true, result: { echo: params } };
    },
    log: quiet,
    version: 'test',
  });
  const cleanup = () => {
    conn.stop();
    hub.close();
    srv.close();
  };
  return { hub, conn, calls, cleanup };
}

const once = (emitter, ev, ms = 2000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`нет события ${ev}`)), ms);
    emitter.once(ev, (...a) => (clearTimeout(t), resolve(a)));
  });

test('агент подключается, выполняет подписанную команду и шлёт события', async () => {
  const { hub, conn, calls, cleanup } = await setup();
  try {
    const online = once(hub, 'online');
    conn.start();
    await online;
    assert.ok(hub.isOnline('blackout-main'));
    const res = await hub.call('blackout-main', 'files.read', { path: 'a.cfg' }, { steamId: '7656', name: 'Admin' });
    assert.deepEqual(res, { echo: { path: 'a.cfg' } });
    assert.deepEqual(calls[0].actor, { steamId: '7656', name: 'Admin' });
    await assert.rejects(hub.call('blackout-main', 'fail'), { code: 'x' });

    const ev = once(hub, 'event');
    conn.send({ type: 'event', topic: 'rcon', data: { text: 'hi' } });
    assert.deepEqual(await ev, ['blackout-main', 'rcon', { text: 'hi' }]);
  } finally {
    cleanup();
  }
});

test('чужой агент не проходит рукопожатие', async () => {
  const { hub, conn, cleanup } = await setup({ agentKey: stranger.privateKey });
  try {
    const failed = once(hub, 'authFailed');
    conn.start();
    await failed;
    assert.ok(!hub.isOnline('blackout-main'));
  } finally {
    cleanup();
  }
});

test('агент не выполняет команды, подписанные не ключом сайта', async () => {
  // Агент доверяет другому ключу — значит, подпись сайта для него чужая.
  const { hub, conn, calls, cleanup } = await setup({ siteKeyForAgent: stranger.publicKey });
  try {
    const online = once(hub, 'online');
    conn.start();
    await online;
    await assert.rejects(hub.call('blackout-main', 'server.stop'), { code: 'bad_signature' });
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test('перехваченную команду нельзя отправить повторно', async () => {
  const { hub, conn, calls, cleanup } = await setup();
  try {
    const online = once(hub, 'online');
    conn.start();
    await online;
    const ws = hub.sockets.get('blackout-main');
    const sent = [];
    const origSend = ws.send.bind(ws);
    ws.send = (data) => (sent.push(data), origSend(data));
    await hub.call('blackout-main', 'server.status');
    const replies = [];
    ws.on('message', (d) => replies.push(JSON.parse(d)));
    origSend(sent[0]);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls.length, 1);
    assert.equal(replies.at(-1).error.code, 'replay');
  } finally {
    cleanup();
  }
});

test('сайт не может выйти за пределы allow агента', async () => {
  const { hub, conn, calls, cleanup } = await setup({ allow: ['agent.info', 'lx.*'] });
  try {
    const online = once(hub, 'online');
    conn.start();
    const [, info] = await online;
    assert.deepEqual(info.allow, ['agent.info', 'lx.*']);
    await hub.call('blackout-main', 'lx.read', {});
    await assert.rejects(hub.call('blackout-main', 'server.stop'), { code: 'forbidden' });
    await assert.rejects(hub.call('blackout-main', 'files.read', {}), { code: 'forbidden' });
    assert.deepEqual(calls.map((c) => c.action), ['lx.read']);
  } finally {
    cleanup();
  }
});

test('агент покупателя пускается по лицензии через authorize', async () => {
  const seen = [];
  const authorize = async (hello, ip) => {
    seen.push({ license: hello.license, ip });
    return hello.license === 'LX-GOOD-LICENSE' ? { id: 'lic-1', publicKey: hello.pub } : null;
  };
  const good = await setup({ license: 'LX-GOOD-LICENSE', authorize, allow: ['lx.*'] });
  try {
    const online = once(good.hub, 'online');
    good.conn.start();
    const [id, info] = await online;
    assert.equal(id, 'lic-1');
    assert.equal(info.license, 'LX-GOOD-LICENSE');
    assert.deepEqual(await good.hub.call('lic-1', 'lx.list', { root: 'lx' }), { echo: { root: 'lx' } });
    assert.equal(seen[0].ip, '127.0.0.1');
  } finally {
    good.cleanup();
  }

  const bad = await setup({ license: 'LX-BAD-LICENSE0', authorize });
  try {
    const failed = once(bad.hub, 'authFailed');
    bad.conn.start();
    assert.equal((await failed)[0].license, 'LX-BAD-LICENSE0');
  } finally {
    bad.cleanup();
  }
});
