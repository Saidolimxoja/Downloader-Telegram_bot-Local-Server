# ============================================================
#  СБОРКА
# ============================================================
FROM node:22-alpine AS builder

WORKDIR /app

# Сначала зависимости — этот слой кешируется и не пересобирается
# при каждой правке исходников
COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci --legacy-peer-deps --prefer-offline --no-audit
RUN npx prisma generate

COPY . .
RUN npm run build

# Оставляем только продакшн-зависимости: dev-пакеты (typescript, eslint,
# jest) в рантайме не нужны и весят больше самого приложения
RUN npm prune --omit=dev --legacy-peer-deps


# ============================================================
#  РАНТАЙМ
# ============================================================
FROM node:22-alpine

# yt-dlp и ffmpeg — рабочие инструменты бота, ставим в системный слой
RUN apk add --no-cache \
    python3 \
    py3-pip \
    ffmpeg \
    openssl \
    ca-certificates \
    curl \
    tini

ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
RUN pip3 install --no-cache-dir --upgrade yt-dlp

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

# Папка загрузок должна принадлежать пользователю, под которым идёт процесс
RUN mkdir -p /app/downloads && chown -R node:node /app

# Не работаем от root: процесс запускает внешние программы (yt-dlp, ffmpeg)
# с данными из интернета — лишние права здесь ни к чему
USER node

ENV NODE_ENV=production

# tini как PID 1 — иначе Node не получает SIGTERM корректно, и корректное
# завершение (дописать текущую задачу, закрыть соединения) не срабатывает
ENTRYPOINT ["/sbin/tini", "--"]

# Миграции применяет только процесс роли bot: он существует в единственном
# экземпляре. Пять воркеров, одновременно накатывающих миграции, — это гонка.
#
# Раньше здесь была ещё проверка NODE_ENV=production, и на сервере с
# NODE_ENV=development миграции молча не применялись: приложение стартовало,
# а колонок в базе не было. `migrate deploy` идемпотентен — он применяет
# только неприменённое, — поэтому гонять его всегда безопаснее, чем гадать,
# та ли переменная выставлена.
CMD sh -c '\
  if [ "$ROLE" != "worker" ]; then \
    DATABASE_URL="${DIRECT_URL:-$DATABASE_URL}" npx prisma migrate deploy || exit 1; \
  fi && \
  node dist/main'
