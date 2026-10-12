> 📒 **Для новых сессий Claude Code и для людей:** полный журнал того, что сделано, как развёрнуто и что
> осталось — [`docs/SESSION_LOG.md`](docs/SESSION_LOG.md). Кратко — [`CLAUDE.md`](CLAUDE.md).

# Blackout: управление сервером, LX Agent и Discord-бот

- **`agent/`** — LX Agent (`lx-agent.exe`) для Windows VDS с DayZ-сервером, описан ниже.
- **`bot/`** — Discord-бот Blackout со службой управления: статус, админ-команды, игровые логи,
  Steam и вайтлист, анкеты, тикеты, модерация, антирейд. Подробнее — [bot/README.md](bot/README.md).
- **`site-kit/`** — модуль, через который сайт или бот принимает подключение агентов.

# LX Agent — управление DayZ-сервером с сайта

Одна программа `lx-agent.exe` для двух случаев:

- **Свой сервер (Blackout).** Полное управление из админки blackoutstalkerrp.ru: старт, стоп и рестарт
  (в том числе по расписанию), редактор конфигов с бэкапами, RCon (игроки, кик, бан, сообщения),
  логи в реальном времени, моды и их обновление через SteamCMD.
- **Сервер покупателя модов LX.** Агент подключается к lxmodschngz.ru по ключу лицензии. Сайт LX может
  только настраивать конфиги модов LX и видеть статус сервера. Остальное агент ему не даёт.

```
blackoutstalkerrp.ru ─┐                            ┌─► DayZServer_x64.exe (старт/стоп/рестарт)
  (allow: всё)        ├─WSS─► lx-agent.exe (VDS) ──┼─► конфиги (только разрешённые папки, с бэкапами)
lxmodschngz.ru ───────┘  агент подключается сам    ├─► BattlEye RCon (127.0.0.1)
  (allow: lx.*)                                    └─► логи, моды
```

Что разрешено каждому сайту, задаёт `allow` в `config.json` **на машине с агентом**. Сайт не может
расширить свои права сам. Поэтому покупатель может ставить агента без опасений: даже если взломают
lxmodschngz.ru, через него нельзя остановить сервер или прочитать чужие файлы.

## Установка

### Покупатель модов LX

1. Скачать `lx-agent.exe` в отдельную папку, например `C:\LXAgent`.
2. В командной строке от администратора:
   ```
   cd C:\LXAgent
   lx-agent.exe init --server-dir C:\DayZServer --license LX-XXXX-XXXX-XXXX
   lx-agent.exe run          (проверка: должно появиться «подключён к сайту lx», затем Ctrl+C)
   lx-agent.exe install      (автозапуск при загрузке Windows и перезапуск при сбое)
   ```

### Свой сервер с полным управлением

1. На сайте: `node tools/keygen.js site`. `keys/site_private.pem` остаётся только на сайте,
   `keys/site_public.pem` переносится на VDS.
2. На VDS:
   ```
   lx-agent.exe init --server-dir C:\DayZServer --site-url wss://blackoutstalkerrp.ru/agent-ws ^
                     --site-key site_public.pem --agent-id blackout-main [--license …]
   lx-agent.exe pubkey       (этот публичный ключ агента добавить на сайт)
   ```
3. Проверь `config.json` (пример со всеми полями — `agent/config.example.json`), затем `run` и `install`.

Рекомендуется запускать агента от отдельного пользователя Windows без прав администратора:
`lx-agent.exe install --user .\dayzagent --password …`. Без `--user` агент работает от SYSTEM.

Если сервер уже запущен через `.bat`, агент найдёт процесс и возьмёт его под управление.
Старый `.bat` и планировщик рестартов после этого отключи, иначе они будут конфликтовать с агентом.

