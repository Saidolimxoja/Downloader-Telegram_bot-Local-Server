# 📋 Пошаговый запуск на компьютере (Windows + Cloudflare Tunnel)

Инструкция для случая, когда бот живёт на обычном компьютере за NAT: белого
IP нет, доступа к роутеру нет. Команды — для PowerShell, выполнять по порядку.

Про VPS с белым IP — см. [DEPLOY.md](DEPLOY.md).

---

## Этап 0. Программы — ставится один раз

Скачать и установить:

1. **Docker Desktop** — <https://www.docker.com/products/docker-desktop/>
   При установке оставить галочку **Use WSL 2 instead of Hyper-V**.
   После установки — перезагрузка.
2. **Git** — <https://git-scm.com/download/win>

Проверить, что всё встало (обе команды должны напечатать версии):

```powershell
docker --version
docker compose version
git --version
```

Docker Desktop должен быть **запущен** — в трее кит должен быть белым, не
оранжевым. Без запущенного Docker ни одна команда ниже не сработает.

---

## Этап 1. Забрать код

```powershell
mkdir C:\Project -Force
cd C:\Project
git clone https://github.com/Saidolimxoja/Downloader-Telegram_bot-Local-Server.git
cd C:\Project\Downloader-Telegram_bot-Local-Server
git checkout refactor/scale-to-10k
```

> Если папка уже есть — вместо clone: `cd C:\Project\Downloader-Telegram_bot-Local-Server; git fetch origin; git checkout refactor/scale-to-10k; git pull`

---

## Этап 2. Файл `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

**Сотрите всё содержимое** и вставьте это, заменив значения в угловых скобках:

```env
# === БОТ ===
BOT_TOKEN=<токен от BotFather>
YOUR_USERNAME=<@имя_вашего_бота>
CHANNEL_ID=<id канала-архива, вида -1001234567890>

# === ЛОКАЛЬНЫЙ TELEGRAM BOT API (снимает лимит 50 МБ) ===
API_ID=<api_id с my.telegram.org>
API_HASH=<api_hash с my.telegram.org>
API_URL=http://telegram-api:8081

# === БАЗА И REDIS (имена контейнеров, менять не нужно) ===
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/bot_db?connection_limit=10&pool_timeout=20
DIRECT_URL=postgresql://postgres:postgres@postgres:5432/bot_db
REDIS_HOST=redis
REDIS_PORT=6379

# === ДОМЕН И ТУННЕЛЬ ===
PUBLIC_URL=https://saidolimxoja.uz
TUNNEL_TOKEN=<длинный токен из панели Cloudflare>

# === ПРИЛОЖЕНИЕ ===
NODE_ENV=production
LOG_LEVEL=log
```

Сохранить (Ctrl+S) и закрыть.

Важно: **значения без кавычек** и **без пробелов вокруг `=`**. `.env` в git не
попадает — он в `.gitignore`.

---

## Этап 3. Файл куки — обязательный шаг

`youtube_cookies.txt` не хранится в git (в нём сессия аккаунта). Если файла
нет, Docker при запуске создаст на его месте **папку**, и бот не стартует.
Создаём пустой файл в правильном формате:

```powershell
if (-not (Test-Path .\youtube_cookies.txt)) {
  "# Netscape HTTP Cookie File" | Out-File -Encoding ascii .\youtube_cookies.txt
}
Get-Content .\youtube_cookies.txt
```

Должна напечататься одна строка `# Netscape HTTP Cookie File`.

> Пустого файла достаточно для запуска. Настоящие куки понадобятся позже,
> когда YouTube начнёт требовать подтверждения возраста или проверку «я не
> бот» — тогда экспортируйте их расширением *Get cookies.txt LOCALLY* и
> замените содержимое файла.

---

## Этап 4. Первый запуск

```powershell
cd C:\Project\Downloader-Telegram_bot-Local-Server
docker compose --profile local-api --profile tunnel up -d --build
```

Первая сборка идёт **5–15 минут** — скачиваются образы, ставятся ffmpeg и
yt-dlp. Дальнейшие запуски занимают секунды.

Поднимется 8 контейнеров: `postgres`, `redis`, `telegram-api`, `bot`,
два `worker`, `edge`, `cloudflared`.

Проверить состав:

```powershell
docker compose ps
```

Все должны быть в статусе `Up`. Если какой-то `Restarting` или `Exited` —
смотрите его логи: `docker compose logs <имя>`.

---

## Этап 5. Проверить, что бот запустился

```powershell
docker compose logs bot | Select-String -Pattern "migrat|BOT STARTED|ERROR"
```

Ожидаемо увидеть применение миграций и строку `BOT STARTED: @ваш_бот`.

```powershell
curl.exe -s http://localhost:3000/health
```

Должен вернуться JSON со `status: ok`. Если пусто — база или Redis ещё
поднимаются, подождите полминуты и повторите.

Живые логи (выход — Ctrl+C, контейнеры при этом продолжают работать):

```powershell
docker compose logs -f bot worker
```

**Проверка в самом Telegram:** напишите боту `/start`, пришлите ссылку на
YouTube, выберите качество. Видео должно прийти.

---

## Этап 6. Достроить туннель в Cloudflare

Вернитесь на вкладку с созданием туннеля — статус должен смениться на зелёный
`Connected`, кнопка **Continue** станет активной.

