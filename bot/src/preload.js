// Загружается ПЕРВЫМ (до discord.js): читает .env и, если задан DISCORD_PROXY, пускает весь трафик
// бота к Discord через прокси — для серверов в странах, где Discord заблокирован.
//   DISCORD_PROXY=socks5://127.0.0.1:1080   (например, tpws/zapret, xray, ssh -D)

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(path.dirname(path.resolve(process.argv[2] ?? path.join(here, '..', 'config.json'))), '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

export let proxyAgent = null;

if (process.env.DISCORD_PROXY) {
  const url = process.env.DISCORD_PROXY;
  if (!/^socks(4|4a|5|5h)?:\/\//.test(url)) throw new Error('DISCORD_PROXY: ожидается socks5://хост:порт');
  // Синхронно (без top-level await), чтобы прокси гарантированно был готов до загрузки discord.js.
  const { SocksProxyAgent } = createRequire(import.meta.url)('socks-proxy-agent');
  proxyAgent = new SocksProxyAgent(url);

  // Gateway discord.js создаёт соединение через пакет ws — подменяем его конструктор,
  // чтобы добавить agent. Делается до загрузки discord.js.
  const wsRequire = createRequire(createRequire(import.meta.url).resolve('@discordjs/ws'));
  const ws = wsRequire('ws');
  const Original = ws.WebSocket;
  const agent = proxyAgent;
  class ProxiedWebSocket extends Original {
    constructor(address, protocols, options) {
      super(address, protocols, { ...options, agent });
    }
  }
  ws.WebSocket = ProxiedWebSocket;
  console.log(`[info] Discord через прокси ${url.replace(/\/\/[^@]*@/, '//***@')}`);
}
