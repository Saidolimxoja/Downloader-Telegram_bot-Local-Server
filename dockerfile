# Используем Node 20 на базе Debian (Bookworm), так как там свежие пакеты
FROM node:20-bookworm-slim

# 1. Устанавливаем системные зависимости
# python3-pip и ffmpeg обязательны для yt-dlp и обработки видео
# openssl нужен для Prisma
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2. Устанавливаем yt-dlp через pip (так надежнее, чем apt)
# Создаем виртуальное окружение для python, чтобы не ломать системный
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
RUN pip3 install --upgrade yt-dlp

# 3. Настройка рабочей директории
WORKDIR /app

# 4. Копируем файлы зависимостей
COPY package*.json ./
COPY prisma ./prisma/

# 5. Устанавливаем Node-зависимости
RUN npm install

# 6. Генерируем клиент базы данных
RUN npx prisma generate

# 7. Копируем остальной код
COPY . .

# 8. Собираем проект
RUN npm run build

# 9. Команда запуска
CMD ["npm", "run", "start:prod"]