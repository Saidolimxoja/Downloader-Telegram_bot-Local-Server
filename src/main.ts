// src/main.ts

import { LogLevel, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as fs from 'fs';
import { AppModule } from './app.module';
import { getRole } from './config/role';

/**
 * Уровни логирования из переменной окружения.
 *
 * Раньше debug был включён всегда, в том числе в проде: каждая проверка
 * подписки, каждый процент загрузки писались в лог. На десяти тысячах
 * пользователей это гигабайты мусора и лишний дисковый ввод-вывод.
 */
function resolveLogLevels(): LogLevel[] {
  const configured = process.env.LOG_LEVEL?.toLowerCase();

  if (configured === 'debug') return ['error', 'warn', 'log', 'debug'];
  if (configured === 'error') return ['error'];
  if (configured === 'warn') return ['error', 'warn'];
  if (configured === 'log') return ['error', 'warn', 'log'];

  // По умолчанию: в проде без debug, в разработке — со всем
  return process.env.NODE_ENV === 'production'
    ? ['error', 'warn', 'log']
    : ['error', 'warn', 'log', 'debug'];
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: resolveLogLevels(),
  });

  // Корректное завершение: дать воркерам дописать текущие задачи,
  // закрыть соединения с БД и Redis
  app.enableShutdownHooks();

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const downloadsDir = process.env.DOWNLOADS_DIR || './downloads';
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);

  const role = getRole();
  console.log('\n========================================');
  console.log('   YUKLANGANBOT');
  console.log('========================================');
  console.log(`🎭 Роль процесса: ${role}`);
  console.log(`🩺 Health:  http://localhost:${port}/health`);
  console.log(`📊 Metrics: http://localhost:${port}/metrics`);
  console.log(`📦 Окружение: ${process.env.NODE_ENV || 'development'}`);
  console.log('========================================\n');
}

bootstrap().catch((error) => {
  console.error('❌ Не удалось запустить приложение:', error);
  process.exit(1);
});
