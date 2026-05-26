import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { existsSync, unlinkSync } from 'fs';
import { VideoInfoDto, FormatDto } from '../downloader/dto/video-info.dto';

const execAsync = promisify(exec);

@Injectable()
export class YtdlpService {
  private readonly logger = new Logger(YtdlpService.name);
  private readonly ytdlpPath: string;
  private readonly cookiesPath: string;

  constructor(private config: ConfigService) {
    this.ytdlpPath = this.config.get<string>('YTDLP_PATH') || 'yt-dlp';
    this.cookiesPath = './youtube_cookies.txt';
  }

  /**
   * 1️⃣ ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ВИДЕО
   */
  async getVideoInfo(url: string): Promise<VideoInfoDto> {
    this.logger.log(`🔍 Анализ: ${url}`);

    try {
      const args = [
        '--dump-single-json',
        '--no-playlist',
        '--no-warnings',
        '--socket-timeout',
        '10',
        url,
      ];

      if (existsSync(this.cookiesPath)) {
        this.logger.debug(`🍪 Куки найдены: ${this.cookiesPath}`);
        args.unshift('--cookies', this.cookiesPath);
      }

      const { stdout } = await execAsync(`"${this.ytdlpPath}" ${args.map((a) => `"${a}"`).join(' ')}`, {
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        timeout: 15000,
      });

      const data = JSON.parse(stdout);

      return {
        id: data.id,
        url: data.webpage_url || url,
        title: this.sanitizeFilename(data.title),
        uploader: data.uploader || data.channel || 'Unknown',
        duration: data.duration || 0,
        viewCount: data.view_count || 0,
        likeCount: data.like_count || 0,
        uploadDate: data.upload_date || '',
        thumbnail: data.thumbnail || '',
        width: data.width || 0,
        height: data.height || 0,
        formats: this.getBestFormats(data.formats || []),
      };
    } catch (error: any) {
      this.logger.error(`❌ Ошибка getVideoInfo: ${error.message}`);
      throw new Error('Видео недоступно или ссылка неверна.');
    }
  }

  /**
   * 2️⃣ ФИЛЬТРАЦИЯ ФОРМАТОВ (Улучшенная)
   */
  private getBestFormats(formats: any[]): FormatDto[] {
    const videoFormats = new Map<number, FormatDto>();
    const audioFormats: FormatDto[] = [];

    formats.forEach((f) => {
      const vcodec = f.vcodec ?? '';
      const acodec = f.acodec ?? '';
      const size = f.filesize ?? f.filesize_approx ?? 0;
      const tbr = f.tbr ?? 0;
      const height = f.height ?? 0;

      // hasVideo — есть height И vcodec не 'none' (или vcodec пустой но есть height)
      const hasVideo = height > 0 && vcodec !== 'none';
      const hasAudio = acodec !== '' && acodec !== 'none';

      // 🎵 АУДИО
      if (!hasVideo && hasAudio) {
        audioFormats.push({
          formatId: f.format_id,
          ext: 'm4a',
          resolution: 'audio',
          filesize: size,
          quality: tbr,
          hasAudio: true,
          vcodec: null,
        });
        return;
      }

      // 🎬 ВИДЕО
      if (!hasVideo || height < 144) return;

      const existing = videoFormats.get(height);
      const score = size || tbr * 1000;
      const existingScore = existing
        ? existing.filesize || existing.quality * 1000
        : -1;

      // Берём лучший по score для каждого разрешения
      if (!existing || score > existingScore) {
        videoFormats.set(height, {
          formatId: f.format_id,
          ext: 'mp4',
          resolution: `${height}p`,
          filesize: size,
          quality: height,
          hasAudio: hasAudio,
          vcodec: vcodec || 'unknown',
        });
      }
    });

    const sortedVideos = Array.from(videoFormats.values()).sort(
      (a, b) => b.quality - a.quality,
    );

    const bestAudio = audioFormats.sort((a, b) => b.quality - a.quality)[0];
    if (bestAudio) sortedVideos.push(bestAudio);

    this.logger.debug(
      `✅ Итого форматов: ${sortedVideos.length} | ${sortedVideos.map((f) => f.resolution).join(', ')}`,
    );

    return sortedVideos;
  }

