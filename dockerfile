# Используем Node 20 Alpine для меньшего размера и лучшей производительности на Linux
FROM node:22-alpine

# 1. Устанавливаем системные зависимости
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    openssl \
    ca-certificates

# 2. Создаем виртуальное окружение
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Устанавливаем yt-dlp
RUN pip3 install --no-cache-dir --upgrade yt-dlp

# 3. Настройка рабочей директории
WORKDIR /app

# 4. Копируем файлы зависимостей
COPY package*.json ./
COPY prisma ./prisma/

# 5. Устанавливаем Node-зависимости с кешем
RUN npm ci --legacy-peer-deps --prefer-offline --no-audit

# 6. Генерируем клиент базы данных
RUN npx prisma generate

# 7. Копируем остальной код (исключаем node_modules)
COPY --chown=node:node . .

# 8. Собираем проект
RUN npm run build

# 9. Команда запуска
CMD sh -c 'if [ "$NODE_ENV" = "production" ]; then DATABASE_URL="$DIRECT_URL" npx prisma migrate deploy; fi && NODE_ENV=${NODE_ENV:-development} npm run start:prod'