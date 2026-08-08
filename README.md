#  YUKLANGANBOT

Мощный Telegram бот для скачивания видео и аудио с YouTube и Instagram.

## ✨ Возможности

- 📥 **Скачивание видео/аудио** 
- ⚡ **Мгновенный кеш** — повторные запросы отправляются моментально
- 📺 **Потоковое воспроизведение** — смотри без скачивания
- 💎 **Файлы до 2GB** — поддержка больших файлов через Local Telegram API
- 📢 **Обязательные подписки** — требуй подписку на каналы
- 📣 **Система рекламы** — монетизация через показ объявлений
- 👨‍💼 **Админ-панель** — управление через Telegram
- 📊 **Статистика** — отслеживание пользователей и загрузок
- ☁️ **Supabase БД** — данные не пропадают при перезапуске

---

## 🛠️ Технологии

- **[NestJS](https://nestjs.com/)** — серверный фреймворк
- **[Grammy](https://grammy.dev/)** — библиотека для Telegram Bot API
- **[Prisma](https://www.prisma.io/)** — ORM для PostgreSQL
- **[Supabase](https://supabase.com/)** — облачная PostgreSQL база данных
- **[BullMQ](https://docs.bullmq.io/)** — очереди для фоновых задач
- **[Telegram Bot API Server](https://github.com/tdlib/telegram-bot-api)** — локальный сервер для файлов до 2GB
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — движок скачивания медиа
- **[ffmpeg](https://ffmpeg.org/)** — обработка видео и аудио
- **[Redis](https://redis.io/)** — очереди, лимиты, сессии и общее состояние

---

## 🏗️ Архитектура

Приложение запускается в двух ролях (переменная `ROLE`) из одного образа:

```
                       ┌──────────────────────────┐
   сообщение  ────────▶│  ROLE=bot  (ровно один)  │
                       │  приём, лимиты, очереди   │
                       └───────────┬──────────────┘
                                   │ BullMQ (Redis)
                     ┌─────────────┴─────────────┐
                     ▼                           ▼
          ┌─────────────────────┐     ┌─────────────────────┐
          │  analyze-queue      │     │  download-queue     │
          │  разбор ссылки      │     │  yt-dlp + ffmpeg    │
          └─────────────────────┘     └─────────────────────┘
                     ▲                           ▲
                     └───────────┬───────────────┘
                                 │
                    ┌────────────┴─────────────┐
                    │ ROLE=worker (N реплик)   │
                    └──────────────────────────┘
```

**Почему так.** Процесс `bot` держит long-polling Telegram и обязан быть один:
два экземпляра с одним токеном получают `409 Conflict`. Процессы `worker`
делают всю тяжёлую работу — их можно добавлять сколько нужно.

Две очереди разделены намеренно: разбор ссылки быстрый, но прожорливый по
памяти (каждый вызов yt-dlp — процесс на 60–120 МБ), а загрузка долгая и
упирается в CPU из-за ffmpeg. В общей очереди пачка тяжёлых загрузок
блокировала бы разбор новых ссылок.

**Что лежит в Redis:** очереди задач, сессии видео под кнопками выбора
качества, кеш проверки подписки, счётчики рекламы, лимиты на пользователя и
блокировки от повторного скачивания одного и того же файла. Всё это общее для
бота и всех воркеров.

### Масштабирование

```bash
# Больше воркеров — больше одновременных загрузок
docker compose up -d --scale worker=4
```

Ориентир: один воркер держит `MAX_PARALLEL_DOWNLOADS` загрузок и
`MAX_PARALLEL_ANALYSIS` разборов. Считайте по ядрам — ffmpeg при
перекодировке занимает ядро целиком.

---

## 🚀 Быстрый старт (Production)

### Требования
- Docker и Docker Compose
- Аккаунт на [Supabase](https://supabase.com) (бесплатно)
- Telegram Bot Token от [@BotFather](https://t.me/BotFather)
- API credentials от [my.telegram.org](https://my.telegram.org)

### Шаг 1: Создай проект в Supabase
1. Зайди на [supabase.com](https://supabase.com)
2. Создай новый проект (займет 1-2 минуты)
3. Скопируй **Connection string (URI)** из:
   - Project Settings → Database → Connection string → URI
   - Пример: `postgresql://postgres:password@db.xxxxx.supabase.co:5432/postgres`

### Шаг 2: Получи Telegram API credentials
1. Зайди на [my.telegram.org](https://my.telegram.org)
2. Перейди в "API development tools"
3. Создай приложение и скопируй `api_id` и `api_hash`

### Шаг 3: Клонируй и настрой проект
```bash
# Клонируй репозиторий
git clone https://github.com/Saidolimxoja/Downloader-Telegram_bot-Local-Server.git
cd Downloader-Telegram_bot-Local-Server

# Создай .env файл
cp .env.production .env
nano .env
```

**Заполни .env:**
```env
# === BOT ===
BOT_TOKEN=твой_токен_от_BotFather
YOUR_USERNAME=@твой_бот
API_URL=http://telegram-api:8081

# === TELEGRAM API ===
API_ID=твой_api_id
API_HASH=твой_api_hash

# === CHANNELS ===
CHANNEL_ID=-1001234567890

# === DATABASE (Supabase) ===
DATABASE_URL=postgresql://postgres:password@db.xxxxx.supabase.co:5432/postgres

# === REDIS ===
REDIS_HOST=redis
REDIS_PORT=6379

# === APP ===
NODE_ENV=production
PORT=3000
LOG_LEVEL=log

# === PATHS ===
YTDLP_PATH=yt-dlp
DOWNLOADS_DIR=/app/downloads

# === ОЧЕРЕДИ (на один воркер) ===
MAX_PARALLEL_DOWNLOADS=3
MAX_PARALLEL_ANALYSIS=5
MAX_QUEUE_SIZE=500

# === ЛИМИТЫ НА ПОЛЬЗОВАТЕЛЯ ===
RATE_LIMIT_PER_MINUTE=5
RATE_LIMIT_PER_HOUR=60
MAX_ACTIVE_ANALYSIS_PER_USER=2
```

Полный список переменных с пояснениями — в [.env.example](.env.example).

> `ROLE` в `.env` указывать не нужно: docker-compose сам задаёт `bot` и
> `worker` соответствующим контейнерам.

### Шаг 4: Запусти проект
```bash
# Собери и запусти (БЕЗ профиля local-api!)
docker compose up --build -d

# Логи бота и воркеров
docker compose logs -f bot
docker compose logs -f worker

# Проверь, что живой
curl http://localhost:3000/health
```

Папку для загрузок создавать вручную не нужно — это docker-том `downloads`,
общий для бота и воркеров.

**Готово!** Бот запущен и работает 🎉

### ⚠️ Telegram Bot API на VPS

На сервере `telegram-bot-api` собран вручную и работает на хосте (systemd), а не в
Docker. Поэтому на VPS **не указывай** профиль `local-api` — иначе поднимется второй,
лишний экземпляр и займёт порт 8081.

**1. В `.env` на сервере добавь строку:**
```bash
API_URL=http://host.docker.internal:8081
```
Без неё подставится dev-дефолт `http://telegram-api:8081` и бот упадёт с
`Network request for 'getMe' failed!`.

**2. Убедись, что API слушает `0.0.0.0`, а не только `127.0.0.1`** — иначе из
контейнера он недоступен. Проверка:
```bash
ss -lntp | grep 8081
```
Если видишь `127.0.0.1:8081` — добавь в параметры запуска telegram-bot-api
`--http-ip-address=0.0.0.0` и перезапусти сервис.

**3. Проверь связь из контейнера:**
```bash
docker exec nest_bot wget -qO- http://host.docker.internal:8081 ; echo
```
Ответ (любой, даже с ошибкой метода) означает, что связь есть.

> Если API слушает `0.0.0.0`, закрой порт 8081 извне файрволом —
> наружу он торчать не должен.

---

## 📋 Локальная разработка

### Требования
- Node.js 20+
- PostgreSQL 15+ (или Supabase)
- yt-dlp
- ffmpeg
- Redis

### Установка
```bash
# 1. Клонируй репозиторий
git clone https://github.com/Saidolimxoja/Downloader-Telegram_bot-Local-Server.git
cd Downloader-Telegram_bot-Local-Server

# 2. Установи зависимости
npm install

# 3. Настрой .env
cp .env.example .env
# Отредактируй .env и заполни все переменные

# 4. Примени миграции
npx prisma migrate deploy
npx prisma generate

# 5. Запусти в режиме разработки
npm run start:dev
```

### Всё в Docker (Windows / без своего telegram-bot-api)

Если локально нет собранного telegram-bot-api, подними его в контейнере профилем
`local-api` — тогда `API_URL` не нужен в `.env`, подставится `http://telegram-api:8081`:
```bash
docker compose --profile local-api up --build -d
docker compose --profile local-api ps
```
Останавливать нужно с тем же флагом, иначе `telegram-bot-api` останется висеть:
```bash
docker compose --profile local-api down
```

---

## 🎯 Использование

### Для пользователей
1. `/start` — Запуск бота
2. Отправь ссылку на видео (YouTube, Instagram)
3. Выбери качество
4. Получи файл

### Для администраторов
1. `/admin` — Админ-панель
2. Управляй рекламой, каналами и статистикой
3. `/checkchannels` — Проверка доступа к каналам

---

## 🔧 Команды разработчика

```bash
# Разработка
npm run start:dev          # Запуск с hot-reload
npm run build              # Сборка проекта
npm run start:prod         # Запуск production

# База данных
npx prisma migrate dev     # Создать миграцию
npx prisma migrate deploy  # Применить миграции (prod)
npx prisma studio          # UI для БД
npx prisma generate        # Генерация Prisma Client

# Docker
docker compose up -d       # Запустить контейнеры
docker compose down        # Остановить контейнеры
docker compose logs -f     # Посмотреть логи
docker compose restart     # Перезапустить

# Линтинг
npm run lint               # Проверка кода
```

---

## 📁 Структура проекта

```
├── prisma/
│   ├── schema.prisma          # БД схема
│   └── migrations/            # Миграции
├── src/
│   ├── main.ts                # Entry point
│   ├── app.module.ts          # Root модуль
│   ├── config/
│   │   ├── role.ts            # Роль процесса: bot / worker / all
│   │   └── validation.schema.ts
│   ├── common/
│   │   ├── constants/         # Площадки, тексты, ключи Redis
│   │   ├── redis/             # Общее состояние между процессами
│   │   └── utils/             # Форматирование, работа с файлами
│   ├── database/              # Prisma
│   └── modules/
│       ├── telegram/          # Единственный экземпляр Bot на процесс
│       ├── bot/               # Обработчики Telegram (только ROLE=bot)
│       ├── downloader/
│       │   ├── downloader.service.ts        # Приём ссылок и лимиты
│       │   ├── analysis.service.ts          # Разбор ссылки (воркер)
│       │   ├── download-executor.service.ts # Конвейер загрузки (воркер)
│       │   ├── media-delivery.service.ts    # Общая выдача файлов
│       │   ├── rate-limit.service.ts        # Лимиты на пользователя
│       │   ├── *.processor.ts               # Воркеры очередей
│       │   └── downloads-cleanup.service.ts # Уборка забытых файлов
│       ├── user/              # Пользователи
│       ├── subscription/      # Подписки
│       ├── channel/           # Каналы
│       ├── cache/             # Кеш file_id
│       ├── uploader/          # Заливка в архивный канал
│       ├── ytdlp/             # yt-dlp и ffmpeg
│       ├── advertisement/     # Реклама
│       ├── admin/             # Админка
│       └── health/            # /health и /metrics
├── docker-compose.yml         # Docker конфигурация
├── Dockerfile                 # Docker образ
├── .env.example               # Пример переменных окружения
└── README.md
```

---

## 🔄 Обновление на сервере

```bash
# Перейди в папку проекта
cd ~/Downloader-Telegram_bot-Local-Server

# Получи последние изменения
git pull origin main

# Пересобери контейнеры
docker compose down
docker compose up --build -d

# Проверь логи
docker compose logs -f bot
```

---

## 🐛 Решение проблем

### Ошибка подключения к БД
```bash
# Проверь DATABASE_URL в .env
cat .env | grep DATABASE_URL

# Проверь подключение
docker compose exec bot npx prisma db pull
```

### telegram-api не запускается
```bash
# Проверь логи
docker compose logs telegram-api

# Убедись что API_ID и API_HASH правильные
cat .env | grep API_
```

### Бот не отвечает
```bash
# Проверь логи
docker compose logs -f bot

# Перезапусти
docker compose restart bot
```

---

## 📊 Мониторинг

```bash
# Живо ли приложение и доступны ли БД с Redis
curl http://localhost:3000/health

# Длина очередей, число упавших задач, потребление памяти
curl http://localhost:3000/metrics
```

Растущее `queues.download.waiting` означает, что воркеры не справляются —
добавьте реплик. Ненулевое `failed` — повод посмотреть логи воркера.

```bash
# Статус контейнеров
docker compose ps

# Логи в реальном времени
docker compose logs -f

# Использование ресурсов
docker stats

# Данные в Supabase
# Зайди в Supabase Dashboard → Table Editor
```

---

## 🔐 Безопасность

⚠️ **Важно:**
- Никогда не коммить `.env` файл в Git
- Используй надежные пароли для БД
- Не делись строкой подключения DATABASE_URL
- Настрой firewall на сервере
- Регулярно обновляй зависимости

---

## 📝 Лицензия

MIT

---

## 🤝 Вклад

Pull requests приветствуются!

1. Fork проекта
2. Создай feature ветку (`git checkout -b feature/amazing`)
3. Commit изменения (`git commit -m 'Add amazing feature'`)
4. Push в ветку (`git push origin feature/amazing`)
5. Открой Pull Request

---

## 📞 Поддержка

- Telegram: [@SAIDOLIMXOJA](https://t.me/SAIDOLIMXOJA)
- Issues: [GitHub Issues](https://github.com/Saidolimxoja/Downloader-Telegram_bot-Local-Server/issues)

---

## 🙏 Благодарности

- [NestJS](https://nestjs.com/)
- [Grammy](https://grammy.dev/)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [Prisma](https://www.prisma.io/)
- [Supabase](https://supabase.com/)

---

**Сделано с ❤️ by [@SAIDOLIMXOJA](https://t.me/SAIDOLIMXOJA)**