  /**
   * 3️⃣ СКАЧИВАНИЕ С ОПТИМИЗАЦИЕЙ ДЛЯ СТРИМИНГА
   */
  async downloadVideo(
    url: string,
    formatId: string,
    outputPath: string,
    isAudio: boolean,
    onProgress: (progress: number) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      this.logger.log(`🚀 Загрузка: ${url} | Format: ${formatId}`);

      const outputPathBase = outputPath.replace(/\.(mp4|m4a|webm)$/, '');

      const args = [
        url,
        '--no-playlist',
        '--no-mtime',
        '--restrict-filenames',
        '--output',
        `${outputPathBase}.%(ext)s`,
        '--newline',
        '--progress-template',
        '%(progress._percent_str)s',
      ];

      if (existsSync(this.cookiesPath)) {
        args.push('--cookies', this.cookiesPath);
      }

      if (isAudio) {
        args.push('-f', 'bestaudio/best');
        args.push('--no-postprocessor-args');
        args.push('--write-thumbnail');
        args.push('--convert-thumbnail', 'jpg');
      } else {
        args.push('-f', `${formatId}+bestaudio/best`);
        args.push('--merge-output-format', 'mp4');
        args.push('--ppa', 'ffmpeg:-movflags +faststart');
        args.push('--write-thumbnail');
        args.push('--convert-thumbnail', 'jpg');
      }

      const child = spawn(this.ytdlpPath, args, {
        windowsHide: true,
      });

      let lastProgress = 0;
      let detectedFilename: string | null = null;

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();

        const mergeMatch = text.match(/Merging formats into "(.+?)"/);
        if (mergeMatch) detectedFilename = mergeMatch[1];

        const destMatch = text.match(/Destination: (.+?)$/m);
        if (destMatch) detectedFilename = destMatch[1].trim();

        const percentMatch = text.match(/(\d+\.?\d*)%/);
        if (percentMatch) {
          const percent = parseFloat(percentMatch[1]);
          if (
            !isNaN(percent) &&
            (percent - lastProgress >= 5 || percent >= 99)
          ) {
            onProgress(percent);
            lastProgress = percent;
            this.logger.debug(`Загрузка: ${percent}%`);
          }
        }
      });

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        if (text.toLowerCase().includes('error')) {
          this.logger.warn(`⚠️ yt-dlp: ${text.substring(0, 200)}`);
        }
      });

      child.on('close', (code) => {
        if (code === 0) {
          const finalExt = isAudio ? '.m4a' : '.mp4';
          const finalPath = detectedFilename || `${outputPathBase}${finalExt}`;

          this.logger.log(`✅ Готово: ${finalPath}`);
          resolve(finalPath);
        } else {
          this.logger.error(`❌ yt-dlp код ошибки: ${code}`);
          reject(new Error('Ошибка при скачивании файла'));
        }
      });

      child.on('error', (err) => {
        this.logger.error(`❌ Ошибка процесса: ${err.message}`);
        reject(err);
      });
    });
  }

  /**
   * 4️⃣ ГЕНЕРАЦИЯ ПРЕВЬЮ (НОВОЕ!)
   */
  async generateThumbnail(videoPath: string): Promise<string | null> {
    try {
      const thumbPath = videoPath.replace(/\.\w+$/, '.jpg');

      this.logger.debug(`🖼️ Генерация превью: ${thumbPath}`);

      await execAsync(
        `ffmpeg -ss 00:00:01 -i "${videoPath}" -vframes 1 -vf "scale=320:-1" -y "${thumbPath}"`,
        { timeout: 10000 },
      ).catch(() => null);

      if (existsSync(thumbPath)) {
        this.logger.log(`✅ Превью готово: ${thumbPath}`);
        return thumbPath;
      }

      return null;
    } catch (error: any) {
      this.logger.warn(`⚠️ Не удалось создать превью: ${error.message}`);
      return null;
    }
  }

  getThumbnailPath(videoPath: string): string | null {
    const base = videoPath.replace(/\.(mp4|m4a|webm)$/, '');
    const thumbPath = videoPath.replace(/\.\w+$/, '.jpg');

    if (existsSync(thumbPath)) {
      return thumbPath;
    }
    return null;
  }

  /**
   * 6️⃣ ОЧИСТКА ИМЕНИ ФАЙЛА
   */
  private sanitizeFilename(filename: string): string {
    return filename.substring(0, 100); // Макс 100 символов
    //.replace(/[<>:"/\\|?*]/g, '_') // Запрещенные символы
    //.replace(/\s+/g, '_') // Пробелы -> _
  }

  /**
   * 7️⃣ БЕЗОПАСНОЕ УДАЛЕНИЕ ФАЙЛА
   */
  async safeDelete(filePath: string): Promise<void> {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        this.logger.debug(`🗑️ Удален: ${filePath}`);
      }
    } catch (error: any) {
      this.logger.warn(`⚠️ Не удалось удалить ${filePath}: ${error.message}`);
    }
  }
}
