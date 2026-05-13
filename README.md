#  YUKLANGANBOT

Мощный Telegram бот для скачивания видео и аудио с YouTube, Instagram, Facebook.

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
REDIS_HOST=tg_bot_redis
REDIS_PORT=6379

# === APP ===
NODE_ENV=production
PORT=3000

# === PATHS ===
YTDLP_PATH=yt-dlp
DOWNLOADS_DIR=/tmp/bot_downloads

# === QUEUE ===
MAX_PARALLEL_DOWNLOADS=3
```

### Шаг 4: Создай папку для загрузок
```bash
sudo mkdir -p /tmp/bot_downloads
sudo chmod 777 /tmp/bot_downloads
```

### Шаг 5: Запусти проект
```bash
# Собери и запусти контейнеры
docker-compose up --build -d

# Проверь логи
docker-compose logs -f nest-bot
```

**Готово!** Бот запущен и работает 🎉

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
docker-compose up -d       # Запустить контейнеры
docker-compose down        # Остановить контейнеры
docker-compose logs -f     # Посмотреть логи
docker-compose restart     # Перезапустить

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
│   ├── config/                # Конфигурация
│   ├── common/
│   │   ├── constants/         # Константы
│   │   └── utils/             # Утилиты
│   ├── database/              # Prisma
│   └── modules/
│       ├── bot/               # Grammy бот
│       ├── user/              # Пользователи
│       ├── subscription/      # Подписки
│       ├── channel/           # Каналы
│       ├── downloader/        # Скачивание
│       ├── cache/             # Кеширование
│       ├── uploader/          # Загрузка в TG
│       ├── ytdlp/             # yt-dlp сервис
│       ├── advertisement/     # Реклама
│       └── admin/             # Админка
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
docker-compose down
docker-compose up --build -d

# Проверь логи
docker-compose logs -f nest-bot
```

---

## 🐛 Решение проблем

### Ошибка подключения к БД
```bash
# Проверь DATABASE_URL в .env
cat .env | grep DATABASE_URL

# Проверь подключение
docker exec -it king-kong-bot npx prisma db pull
```

### telegram-api не запускается
```bash
# Проверь логи
docker-compose logs telegram-api

# Убедись что API_ID и API_HASH правильные
cat .env | grep API_
```

### Бот не отвечает
```bash
# Проверь логи
docker-compose logs -f nest-bot

# Перезапусти
docker-compose restart nest-bot
```

---

## 📊 Мониторинг

```bash
# Статус контейнеров
docker-compose ps

# Логи в реальном времени
docker-compose logs -f

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
