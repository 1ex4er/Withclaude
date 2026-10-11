# Бот Blackout

Discord-бот и служба управления сервером в одном процессе. Работает на хостинге сайта.

| Модуль | Что делает |
|---|---|
| Статус | Живое сообщение со статусом (онлайн, аптайм, следующий рестарт), статус бота «12/60 в Зоне», тревоги о падении сервера и потере связи с агентом |
| Управление сервером | `/server status/start/stop/restart/cancel-restart/schedule`, `/rcon players/say/kick/ban/ban-steam/bans/unban`. Стоп, рестарт и бан — только после кнопки подтверждения; все действия пишутся в `adminLog` |
| Игровые логи | Из ADM-лога: входы и выходы, убийства (кто, кого, чем, с какой дистанции), игровой чат. После рестарта бот сам переключается на новый ADM-файл |
| Steam и вайтлист | `/steam` — привязка через официальный вход Steam. `/whitelist add/remove/info/unlink`. Вайтлист пишется в `whitelist.txt` через агента; если агент не в сети, изменения ждут в очереди |
| Проверка банов | `/check` по Steam (VAC, игровые баны, баны сообщества, возраст аккаунта, часы в DayZ) и по подключаемым базам. Автоматически — в каждой анкете и при привязке Steam |
| Анкеты | Форма персонажа → канал модераторов → «Принять» (роли и вайтлист) или «Отклонить» (с причиной, повторная подача через N часов). Ответ игроку приходит в личные сообщения |
| Тикеты | Выбор темы → приватный канал с автором и персоналом → «Взять», «Закрыть» → расшифровка в архив |
| Верификация | Кнопка «Я прочитал правила» + проверка «нажми нужную картинку». Слишком новые аккаунты не проходят автоматически |
| Роли | Панель ролей по кнопкам. Роли с правами модерации выдать через панель нельзя |
| Модерация | `/warn` (3 предупреждения — мут, 5 — бан), `/warns`, `/unwarn`, `/mute`, `/unmute`, `/kick`, `/ban` (в том числе временный), `/unban`, `/clear` |
| Автомодерация | Удаление скам-ссылок (поддельные домены Discord и Steam, «раздачи нитро») с мутом, чужих инвайтов, флуда, повторов, массовых упоминаний |
| Антирейд | Волна входов → режим рейда: новые участники кикаются, админы получают пинг. `/raidmode on/off` |
| Антинюк | Кто-то массово удаляет каналы или роли, банит, кикает, создаёт вебхуки → с него снимаются все роли и выдаётся мут (бота выгоняют), админы получают пинг |

Права: **поддержка** — смотреть статус, игроков, предупреждения, брать тикеты. **Модератор** — say, kick, анкеты,
вайтлист, warn, mute, kick. **Администратор** — сервер, баны, панели, режим рейда.

## HunterEye и другие базы банов

У HunterEye нет публичного API: на их сайте каждый может проверить только свой аккаунт через вход Steam.
Чтобы бот проверял игроков по их базе, нужен доступ к API от команды HunterEye (их Discord поддержки указан
на he.kgb.rest). Когда доступ будет, базу подключает одна запись в `config.json`, без изменений в коде:

```json
"banCheck": {
  "providers": [
    { "name": "HunterEye", "url": "https://…/check?steamid={steamId}", "tokenEnv": "HUNTEREYE_TOKEN",
      "listField": "bans", "reasonField": "reason", "projectField": "project", "dateField": "date" }
  ]
}
```

Поля подстраиваются под их формат ответа. Так же можно подключить любую другую базу проектов.

## Установка

1. **Discord Developer Portal** → New Application → Bot:
   - включи **Server Members Intent** и **Message Content Intent**;
   - скопируй токен в `bot/.env` (`DISCORD_TOKEN`).
2. **Приглашение бота:** OAuth2 → URL Generator → `bot` + `applications.commands`, право **Administrator**.
   В настройках ролей Discord-сервера подними роль бота **выше всех ролей персонала**, иначе антинюк и модерация не сработают.
3. **На хостинге сайта** (Node.js 22.13 или новее):
   ```bash
   git clone … && cd …
   npm ci --omit=dev
   node tools/keygen.js site bot/keys           # bot/keys/site_private.pem остаётся здесь
   cp bot/config.example.json bot/config.json   # достаточно вписать guildId, остальное — через /setup
   cp bot/.env.example bot/.env                 # токены
   ```
   Положи `agent_public.pem` с VDS (`lx-agent.exe pubkey`) в `bot/keys/`, а `bot/keys/site_public.pem` — на VDS.
   Пути к ключам задаются в `bot/config.json` → `agent`.
4. **nginx** (в блоке `server` сайта):
   ```nginx
   location /agent-ws { proxy_pass http://127.0.0.1:3100; proxy_http_version 1.1;
     proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";
     proxy_set_header X-Forwarded-For $remote_addr; proxy_read_timeout 1h; }
   location /link/steam/ { proxy_pass http://127.0.0.1:3100; }
   ```
   `/api/` наружу не открывай: админка сайта обращается к нему локально, на `http://127.0.0.1:3100/api/…`.
5. **Запуск:** `pm2 start bot/src/index.js --name blackout-bot` (или systemd).
6. **В Discord:** `/setup roles` и `/setup channels` — выбрать роли и каналы из списков (ID копировать не нужно,
   `/setup show` — проверить, `/setup roles-list` — выгрузить все роли сервера с ID). Затем `/panel verify`, `/panel applications`, `/panel tickets`, `/panel roles` — в нужных каналах.
7. **На сервере DayZ:** в `serverDZ.cfg` выставь `enableWhitelist = 1;`. Агенту укажи
   `wss://blackoutstalkerrp.ru/agent-ws` и `agentId` `blackout-main`.

## API для админки сайта

```
POST http://127.0.0.1:3100/api/agent/call
Authorization: Bearer <API_TOKEN>
{ "action": "files.read", "params": { "root": "mission", "path": "db/types.xml" }, "actor": { "steamId": "…", "name": "Admin" } }

GET  http://127.0.0.1:3100/api/links?discordId=… | ?steamId=…
```

Права админа сайт проверяет сам до вызова API.
