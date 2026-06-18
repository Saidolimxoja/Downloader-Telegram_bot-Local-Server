import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { existsSync, unlinkSync } from 'fs';
import { VideoInfoDto, FormatDto } from '../downloader/dto/video-info.dto';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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

      // ⚠️ execFile (не exec) — аргументы передаются массивом, без интерпретации
      // shell. Это исключает command injection через URL пользователя.
      const { stdout } = await execFileAsync(this.ytdlpPath, args, {
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
        directUrl: this.findProgressiveUrl(data.formats || []),
        formats: this.getBestFormats(data.formats || []),
      };
    } catch (error: any) {
      // Пробрасываем реальный текст ошибки yt-dlp, чтобы вызывающий код мог
      // показать понятное сообщение (приватное видео, возрастное ограничение и т.д.)
      const details: string = error.stderr || error.message || '';
      this.logger.error(`❌ Ошибка getVideoInfo: ${details.substring(0, 500)}`);
      throw new Error(details || 'Видео недоступно или ссылка неверна.');
    }
  }

  /**
   * 1.5️⃣ ПРЯМАЯ ССЫЛКА НА ГОТОВЫЙ ФАЙЛ (для URL-direct)
   *
   * Прогрессивный (муксированный) формат — единственный, где видео и звук уже
   * в одном файле. У Instagram это формат с id «2»: и vcodec, и acodec там
   * undefined (а не 'none', как у DASH-дорожек). Именно его серверы Telegram
   * могут скачать сами по ссылке, минуя наш сервер. Возвращаем его url или null.
   */
  private findProgressiveUrl(formats: any[]): string | undefined {
    const progressive = formats.find(
      (f) =>
        f.url &&
        f.vcodec !== 'none' &&
        f.acodec !== 'none' &&
        f.protocol !== 'm3u8' &&
        f.protocol !== 'm3u8_native',
    );
    return progressive?.url || undefined;
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
      const ext = f.ext ?? '';

      // hasVideo — есть height И vcodec не 'none' (или vcodec пустой но есть height)
      const hasVideo = height > 0 && vcodec !== 'none';
      const hasAudio = acodec !== '' && acodec !== 'none';

      // 🎵 АУДИО
      if (!hasVideo && hasAudio) {
        const isNative = ext === 'm4a' || ext === 'mp3' || acodec.includes('mp4a') || acodec.includes('aac');
        audioFormats.push({
          formatId: f.format_id,
          ext: isNative ? 'm4a' : (ext || 'webm'),
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

    const bestAudio = audioFormats.sort((a, b) => {
      const aIsM4a = a.ext === 'm4a';
      const bIsM4a = b.ext === 'm4a';
      if (aIsM4a && !bIsM4a) return -1;
      if (!aIsM4a && bIsM4a) return 1;
      return b.quality - a.quality;
    })[0];
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
        args.push('-f', formatId || 'bestaudio/best');
        args.push('-x');
        args.push('--audio-format', 'm4a');
        args.push('--write-thumbnail');
        args.push('--convert-thumbnail', 'jpg');
      } else {
        // 🍏 iPhone проигрывает только H.264 (avc1) + AAC. VP9/AV1 на айфоне
        // дают «звук есть, обложка есть, картинки нет». --format-sort заставляет
        // yt-dlp среди равных по качеству форматов предпочитать H.264/AAC.
        // Если formatId уже содержит готовый селектор ('+' или 'best',
        // как в прямом скачивании) — используем его как есть, иначе достраиваем.
        const hasSelector = /\+|best/.test(formatId);
        args.push('-f', hasSelector ? formatId : `${formatId}+bestaudio/best`);
        args.push('-S', 'vcodec:h264,acodec:aac');
        args.push('--merge-output-format', 'mp4');
        args.push('--ppa', 'ffmpeg:-movflags +faststart');
        args.push('--write-thumbnail');
        args.push('--convert-thumbnail', 'jpg');
      }

      const child = spawn(this.ytdlpPath, args, {
        windowsHide: true,
      });

      // ⏱️ Защита от зависших загрузок: убиваем процесс через 5 минут,
      // чтобы он не держал слот очереди вечно
      const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
      let settled = false;
      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.logger.error('❌ Таймаут скачивания — убиваю процесс yt-dlp');
        child.kill('SIGKILL');
        reject(new Error('Таймаут скачивания (превышено 5 минут)'));
      }, DOWNLOAD_TIMEOUT_MS);

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
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);

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
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
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
   * 5️⃣ СОВМЕСТИМОСТЬ С iPhone
   *
   * iOS проигрывает видео только аппаратным декодером: H.264 (avc1) 8-бит
   * yuv420p, профиль не выше High, + аудио AAC. Если поток в VP9/AV1/HEVC,
   * либо H.264 с 10-битным/4:2:2/4:4:4 цветом — на айфоне «звук есть, кадр
   * замирает». Проверяем файл через ffprobe и перекодируем ТОЛЬКО если он
   * несовместим (чтобы не жечь CPU на уже корректных видео).
   *
   * Возвращает путь к совместимому файлу (тот же, если перекод не нужен).
   */
  async ensureIphoneCompatible(videoPath: string): Promise<string> {
    try {
      // Узнаём кодек, пиксельный формат и профиль видеопотока
      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,pix_fmt,profile',
        '-of',
        'json',
        videoPath,
      ]);

      const info = JSON.parse(stdout);
      const stream = info?.streams?.[0] ?? {};
      const codec = String(stream.codec_name || '').toLowerCase();
      const pixFmt = String(stream.pix_fmt || '').toLowerCase();
      const profile = String(stream.profile || '').toLowerCase();

      // 10-битные/4:2:2/4:4:4 профили H.264 айфон не декодирует
      const badProfile =
        profile.includes('10') ||
        profile.includes('4:2:2') ||
        profile.includes('4:4:4');

      const isCompatible =
        codec === 'h264' && pixFmt === 'yuv420p' && !badProfile;

      if (isCompatible) {
        this.logger.debug(
          `🍏 Видео уже совместимо (h264/${pixFmt}/${profile}), перекод не нужен`,
        );
        return videoPath;
      }

      this.logger.log(
        `🔄 Перекодирую для iPhone (было: ${codec}/${pixFmt}/${profile})`,
      );

      const fixedPath = videoPath.replace(/\.mp4$/i, '') + '_ios.mp4';

      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          videoPath,
          '-c:v',
          'libx264',
          '-profile:v',
          'high',
          '-pix_fmt',
          'yuv420p',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          fixedPath,
        ],
        { timeout: 5 * 60 * 1000 },
      );

      if (existsSync(fixedPath)) {
        // Заменяем исходник перекодированным «на месте» — путь к файлу не
        // меняется, поэтому превью (.jpg), кеш и загрузка работают как прежде
        await this.safeDelete(videoPath);
        fs.renameSync(fixedPath, videoPath);
        this.logger.log(`✅ Перекод готов: ${videoPath}`);
        return videoPath;
      }

      this.logger.warn('⚠️ Перекод не создал файл — отдаю оригинал');
      return videoPath;
    } catch (error: any) {
      // При любой ошибке ffprobe/ffmpeg не валим загрузку — отдаём оригинал
      this.logger.warn(`⚠️ Проверка совместимости не удалась: ${error.message}`);
      return videoPath;
    }
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
