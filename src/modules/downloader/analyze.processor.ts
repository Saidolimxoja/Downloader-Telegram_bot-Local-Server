// src/modules/downloader/analyze.processor.ts

import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { AnalysisService } from './analysis.service';
import {
  ANALYZE_QUEUE,
  AnalyzeJobData,
} from './interfaces/download-job.interface';

/**
 * 🔍 ВОРКЕР АНАЛИЗА ССЫЛОК
 *
 * Отдельная очередь от загрузок — намеренно. Анализ быстрый (секунды), но
 * прожорливый по памяти; загрузка долгая, но лёгкая. Общая очередь означала
 * бы, что пачка тяжёлых загрузок блокирует разбор новых ссылок, и человек
 * минутами смотрит на «Анализирую...».
 */
@Processor(ANALYZE_QUEUE, {
  concurrency: parseInt(process.env.MAX_PARALLEL_ANALYSIS ?? '5', 10),
})
export class AnalyzeProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalyzeProcessor.name);

  constructor(private readonly analysisService: AnalysisService) {
    super();
  }

  async process(job: Job<AnalyzeJobData>): Promise<void> {
    // AnalysisService сам сообщает пользователю о проблеме и освобождает
    // его слот — наружу ошибки не выпускает, повторять анализ нечем
    await this.analysisService.analyze(job.data);
  }
}
