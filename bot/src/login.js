// Вход в Discord с повторами: при плохой сети (блокировка, сбой прокси) бот не падает, а пробует снова.
// Ошибки, которые повтором не лечатся (неверный токен, запрещённые интенты, 4xx), пробрасываются наверх.

const FATAL_CODES = new Set(['TokenInvalid', 'DisallowedIntents']);
const FIRST_DELAY = 15_000;
const MAX_DELAY = 5 * 60_000;

const isFatal = (e) => FATAL_CODES.has(e?.code) || (e?.status >= 400 && e?.status < 500 && e?.status !== 429);

export async function loginWithRetry(client, token, log, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  for (let delay = FIRST_DELAY; ; delay = Math.min(delay * 2, MAX_DELAY)) {
    try {
      return await client.login(token);
    } catch (e) {
      if (isFatal(e)) throw e;
      log.warn(`вход в Discord не удался: ${e.message}; повтор через ${delay / 1000} с`);
      await sleep(delay);
    }
  }
}
