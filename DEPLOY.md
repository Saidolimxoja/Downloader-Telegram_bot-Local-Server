# 🚀 Разворачивание и обновление

Памятка по серверу: что настроить один раз и что делать при каждом релизе.

---

## Часть 1. Настройка сервера — делается ОДИН раз

### 1.1 telegram-bot-api как служба

Сейчас вы запускаете его руками в терминале. Проблема: процесс умирает, как
только закрывается SSH-сессия, и не поднимается после перезагрузки сервера.
Бот при этом перестаёт отправлять файлы.

Создайте службу:

```bash
sudo nano /etc/systemd/system/telegram-bot-api.service
```

Содержимое:

```ini
[Unit]
Description=Telegram Bot API server
After=network.target

[Service]
Type=simple
User=root
ExecStart=/opt/telegram-bot-api/build/telegram-bot-api \
    --api-id=ВАШ_API_ID \
    --api-hash=ВАШ_API_HASH \
    --local \
    --dir=/var/lib/telegram-bot-api \
    --http-ip-address=0.0.0.0 \
    --http-port=8081
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

> `--http-ip-address=0.0.0.0` обязателен: без него сервер слушает только
> localhost, и контейнер бота до него не достучится.

Включить и запустить:

```bash
sudo systemctl daemon-reload
sudo systemctl enable telegram-bot-api
sudo systemctl start telegram-bot-api
sudo systemctl status telegram-bot-api
```

Закройте порт снаружи — наружу ему торчать не нужно:

```bash
sudo ufw deny 8081/tcp
```

### 1.2 Уборка файлов telegram-bot-api

**Самое важное на этом шаге.** Локальный Bot API сохраняет копию каждого
отправленного файла и никогда её не удаляет. При активной работе это десятки
гигабайт в сутки — диск забьётся за пару дней, и встанет всё.

Проверьте, сколько уже накопилось:

```bash
du -sh /var/lib/telegram-bot-api
```

Поставьте автоматическую уборку:

```bash
sudo crontab -e
```

Добавьте строку:

```
0 * * * * find /var/lib/telegram-bot-api -type f -mmin +120 -delete 2>/dev/null
```

Раз в час удаляются файлы старше двух часов. Отправленные файлы столько не
живут — дальше работает `file_id`, а сам файл не нужен.

> Если вы отзывали токен бота, в `/var/lib/telegram-bot-api` осталась папка со
> старым токеном в названии. Она больше не используется — удалите её вручную.

### 1.3 Порты

```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # выпуск сертификата
sudo ufw allow 443/tcp    # HTTPS
sudo ufw enable
sudo ufw status
```

Порты `3000`, `5432`, `6379`, `8081` наружу открывать **не нужно** — они
доступны только внутри сервера.

### 1.4 Файл `.env`

Проверьте, что в нём есть всё новое:

```env
BOT_TOKEN=новый_токен_от_BotFather
YOUR_USERNAME=@ваш_бот
API_URL=http://host.docker.internal:8081

CHANNEL_ID=-100...

# Домен для подсчёта переходов по рекламе
PUBLIC_URL=https://saidolimxoja.uz
DOMAIN=saidolimxoja.uz

