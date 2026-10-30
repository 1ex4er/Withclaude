import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loginWithRetry } from '../bot/src/login.js';

const log = { warn: () => {} };

test('вход: сетевая ошибка — повтор с растущей паузой, затем успех', async () => {
  let calls = 0;
  const delays = [];
  const client = {
    login: async () => {
      if (++calls < 4) throw Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' });
      return 'ok';
    },
  };
  assert.equal(await loginWithRetry(client, 't', log, async (ms) => delays.push(ms)), 'ok');
  assert.deepEqual(delays, [15_000, 30_000, 60_000]);
});

test('вход: неверный токен и 4xx не повторяются', async () => {
  for (const err of [{ code: 'TokenInvalid' }, { code: 'DisallowedIntents' }, { status: 401 }]) {
    const client = { login: async () => Promise.reject(Object.assign(new Error('x'), err)) };
    await assert.rejects(loginWithRetry(client, 't', log, async () => assert.fail('не должно быть повтора')));
  }
});

test('вход: 429 и 5xx повторяются', async () => {
  let calls = 0;
  const client = {
    login: async () => {
      if (++calls === 1) throw Object.assign(new Error('x'), { status: 429 });
      if (calls === 2) throw Object.assign(new Error('x'), { status: 503 });
      return 'ok';
    },
  };
  assert.equal(await loginWithRetry(client, 't', log, async () => {}), 'ok');
});
