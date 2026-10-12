# Проект Blackout — контекст для новых сессий

**Сначала прочитай `docs/SESSION_LOG.md`** — полный журнал первой сессии (решения, развёртывание, что осталось).

Владелец: DayZ-сервер **BLACKOUT — S.T.A.L.K.E.R. Hard RP** (blackoutstalkerrp.ru) и магазин модов
**LX × CHNGZ** (lxmodschngz.ru). Общение на русском, пользователь часто работает с телефона —
давать готовые блоки команд для копирования, коротко.

## Что в репозитории
- `bot/` — Discord-бот Blackout + служба управления сервером (discord.js, node:sqlite, без нативных модулей).
  Модули: status, admin (/server, /rcon), gamelogs (ADM), steam (/steam, /check, /whitelist), applications
  (анкеты), tickets, verify (капча + ввод SteamID), roles, panels (/panel), setup (/setup — роли и каналы
  выбираются в Discord, хранятся в БД поверх config.json), moderation, automod, antiraid (+антинюк).
- `agent/` — LX Agent (`lx-agent.exe`, Node SEA) для Windows VDS с DayZ: процесс, конфиги с бэкапами,
  BattlEye RCon, логи, моды. Несколько сайтов, у каждого свой `allow`. Сборка и проверка — GitHub Actions.
- `site-kit/hub.js` — приём подключений агентов (подписи Ed25519). `shared/protocol.js` — протокол.
- Тесты: `npm test`, линт: `npm run lint`.

## Как развёрнуто (на 12.10.2026)
- **12.10 бот перенесён с сервера LX на сервер сайта Blackout** (Ubuntu 22.04, OpenVZ, IHC, 130.49.173.178,
  SSH root по ключу): `/opt/blackout` (git clone), systemd `blackout-bot`, пользователь `blackoutbot`. Обновление:
  `cd /opt/blackout && git pull && chown -R blackoutbot:blackoutbot /opt/blackout && systemctl restart blackout-bot`
  На LX (130.49.173.185) старый бот остановлен и выключен, файлы оставлены для отката.
- OpenVZ: **не включать ufw/iptables с состоянием** (ломает SSH). Службы слушают только 127.0.0.1.
- Discord в РФ заблокирован → `DISCORD_PROXY=socks5h://127.0.0.1:1080`: tpws (zapret) в режиме SOCKS, служба
  `blackout-discord-proxy` (бинарник и список хостов скопированы с LX). Через него же — Steam API.
- nginx сайта (`/etc/nginx/sites-available/blackout`, в sites-enabled — симлинк) подключает
  `snippets/blackout-bot.conf`: `/discord/interactions`, `/link/steam/`, `/agent-ws` → 127.0.0.1:3100.
  `/api/` бота наружу НЕ открыт: сайт ходит к нему локально.
- Приём нажатий по HTTP включён (`DISCORD_PUBLIC_KEY`); Interactions Endpoint URL —
  `https://blackoutstalkerrp.ru/discord/interactions`.
- Сайт blackoutstalkerrp.ru (Next.js, `/srv/blackout-site`, исходники `E:\modding\blackout-web` у владельца)
  связан с ботом: `BOT_API_URL=http://127.0.0.1:3100`, `BOT_API_TOKEN` = `API_TOKEN` бота. Админка сайта:
  «Сервер» (статус/старт/стоп/рестарт/расписание, RCon, баны, логи), «Конфиги» (редактор с бэкапами),
  карточка игрока (варны, наказания, анкеты, вайтлист). Привязка Discord на сайте уходит боту (`method='site'`).
  API бота для сайта — `bot/src/site-api.js`.
- Есть автобэкап bot.db (bot/backups, 14 шт.), RP-наказания (/punish, роли NLR/NonRP/PG/RDM/Meta/Бан),
  карточка /profile.
- Сайт LX: `lx-helper` на 130.49.173.185 (`/opt/lx-helper`, Fastify + PostgreSQL + свой Discord-бот, платежи
  Robokassa), git на сервере нет; снимок исходников у владельца в `E:\modding\lx-helper`.
- Discord guildId: 1472216850745000099. Админ-роли бота: Гл. Администратор, Администратор,
  Тех. Администратор, Black. `commands.hideFromPlayers = false`.
- DayZ-сервер: 109.248.4.96:2302 (Windows), управляется через панель хостинга («ark-hoster»?) со своим батником.

## Что осталось
1. Игровой сервер: выяснить, есть ли RDP (тогда агент в «режиме панели» — без старт/стоп) или только веб-панель
   (тогда без агента: RCon напрямую + FTP/SFTP для логов и whitelist.txt). Не перезапускать сервер агентом,
   пока моды/параметры батника не перенесены в его config.json. Агент подключается к
   `wss://blackoutstalkerrp.ru/agent-ws`; ключи бота — `bot/keys/site_private.pem`, `bot/keys/agent_public.pem`.
2. Сайт LX: приём агентов покупателей по лицензии (`site-kit/hub.js` с `authorize`) и редактор конфигов LX-модов
   в личном кабинете.
3. HunterEye: публичного API нет — подключить как provider в `banCheck`, когда дадут доступ.
4. Роль бота в Discord должна стоять выше выдаваемых ролей (Сталкер, Участник) и ролей персонала.
5. Сделать репозиторий приватным.
