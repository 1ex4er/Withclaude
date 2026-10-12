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

## Как развёрнуто (на 11.10.2026)
- Бот работает на сервере **LX** (Ubuntu 22.04, IHC, 130.49.173.185, SSH root): `/opt/blackout`,
  systemd-служба `blackout-bot`, пользователь `blackout`. Обновление:
  `cd /opt/blackout && git pull && chown -R blackout:blackout /opt/blackout && systemctl restart blackout-bot`
- Discord в РФ заблокирован → `DISCORD_PROXY=socks5h://127.0.0.1:1080` (tpws/zapret, служба `lx-discord-proxy`).
  Через тот же прокси ходят запросы к Steam API. `STEAM_API_KEY` задан.
- Постоянное соединение с Discord через tpws «замерзает» до минуты → нажатия протухают (10062).
  Решение: приём нажатий по HTTP (`DISCORD_PUBLIC_KEY` в .env, Interactions Endpoint URL
  `https://lxmodschngz.ru/discord/interactions`, nginx-location на сайте LX → :3100). Если Discord не
  достучится до РФ-сервера — переносить бота на зарубежный VPS.
- Есть автобэкап bot.db (bot/backups, 14 шт.), RP-наказания (/punish, роли NLR/NonRP/PG/RDM/Meta/Бан),
  карточка /profile.
- На том же сервере: сайт LX (node :3000), бот `lx-helper` (/opt/lx-helper), PostgreSQL, nginx.
- Сайт Blackout — отдельный хостинг IHC (130.49.173.178), SSH с телефона не пускает, с домашнего ПК работает.
- Discord guildId: 1472216850745000099. Админ-роли бота: Гл. Администратор, Администратор,
  Тех. Администратор, Black. `commands.hideFromPlayers = false`.
- DayZ-сервер: 109.248.4.96:2302 (Windows), управляется через панель хостинга («ark-hoster»?) со своим батником.

## Что осталось
1. Игровой сервер: выяснить, есть ли RDP (тогда агент в «режиме панели» — без старт/стоп) или только веб-панель
   (тогда без агента: RCon напрямую + FTP/SFTP для логов и whitelist.txt). Не перезапускать сервер агентом,
   пока моды/параметры батника не перенесены в его config.json.
2. Поддомен `bot.blackoutstalkerrp.ru` → 130.49.173.185, nginx (`/agent-ws`, `/link/steam/`) + certbot,
   затем `publicUrl` бота на поддомен — для «Войти через Steam» и агента.
3. Код сайтов Blackout и LX — пользователь выложит в GitHub; встроить админку (конфиги, сервер).
4. HunterEye: публичного API нет — подключить как provider в `banCheck`, когда дадут доступ.
5. Роль бота в Discord должна стоять выше выдаваемых ролей (Сталкер, Участник) и ролей персонала.
