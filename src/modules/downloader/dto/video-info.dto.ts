export class VideoInfoDto {
  id: string;
  url: string;
  title: string;
  uploader: string;
  duration: number;
  viewCount: number;
  likeCount: number;
  uploadDate: string;
  thumbnail: string;
  width?: number;        // 🆕 Ширина видео
  height?: number;       // 🆕 Высота видео
  directUrl?: string;    // 🆕 Прямая ссылка на готовый H.264-файл (URL-direct)
  formats: FormatDto[];
}

export class FormatDto {
  formatId: string;
  ext: string;
  resolution: string;
  filesize: number;
  quality: number;
  hasAudio: boolean;
  vcodec?: string | null; // 🆕 Кодек для проверки совместимости
}