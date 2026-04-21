#  YUKLANGANBOT

Мощный Telegram бот для скачивания видео и аудио с YouTube, Instagram, Facebook .

## ✨ Возможности

- 📥 **Скачивание видео/аудио** 
- ⚡ **Мгновенный кеш** — повторные запросы отправляются моментально
- 📺 **Потоковое воспроизведение** — смотри без скачивания
- 💎 **Файлы до 2GB** — поддержка больших файлов через MTProto
- 📢 **Обязательные подписки** — требуй подписку на каналы
- 📣 **Система рекламы** — монетизация через показ объявлений
- 👨‍💼 **Админ-панель** — управление через Telegram
- 📊 **Статистика** — отслеживание пользователей и загрузок

---

## 🛠️ Технологии

- **[NestJS](https://nestjs.com/)** — серверный фреймворк
- **[Grammy](https://grammy.dev/)** — библиотека для Telegram Bot API
- **[Prisma](https://www.prisma.io/)** — ORM для PostgreSQL
- **[Telegram Bot API Server](https://github.com/tdlib/telegram-bot-api)** — локальный сервер для загрузки файлов до 2 ГБ
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — движок скачивания медиа
- **[ffmpeg](https://ffmpeg.org/)** — обработка видео и аудио

---

## 📦 Установка и Запуск

## **Требования**

- [Node.js 19+](https://nodejs.org/en)
- [PostgreSQL 15+](https://www.postgresql.org/)
- [yt-dlp](https://www.ffmpeg.org/)
- [ffmpeg](https://github.com/yt-dlp/yt-dlp)
- [Telegram-local-server](https://github.com/tdlib/telegram-bot-api)
## **1. Клонируй репозиторий**
```bash
git clone https://github.com/Saidolimxoja/Downloader-Telegram_bot-Local-Server.git
cd Downloader-Telegram_bot-Local-Server.git
```

## **2. Установи зависимости**
```bash
npm install
```

## **3. Настройка Telegram Local Server**
### Способ 1: Docker (Рекомендуемый) 

Убедитесь, что у вас установлены Docker.
Создайте папку для временных файлов: 
```bash
mkdir -p /tmp/bot_downloads
```
Запуск Контейнера
```bash
docker run -d \
  -p 8081:8081 \
  -e TELEGRAM_API_ID=ВАШ_API_ID \
  -e TELEGRAM_API_HASH=ВАШ_API_HASH \
  -v "$(pwd)/telegram-bot-api-data:/var/lib/telegram-bot-api" \
  -v /tmp/bot_downloads:/tmp/bot_downloads \
  --name=telegram-bot-api \
  --restart=always \
  aiogram/telegram-bot-api:latest \
  --local \
  --verbosity=2
```
После этого запуститься Локальный СЕРВЕР Телеграм
Важно: Флаг -v /tmp/bot_downloads:/tmp/bot_downloads обязателен. Бот и Сервер должны иметь доступ к одной и той же папке для обмена файлами.
### Способ 2: Без Docker (Нативный запуск)
Требуется скомпилированный файл telegram-bot-api (инструкция по сборке здесь).
Создайте рабочую директорию:
```bash
mkdir -p telegram-bot-api-data
```
Запустите сервер:
```bash
telegram-bot-api \
    --api-id=ВАШ_API_ID \
    --api-hash=ВАШ_API_HASH \
    --http-port=8081 \
    --dir=$(pwd)/telegram-bot-api-data \
    --local \
    --verbosity=2
```
### Способ 3: Docker-Compose 
```bash
docker-compose up --build -d
```
Самый простой вариант запуска бота 
## **4. Настрой .env**
Скопируй `.env.example` в `.env` и заполни:
```bash
cp .env.example .env
```
```env
# Bot
BOT_TOKEN=your_bot_token_from_botfather
YOUR_USERNAME=@your_bot_username

# local-server
API_ID=12345678
API_HASH=your_api_hash_from_my_telegram_org


# Channels
CHANNEL_ID=-1001234567890  для примера можешь получить через бот @userinfobot

# Admin
ADMIN_USER_ID=your_telegram_id 

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/your_DB_name

# App
NODE_ENV=development
PORT=3000

# Paths
YTDLP_PATH=yt-dlp
DOWNLOADS_DIR=./downloads

# Queue
MAX_PARALLEL_DOWNLOADS=3
MAX_QUEUE_SIZE=50
```

### **5. Настрой базу данных**
```bash
# Создай БД
createdb your_db

# Примени миграции
npx prisma migrate dev

# (Опционально) Заполни тестовыми данными
npx prisma db seed
```


### **6. Запусти бота**
```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```
---

## 🎯 Использование

### **Для пользователей**

1. `/start` — Запуск бота
2. Отправь ссылку на видео
3. Выбери качество
4. Получи файл

### **Для администраторов**

1. `/admin` — Админ-панель
2. Управляй рекламой, каналами и статистикой

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
npx prisma db seed         # Заполнить тестовыми данными

# Линтинг
npm run lint               # Проверка кода
npm run lint:fix           # Исправление ошибок
```

---

## 📁 Структура проекта
```
local-server/
├── prisma/
│   ├── schema.prisma          # БД схема
│   ├── migrations/            # Миграции
│   └── seed.ts                # Тестовые данные
│
├── src/
│   ├── main.ts                # Entry point
│   ├── app.module.ts          # Root модуль
│   │
│   ├── config/                # Конфигурация
│   ├── common/
│       ├── constansts/        # Константы
│       ├── utils/             # Утилиты               
│   ├── database/              # Prisma
│   │
│   └── modules/
│       ├── bot/               # Grammy бот
│       ├── user/              # Пользователи
│       ├── subscription/      # Подписки
│       ├── channel/           # Каналы
│       ├── downloader/        # Скачивание
│       ├── cache/             # Кеширование
│       ├── uploader/          # Загрузка в TG
│       ├── ytdlp/           # MTProto клиент
│       ├── advertisement/     # Реклама
│       └── admin/             # Админка
│ 
├── .env                       # Переменные окружения
├── package.json
└── README.md
```

---


### **Ошибка "chat not found"**

Убедись что бот добавлен в канал как администратор:
```bash
# Проверь через команду
/checkchannels
```


### **yt-dlp не работает**

Обнови до последней версии:
```bash
pip3 install --upgrade yt-dlp
```

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
- Issues: [GitHub Issues](https://github.com/Saidolimxoja/Downloader-Telegram_bot-Local-Server.git)

---

## 🙏 Благодарности

- [NestJS](https://nestjs.com/)
- [Grammy](https://grammy.dev/)
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [Prisma](https://www.prisma.io/)

---

**Сделано с ❤️ by [@SAIDOLIMXOJA](https://t.me/SAIDOLIMXOJA)**