NODE_ENV=production
LOG_LEVEL=log
```

`ROLE` указывать не нужно — его задаёт docker-compose.

---

## Часть 1-Б. Если сервера нет — свой компьютер + Cloudflare Tunnel

Вариант для случая, когда бот работает на домашнем или офисном компьютере:
белого IP нет, доступа к роутеру нет, порты пробросить некуда.

### Почему это работает

Обычная схема требует, чтобы Cloudflare мог **дозвониться** до вашей машины —
для этого и нужны белый IP и открытые порты. Cloudflare Tunnel переворачивает
направление: агент `cloudflared` внутри вашей сети сам устанавливает исходящее
соединение с Cloudflare и держит его. Входящий запрос на `saidolimxoja.uz`
приходит в Cloudflare, а тот отдаёт его вам по уже открытому каналу.

Для исходящего соединения не нужно ни белого IP, ни настроек роутера — это
обычный HTTPS-трафик наружу, такой же, как у браузера.

Сам бот и так работает за NAT: long polling — тоже исходящее соединение.
Туннель нужен **только** для подсчёта переходов по рекламе (`/r/*`).

> nginx здесь не поможет: он такой же веб-сервер, как Caddy, и упирается в ту
> же стену — снаружи до него нет пути.

### Шаг 1. Создать туннель

1. Откройте <https://one.dash.cloudflare.com> → **Networks** → **Tunnels**
2. **Create a tunnel** → тип **Cloudflared** → имя, например `bot-tunnel`
3. На экране установки **не выполняйте предложенную команду** — скопируйте
   только длинный токен из неё (идёт после `--token`)
4. Вставьте его в `.env`:

```env
TUNNEL_TOKEN=eyJhIjoiXXXXXXXX...
PUBLIC_URL=https://saidolimxoja.uz
```

### Шаг 2. Указать публичный адрес

Там же, вкладка **Public Hostnames** → **Add a public hostname**:

| Поле | Значение |
|---|---|
| Subdomain | *(пусто)* |
| Domain | `saidolimxoja.uz` |
| Path | *(пусто)* |
| Type | `HTTP` |
| URL | `edge:80` |

`edge` — контейнер-фильтр из docker-compose: наружу он пропускает только
`/r/*`, а на всё остальное отвечает 404. Поэтому `/health` и `/metrics`
остаются закрытыми, даже если в панели что-то настроено неаккуратно.

DNS-запись Cloudflare создаст сам — руками ничего добавлять не нужно.

> ⚠️ Здесь запись должна быть **проксируемой (оранжевое облако)** — это
> противоположно тому, что требовалось для варианта с Caddy. Туннель и
> работает через прокси Cloudflare, без него он бессмыслен.

### Шаг 3. Запустить

```bash
docker compose --profile tunnel up -d --build
docker compose logs -f cloudflared          # ждём "Registered tunnel connection"
```

Короткой командой: `npm run tunnel:up`

Профили `public` и `tunnel` — взаимоисключающие. Либо свой сертификат на своём
IP, либо туннель. Если раньше поднимали `public`, погасите Caddy:

```bash
docker compose --profile public down
```

### Шаг 4. Проверить

```bash
curl -I https://saidolimxoja.uz/r/1/1/badsig     # 404 — так и должно быть
curl -I https://saidolimxoja.uz/metrics          # 404 — метрики закрыты
```

Дальше — обычная проверка через бота: нажать кнопку объявления и убедиться,
что счётчик переходов в админке вырос.

### Что учесть на обычном компьютере

Отдельный пункт, потому что компьютер — не сервер и ведёт себя иначе.

**Сон и гибернация.** Уснувшая машина = выключенный бот. На Windows:
Параметры → Система → Питание → «Спящий режим» → **Никогда**, и обязательно
снимите «Разрешить отключение этого устройства для экономии энергии» в
свойствах сетевой карты (Диспетчер устройств → Сетевые адаптеры → Управление
электропитанием).

**Автозапуск.** В Docker Desktop включите *Start Docker Desktop when you sign
in*, а в Windows — автоматический вход в систему. Иначе после отключения
электричества компьютер загрузится, но останется на экране блокировки, а
контейнеры не поднимутся. `restart: always` работает только после старта
самого Docker.

**Local Bot API.** Если на компьютере не собран `telegram-bot-api`, поднимите
его контейнером — это проще, чем сборка из исходников:

```bash
docker compose --profile local-api --profile tunnel up -d
```

В `.env` тогда: `API_URL=http://telegram-api:8081`, плюс `API_ID` и `API_HASH`.

**Уборка диска.** Крон из пункта 1.2 — для Linux. При запуске контейнером
файлы лежат в docker-томе, и чистить нужно так:

```bash
docker compose exec telegram-api find /var/lib/telegram-bot-api -type f -mmin +120 -delete
```

На Windows поставьте это в Планировщик заданий с запуском раз в час.
Без уборки диск забьётся за считаные дни.

**Интернет.** При обрыве связи `cloudflared` и long polling переподключаются
сами, ничего делать не нужно. Но пока связи нет — бот недоступен, и рабочий
интернет обычно менее стабилен, чем в дата-центре. Это цена варианта.

---

## Часть 2. Каждый релиз — последовательность команд

### Шаг 1. Забрать код

```bash
cd ~/Downloader-Telegram_bot-Local-Server
git fetch origin
git checkout refactor/scale-to-10k
git pull
```

### Шаг 2. Сделать резервную копию базы

Занимает секунды, а спасает от любой неудачной миграции:

```bash
docker compose exec -T postgres pg_dump -U postgres bot_db > ~/backup_$(date +%F_%H%M).sql
ls -lh ~/backup_*.sql
```

### Шаг 3. Пересобрать и запустить

```bash
docker compose --profile public up -d --build
```

Или короткой командой: `npm run docker:up`

> ⚠️ `--no-cache` при обычном релизе **не нужен** — сборка займёт 10 минут
> вместо одной. Он оправдан, только если что-то ведёт себя необъяснимо и есть
> подозрение на испорченный кеш слоёв.

### Шаг 4. Убедиться, что миграции применились

```bash
docker compose logs bot | grep -i migrat
```

Ожидаемо увидеть `Applying migration ...` или `No pending migrations to apply`.

### Шаг 5. Проверить, что всё живо

```bash
docker compose ps                              # все контейнеры Up
curl http://localhost:3000/health              # status: ok
docker compose logs -f bot                     # BOT STARTED: @имя_бота
```

**Готово.** В обычном случае это Шаги 1 → 3 → 5.

---

## Что происходит с базой при обновлении

Коротко: **ничего не теряется**.

`docker compose down` и `up` не трогают данные — база лежит в docker-томе
`postgres_data`, который переживает пересоздание контейнеров.

При старте процесс `bot` выполняет `prisma migrate deploy`. Эта команда:

- смотрит таблицу `_prisma_migrations` — что уже применено;
- применяет только новое;
- **никогда** не удаляет и не пересоздаёт таблицы.

Новая миграция добавляет три колонки в `users` (`premiumUntil`, `referredBy`,
`referralCount`) и создаёт таблицу `payments`. Все колонки допускают пустое
значение или имеют значение по умолчанию, поэтому существующие строки
остаются как есть. Пользователи, загрузки и кеш не пострадают.

> ☠️ **Единственная опасная команда** — `docker compose down -v`. Флаг `-v`
> удаляет тома вместе с базой данных. Никогда не используйте его на сервере.

### Если миграция не применилась

```bash
docker compose exec bot npx prisma migrate status
```

Если написано, что база «дрейфует» (изменялась в обход миграций), сообщите —
разберёмся точечно. Не запускайте `migrate reset`: он стирает все данные.

---

## Проверка после этого релиза

Он крупный, поэтому пройдитесь по пунктам:

```bash
# 1. Роли поднялись
docker compose ps                    # видим bot, worker, postgres, redis, caddy

# 2. Очереди отвечают
curl http://localhost:3000/metrics

# 3. Домен резолвится и сертификат выпущен
docker compose logs caddy | grep -i certificate
curl -I https://saidolimxoja.uz/r/1/1/badsig     # 404 — это правильный ответ
```

В самом боте:

| Проверка | Ожидание |
|---|---|
| Прислать ссылку на YouTube | появились кнопки качества |
| Нажать качество | видео пришло |
| Прислать Reels | пришло без выбора качества |
| `/premium` | показаны три тарифа |
| Купить 7 дней с другого аккаунта | премиум активирован |
| `/refund <charge_id>` от админа | звёзды вернулись |
| `/ref` | ссылка и счётчик |
| `/admin → Статистика` | видны продажи |

---

## Полезные команды

```bash
# Логи
docker compose logs -f bot
docker compose logs -f worker
docker compose logs --tail=200 bot

# Перезапуск без пересборки (после правки .env)
docker compose --profile public up -d

# Добавить воркеров под нагрузкой
docker compose up -d --scale worker=4

# Место на диске
df -h
du -sh /var/lib/telegram-bot-api

# Ресурсы контейнеров
docker stats

# Почистить старые образы после нескольких релизов
docker image prune -f
```

---

## Откат, если релиз не удался

```bash
cd ~/Downloader-Telegram_bot-Local-Server
git checkout main
docker compose --profile public up -d --build
```

Схема базы при этом останется новой — лишние колонки старому коду не мешают,
он их просто не замечает.

Если нужно вернуть и данные:

```bash
cat ~/backup_ДАТА.sql | docker compose exec -T postgres psql -U postgres bot_db
```