Проверить со стороны компьютера:

```powershell
docker compose logs cloudflared | Select-String -Pattern "Registered tunnel connection"
```

Дальше в панели: вкладка **Public Hostnames** → **Add a public hostname**

| Поле | Значение |
|---|---|
| Subdomain | *(пусто)* |
| Domain | `saidolimxoja.uz` |
| Path | *(пусто)* |
| Type | `HTTP` |
| URL | `edge:80` |

Save. DNS-запись Cloudflare создаст сам.

Через минуту проверить:

```powershell
curl.exe -I https://saidolimxoja.uz/r/1/1/badsig
curl.exe -I https://saidolimxoja.uz/metrics
```

**Оба должны ответить 404** — это правильно. Первый: подпись неверна, значит
ссылка поддельная. Второй: метрики наружу закрыты.

---

## Этап 7. Ежечасная уборка диска — обязательно

Локальный Bot API хранит копию каждого отправленного файла и **никогда** её
не удаляет. Без уборки диск забьётся за несколько дней и встанет всё.

Проверить, что команда работает (должна отработать молча, без ошибок):

```powershell
docker exec telegram-bot-api find /var/lib/telegram-bot-api -type f -mmin +120 -delete
```

Поставить в расписание — **PowerShell от имени администратора**:

```powershell
schtasks /create /tn "TelegramApiCleanup" /sc hourly /f /tr "cmd /c docker exec telegram-bot-api find /var/lib/telegram-bot-api -type f -mmin +120 -delete"
```

Проверить, что задание создано:

```powershell
schtasks /query /tn "TelegramApiCleanup"
```

Посмотреть, сколько занято прямо сейчас:

```powershell
docker system df -v | Select-String telegram-data
```

---

## Этап 8. Настроить компьютер как сервер

**Запретить сон** (PowerShell от администратора):

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
powercfg /hibernate off
```

Экран гасить можно — на работу это не влияет:

```powershell
powercfg /change monitor-timeout-ac 10
```

**Запретить отключение сетевой карты.** Диспетчер устройств → Сетевые
адаптеры → ваша карта → Свойства → Управление электропитанием → снять
«Разрешить отключение этого устройства для экономии энергии».

**Автозапуск Docker Desktop.** Settings → General → включить *Start Docker
Desktop when you sign in*.

**Автоматический вход в Windows.** Иначе после отключения света компьютер
загрузится и застрянет на экране блокировки, а контейнеры не поднимутся:

```powershell
netplwiz
```

Снять галочку «Требовать ввод имени пользователя и пароля» → OK → ввести
пароль дважды.

**В BIOS** найдите пункт *Restore on AC Power Loss* (или *After Power
Failure*) и поставьте **Power On** — тогда после скачка электричества
компьютер включится сам.

---

## Этап 9. Каждое обновление кода

```powershell
cd C:\Project\Downloader-Telegram_bot-Local-Server

# 1. Резервная копия базы
docker compose exec -T postgres pg_dump -U postgres -f /tmp/backup.sql bot_db
docker compose cp postgres:/tmp/backup.sql .\backup.sql

# 2. Забрать изменения
git pull

# 3. Пересобрать и перезапустить
docker compose --profile local-api --profile tunnel up -d --build

# 4. Проверить
docker compose ps
docker compose logs bot | Select-String -Pattern "migrat|BOT STARTED|ERROR"
curl.exe -s http://localhost:3000/health
```

> Дамп делается **внутрь контейнера** и потом копируется наружу намеренно:
> при обычном `> backup.sql` PowerShell пишет файл в UTF-16, и восстановить
> такой дамп потом не получится.

Данные при обновлении не теряются: база лежит в docker-томе, а
`prisma migrate deploy` только добавляет новое и никогда ничего не удаляет.

---

## Этап 10. Повседневные команды

```powershell
# Логи
docker compose logs -f bot
docker compose logs -f worker
docker compose logs --tail=200 bot

# Перезапуск после правки .env (без пересборки)
docker compose --profile local-api --profile tunnel up -d

# Остановить всё
docker compose --profile local-api --profile tunnel down

# Запустить обратно
docker compose --profile local-api --profile tunnel up -d

# Больше воркеров, если очередь копится
docker compose up -d --scale worker=4

# Нагрузка на контейнеры
docker stats

# Состояние очередей
curl.exe -s http://localhost:3000/metrics

# Освободить место после нескольких пересборок
docker image prune -f
```

---

## ☠️ Чего делать нельзя

```powershell
docker compose down -v          # флаг -v удаляет базу вместе с пользователями
```

Единственная по-настоящему опасная команда. Все остальные обратимы.

---

## Если что-то не работает

| Симптом | Что смотреть |
|---|---|
| `docker: command not found` | Docker Desktop не запущен |
| Контейнер `Restarting` | `docker compose logs <имя>` — там причина |
| Бот молчит | `docker compose logs bot`; проверить `BOT_TOKEN` в `.env` |
| Видео не приходят | `docker compose logs worker`; проверить, что `telegram-api` в статусе Up |
| «Analyzing» и тишина | `curl.exe -s http://localhost:3000/metrics` — растёт ли очередь |
| Домен не открывается | `docker compose logs cloudflared` |
| Клики не считаются | проверить `PUBLIC_URL` в `.env` и Public Hostname в панели |
| Всё встало разом | `df` места нет → Этап 7 |
