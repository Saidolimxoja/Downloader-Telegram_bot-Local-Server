# Используем Node 20 на базе Debian (Bookworm), так как там свежие пакеты
FROM node:20-bookworm-slim

# 1. Устанавливаем системные зависимости
# python3-pip и ffmpeg обязательны для yt-dlp и обработки видео
# openssl нужен для Prisma
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    ffmpeg \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Создаем виртуальное окружение
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Теперь pip будет работать внутри venv
RUN pip3 install --upgrade yt-dlp

# 3. Настройка рабочей директории
WORKDIR /app

# 4. Копируем файлы зависимостей
COPY package*.json ./
COPY prisma ./prisma/

# 5. Устанавливаем Node-зависимости
# В Dockerfile измени строку 32 на эту:
RUN npm ci --legacy-peer-deps

# 6. Генерируем клиент базы данных
RUN npx prisma generate

# 7. Копируем остальной код
COPY . .

# 8. Собираем проект
RUN npm run build

# 9. Команда запуска
CMD npx prisma migrate deploy && npm run start:prod