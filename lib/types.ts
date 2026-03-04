export interface FileItem {
  id: string;
  name: string;
  path: string;
  size: number;
  status: "idle" | "identifying" | "ready" | "renaming" | "done" | "moved" | "error";
  metadata?: MovieMetadata;
  newName?: string;
  error?: string;
  /** 영화 전용 폴더 경로 (있으면 폴더명도 함께 변경) */
  folderPath?: string;
  /** 원본 폴더명 */
  folderName?: string;
}

export interface MovieMetadata {
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: string;
  releaseDate: string;
  posterPath: string | null;
  overview: string;
  /** OMDB 추가 정보 */
  imdbId?: string | null;
  imdbRating?: string | null;
  rottenTomatoes?: string | null;
  metacritic?: string | null;
}

export interface ParsedFilename {
  title: string;
  year?: number;
}

export interface ActionResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}
