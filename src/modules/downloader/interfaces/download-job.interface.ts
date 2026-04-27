// downloader/interfaces/download-job.interface.ts
export interface DownloadJobData {
  chatId: number;
  userId: string; // BigInt переводим в string для JSON
  videoData: any;
  formatId: string;
  resolution: string;
  isAudio: boolean;
  isInstagram: boolean;
}