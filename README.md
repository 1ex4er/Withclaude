# Blackout — управление DayZ-сервером с сайта

Агент на Windows VDS и модуль для сайта blackoutstalkerrp.ru. Админка сайта управляет сервером:
старт, стоп и рестарт (в том числе по расписанию), редактор конфигов с бэкапами, RCon (игроки, кик,
бан, сообщения), логи в реальном времени, моды и их обновление через SteamCMD.

```
Админка сайта ──(вход через Steam + список админов + 2FA)──► AgentHub (site-kit/hub.js)
                                                                  ▲
                                         WSS (TLS), агент подключается сам
                                                                  │
Windows VDS:  агент (agent/) ──► DayZServer_x64.exe, файлы конфигов, BattlEye RCon (127.0.0.1)
```

## Защита

| Угроза | Что мешает |
|---|---|
| Перехват трафика | Только `wss://` (TLS). Дополнительно можно привязать агента к отпечатку сертификата сайта (`tlsPinSha256`) |
| Подключение к агенту извне | Входящих портов у агента нет: он сам подключается к сайту |
| Поддельный агент | При подключении агент подписывает одноразовый вызов своим ключом Ed25519, сайт проверяет его публичным ключом |
| Поддельные команды | Каждую команду сайт подписывает своим приватным ключом. На VDS лежит только публичный ключ сайта |
| Повтор перехваченной команды | В подписи время и одноразовый nonce; команды старше 30 с и повторы отклоняются |
| Взлом сайта | Агент умеет только действия из списка `agent/src/actions.js`: нет выполнения команд, нет доступа к файлам вне `files.roots`, нет `.exe/.dll/.bat` и папки `battleye`, строка запуска собирается только из конфига агента |
| Утечка паролей | RCon-пароль только в `agent/.env` на VDS. `passwordAdmin` в `serverDZ.cfg` показывается на сайте как `********` и при сохранении остаётся прежним |
| Ошибка в конфиге | Проверка XML/JSON перед сохранением, бэкап каждой версии, откат в один клик, защита от одновременной правки двумя админами |
| «Кто это сделал?» | Журнал `agent/audit.log`: кто (SteamID), что, когда, результат |

Важно: часы на VDS и на сайте должны быть синхронизированы (служба времени Windows и NTP на хостинге),
иначе команды будут отклоняться как устаревшие.

## Установка агента на Windows VDS

1. Установи [Node.js LTS](https://nodejs.org) (20.12 или новее).
2. Скопируй репозиторий, например в `C:\DayZAgent`, и выполни там `npm ci --omit=dev`.
3. Ключи:
   - на VDS: `node tools/keygen.js agent` → `keys/agent_private.pem` остаётся на VDS,
     `keys/agent_public.pem` отдаёшь сайту;
   - на сайте: `node tools/keygen.js site` → `keys/site_private.pem` остаётся на сайте,
     `keys/site_public.pem` кладёшь на VDS в `C:\DayZAgent\keys\`.
4. `agent/config.example.json` → `agent/config.json`, поправь пути к серверу.
   `agent/.env.example` → `agent/.env`, впиши `RCON_PASSWORD` (тот же, что в `beserver_x64.cfg`).
5. В `battleye/beserver_x64.cfg` должны быть `RConPort 2306` и `RConIP 127.0.0.1`.
   Порт RCon закрой во входящих правилах Windows Firewall.
6. Проверка: `node agent/src/index.js`. В консоли должно появиться «подключён к сайту».
7. Запуск как служба (переживает перезагрузку), через [NSSM](https://nssm.cc):
   ```
   nssm install BlackoutAgent "C:\Program Files\nodejs\node.exe" "C:\DayZAgent\agent\src\index.js"
   nssm set BlackoutAgent AppDirectory C:\DayZAgent
   nssm set BlackoutAgent ObjectName .\dayzagent <пароль>
   nssm start BlackoutAgent
   ```
   `dayzagent` — отдельный пользователь Windows без прав администратора, у которого есть права
   только на `C:\DayZServer`, `C:\DayZAgent` и `C:\steamcmd`.

Если сервер уже запущен через `.bat`, агент найдёт процесс и возьмёт его под управление.
Старый `.bat` и планировщик рестартов после этого отключи, иначе они будут конфликтовать с агентом.

## Подключение к сайту

```js
import { AgentHub } from './site-kit/hub.js';

const hub = new AgentHub({
  sitePrivateKey: './keys/site_private.pem',
  agents: { 'blackout-main': './keys/agent_public.pem' },
});
hub.attach(httpServer, '/agent-ws'); // тот же HTTP(S)-сервер, что у сайта

// В обработчике админки — только после проверки, что пользователь админ:
const players = await hub.call('blackout-main', 'rcon.players', {}, { steamId, name });

hub.on('event', (agentId, topic, data) => { /* 'server' | 'rcon' | 'log' → отправить в браузер админа */ });
```

Если сайт стоит за nginx, для `/agent-ws` нужно проксировать WebSocket
(`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`).

## Команды агента

| Действие | Параметры |
|---|---|
| `server.status` / `server.start` | — |
| `server.stop` | `force?` — без мягкой остановки |
| `server.restart` | `updateMods?` — обновить Workshop-моды между остановкой и запуском |
| `server.restartIn` / `server.cancelRestart` | `minutes` — рестарт с предупреждениями в чат |
| `server.getSchedule` / `server.setSchedule` | `restarts: ["04:00", ...]` |
| `files.roots` / `files.list` | `root`, `dir?` |
| `files.read` | `root`, `path` → `content`, `sha` |
| `files.write` | `root`, `path`, `content`, `baseSha` (из `files.read`) |
| `files.backups` / `files.readBackup` / `files.restore` | `root`, `path`, `backupId` |
| `rcon.players` / `rcon.bans` | — |
| `rcon.say` | `message`, `to?` (номер игрока, по умолчанию всем) |
| `rcon.kick` | `id`, `reason?` |
| `rcon.ban` | `id` или `guid`, `minutes` (0 — навсегда), `reason?` |
| `rcon.unban` | `index` из `rcon.bans` |
| `rcon.raw` | `command`. Выключено, пока в конфиге нет `rcon.allowRaw: true` |
| `logs.list` / `logs.tail` | `file`, `lines?` |
| `logs.follow` / `logs.unfollow` | `file` → события `log` с новыми строками |
| `mods.list` / `mods.set` | `mods`, `serverMods` (применяются при следующем рестарте) |
| `mods.update` | `folders` (сервер должен быть остановлен) |

## Разработка

```
npm install
npm test
```
