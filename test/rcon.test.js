import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { test } from 'node:test';
import { BERcon, buildPacket, crc32, parsePacket, parsePlayers } from '../agent/src/rcon.js';

test('crc32', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('пакет собирается и разбирается, битый — отбрасывается', () => {
  const p = buildPacket(1, Buffer.from([5, 0x41]));
  assert.deepEqual(parsePacket(p), { type: 1, body: Buffer.from([5, 0x41]) });
  p[9] ^= 1;
  assert.equal(parsePacket(p), null);
});

test('разбор списка игроков', () => {
  const text = [
    'Players on server:',
    '[#] [IP Address]:[Port] [Ping] [GUID] [Name]',
    '--------------------------------------------------',
    '0   1.2.3.4:2304    47   0123456789abcdef0123456789abcdef(OK) Иван Сталкер',
    '1   5.6.7.8:2304    120  fedcba9876543210fedcba9876543210(?) Bob (Lobby)',
    '(2 players in total)',
  ].join('\n');
  const players = parsePlayers(text);
  assert.equal(players.length, 2);
  assert.deepEqual(players[0], { id: 0, ip: '1.2.3.4', port: 2304, ping: 47, guid: '0123456789abcdef0123456789abcdef', verified: true, name: 'Иван Сталкер', lobby: false });
  assert.equal(players[1].lobby, true);
  assert.equal(players[1].verified, false);
});

// Мини-эмулятор BattlEye: логин, многочастный ответ, сообщение сервера с подтверждением.
function fakeBE(password) {
  const sock = dgram.createSocket('udp4');
  const acks = [];
  sock.on('message', (msg, rinfo) => {
    const p = parsePacket(msg);
    const reply = (type, body) => sock.send(buildPacket(type, body), rinfo.port, rinfo.address);
    if (p.type === 0) {
      reply(0, Buffer.from([p.body.toString() === password ? 1 : 0]));
      if (p.body.toString() === password) reply(2, Buffer.concat([Buffer.from([7]), Buffer.from('Player #0 connected')]));
    } else if (p.type === 1) {
      const seq = p.body[0];
      const cmd = p.body.subarray(1).toString();
      if (cmd === 'players') {
        reply(1, Buffer.concat([Buffer.from([seq, 0, 2, 1]), Buffer.from('world')]));
        reply(1, Buffer.concat([Buffer.from([seq, 0, 2, 0]), Buffer.from('hello ')]));
      } else {
        reply(1, Buffer.from([seq]));
      }
    } else if (p.type === 2) {
      acks.push(p.body[0]);
    }
  });
  return new Promise((r) => sock.bind(0, '127.0.0.1', () => r({ sock, port: sock.address().port, acks })));
}

test('RCon: вход, многочастный ответ, подтверждение сообщений', async () => {
  const be = await fakeBE('pw');
  const rcon = new BERcon({ host: '127.0.0.1', port: be.port, password: 'pw', timeoutMs: 1000 });
  const messages = [];
  rcon.on('message', (m) => messages.push(m));
  try {
    assert.equal(await rcon.command('players'), 'hello world');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(messages, ['Player #0 connected']);
    assert.deepEqual(be.acks, [7]);
  } finally {
    rcon.close();
    be.sock.close();
  }
});

test('RCon: неверный пароль', async () => {
  const be = await fakeBE('pw');
  const rcon = new BERcon({ host: '127.0.0.1', port: be.port, password: 'wrong', timeoutMs: 1000 });
  try {
    await assert.rejects(rcon.connect(), { code: 'rcon_auth' });
  } finally {
    rcon.close();
    be.sock.close();
  }
});