Файлы рядом с `lx-agent.exe`: `config.json`, `keys\` (ключ агента), `agent.log` (журнал работы),
`audit.log` (кто и что делал), `backups\`, `state.json`.

## Защита

| Угроза | Что мешает |
|---|---|
| Перехват трафика | Только `wss://` (TLS). Можно дополнительно привязать агента к отпечатку сертификата сайта (`tlsPinSha256`) |
| Подключение к агенту извне | Входящих портов у агента нет: он сам подключается к сайту |
| Кража ключа агента | Ключ создаётся на месте и шифруется Windows DPAPI: скопированный на другой компьютер файл бесполезен. На папку `keys` выставляются права только для SYSTEM, администраторов и пользователя агента |
| Поддельный агент | При подключении агент подписывает одноразовый вызов своим ключом Ed25519. Сайт LX дополнительно проверяет лицензию и IP |
| Поддельные команды | Каждую команду сайт подписывает своим ключом. У агента есть только публичный ключ сайта |
| Повтор перехваченной команды | В подписи время и одноразовый nonce; команды старше 30 с и повторы отклоняются |
| Сайт просит лишнее | `allow` для каждого сайта проверяется на агенте. Действия вне `allow` отклоняются с ошибкой `forbidden` |
| Взлом сайта | Агент умеет только действия из списка ниже: нет выполнения команд, нет доступа к файлам вне разрешённых папок, к `.exe`, `.dll`, `.bat` и папке `battleye`. Строка запуска сервера собирается только из конфига агента |
| Утечка паролей | RCon-пароль агент читает локально из `beserver_x64.cfg`, на сайт он не уходит. `passwordAdmin` из `serverDZ.cfg` показывается как `********` |
| Ошибка в конфиге | Проверка XML/JSON перед сохранением, бэкап каждой версии, откат, защита от одновременной правки двумя админами |

Часы на VDS и на сайте должны быть синхронизированы, иначе команды будут отклоняться как устаревшие.

## Подключение к сайту (Node.js)

```js
import { AgentHub } from './site-kit/hub.js';

// Свой сайт: агенты прописаны заранее.
const hub = new AgentHub({
  sitePrivateKey: './keys/site_private.pem',
  agents: { 'blackout-main': './keys/agent_public.pem' },
});

// Сайт LX: агенты покупателей пускаются по лицензии.
const lxHub = new AgentHub({
  sitePrivateKey: './keys/lx_site_private.pem',
  authorize: async (hello, ip) => {
    // hello.license, hello.pub (ключ агента), ip → найти лицензию, сверить IP,
    // при первом подключении запомнить hello.pub, дальше пускать только с ним.
    const lic = await findLicense(hello.license);
    if (!lic || lic.ip !== ip) return null;
    if (!lic.agentPub) await bindAgentKey(lic.id, hello.pub);
    return { id: `license-${lic.id}`, publicKey: lic.agentPub ?? hello.pub };
  },
});

hub.attach(httpServer, '/agent-ws');
const players = await hub.call('blackout-main', 'rcon.players', {}, { steamId, name }); // только после проверки прав админа
hub.on('event', (agentId, topic, data) => { /* 'server' | 'rcon' | 'log' */ });
```

Для `/agent-ws` за nginx нужно проксирование WebSocket
(`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`).

## Команды агента

| Действие | Параметры |
|---|---|
| `agent.info` | — версия, отпечаток ключа, игровой порт |
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
| `lx.mods` | установленные моды LX |
| `lx.roots` / `lx.list` / `lx.read` / `lx.write` / `lx.backups` / `lx.restore` | как `files.*`, но только в папках `lx.roots` |

## Разработка и сборка

```
npm install
npm test
npm run build:exe        → dist/lx-agent.exe
node agent/src/main.js run --config agent/config.json   (без сборки)
```

Публичный ключ сайта LX (`release/lx_site_public.pem`) вшивается в `.exe` при сборке.
GitHub Actions на каждый пуш прогоняет тесты на Linux и Windows, собирает `.exe` и проверяет его
на Windows (DPAPI, автозапуск). Готовый файл лежит в артефактах сборки.

`.exe` не подписан, поэтому Windows SmartScreen и антивирусы могут предупреждать. Для распространения
покупателям нужен сертификат подписи кода.
