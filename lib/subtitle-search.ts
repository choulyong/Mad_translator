import fs from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { Readable } from "stream";

export interface SubtitleResult {
  id: string;
  fileName: string;
  language: string;
  languageCode: string;
  source: "opensubtitles" | "subdl";
  downloadId: string;
  rating?: number;
  downloadCount?: number;
  hearingImpaired?: boolean;
  release?: string;
}

// ========================
// OpenSubtitles API
// ========================

const OS_BASE = "https://api.opensubtitles.com/api/v1";

let osToken: string | null = null;
let osTokenExpiry = 0;

async function osLogin(): Promise<string> {
  if (osToken && Date.now() < osTokenExpiry) return osToken;

  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!apiKey || !username || !password) throw new Error("OpenSubtitles credentials not configured");

  const res = await fetch(`${OS_BASE}/login`, {
    method: "POST",
    headers: {
      "Api-Key": apiKey,
      "Content-Type": "application/json",
      "User-Agent": "MovieRenamer v1.0",
    },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    const msg = errBody?.message || `status ${res.status}`;
    throw new Error(`OpenSubtitles 로그인 실패: ${msg}`);
  }
  const data = await res.json();
  osToken = data.token;
  osTokenExpiry = Date.now() + 23 * 60 * 60 * 1000; // 23h
  return osToken!;
}

export async function searchOpenSubtitles(
  imdbId: string,
  languages: string[] = ["en", "ko"]
): Promise<SubtitleResult[]> {
  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) return [];

  try {
    // IMDB ID에서 tt 접두사 제거 후 숫자만
    const numericId = imdbId.replace("tt", "");
    const langParam = languages.join(",");

    const res = await fetch(
      `${OS_BASE}/subtitles?imdb_id=${numericId}&languages=${langParam}&order_by=download_count&order_direction=desc`,
      {
        headers: {
          "Api-Key": apiKey,
          "User-Agent": "MovieRenamer v1.0",
        },
      }
    );

    if (!res.ok) return [];
    const data = await res.json();

    return (data.data || []).map((item: Record<string, unknown>) => {
      const attrs = item.attributes as Record<string, unknown>;
      const files = (attrs.files as Record<string, unknown>[]) || [];
      const file = files[0] as Record<string, unknown> | undefined;

      return {
        id: String(item.id),
        fileName: file?.file_name || attrs.release || "subtitle.srt",
        language: String(attrs.language || ""),
        languageCode: String(attrs.language || ""),
        source: "opensubtitles" as const,
        downloadId: String(file?.file_id || ""),
        rating: Number(attrs.ratings) || 0,
        downloadCount: Number(attrs.download_count) || 0,
        hearingImpaired: Boolean(attrs.hearing_impaired),
        release: String(attrs.release || ""),
      };
    });
  } catch {
    return [];
  }
}

export async function downloadOpenSubtitle(
  fileId: string,
  destPath: string
): Promise<string> {
  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) throw new Error("OpenSubtitles API key not configured");

  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!username || !password) {
    throw new Error("OpenSubtitles 다운로드에는 username/password가 필요합니다. .env.local에 설정해주세요.");
  }

  const token = await osLogin();

  // 다운로드 링크 요청
  const res = await fetch(`${OS_BASE}/download`, {
    method: "POST",
    headers: {
      "Api-Key": apiKey,
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "MovieRenamer v1.0",
    },
    body: JSON.stringify({ file_id: Number(fileId) }),
  });

  if (!res.ok) throw new Error(`Download request failed: ${res.status}`);
  const data = await res.json();
  const downloadUrl = data.link;
  const fileName = data.file_name || "subtitle.srt";

  // SRT 파일 다운로드
  const srtRes = await fetch(downloadUrl);
  if (!srtRes.ok || !srtRes.body) throw new Error("Failed to download SRT");

  const finalPath = path.join(destPath, fileName);
  const writeStream = createWriteStream(finalPath);
  await pipeline(Readable.fromWeb(srtRes.body as never), writeStream);

  return finalPath;
}

// ========================
// SubDL API
// ========================

const SUBDL_BASE = "https://api.subdl.com/api/v1/subtitles";

export async function searchSubDL(
  imdbId: string,
  languages: string[] = ["EN", "KO"]
): Promise<SubtitleResult[]> {
  const apiKey = process.env.SUBDL_API_KEY;
  if (!apiKey) return [];

  try {
    const langParam = languages.map(l => l.toUpperCase()).join(",");
    const res = await fetch(
      `${SUBDL_BASE}?api_key=${apiKey}&imdb_id=${imdbId}&languages=${langParam}&subs_per_page=30&type=movie`
    );

    if (!res.ok) return [];
    const data = await res.json();

    if (!data.subtitles) return [];

    return (data.subtitles as Record<string, unknown>[]).map((item) => ({
      id: String(item.sd_id || item.id || ""),
      fileName: String(item.release_name || item.name || "subtitle.srt"),
      language: String(item.language || ""),
      languageCode: String(item.lang || ""),
      source: "subdl" as const,
      downloadId: String(item.url || ""),
      rating: 0,
      downloadCount: Number(item.download_count) || 0,
      hearingImpaired: Boolean(item.hi),
      release: String(item.release_name || ""),
    }));
  } catch {
    return [];
  }
}

export async function downloadSubDL(
  url: string,
  destPath: string
): Promise<string> {
  // SubDL returns a zip file URL
  const downloadUrl = url.startsWith("http") ? url : `https://dl.subdl.com${url}`;

  const res = await fetch(downloadUrl);
  if (!res.ok || !res.body) throw new Error("Failed to download from SubDL");

  // ZIP 파일 임시 저장
  const zipPath = path.join(destPath, "_subtitle_temp.zip");
  const writeStream = createWriteStream(zipPath);
  await pipeline(Readable.fromWeb(res.body as never), writeStream);

  // ZIP 해제 (Node.js built-in zlib 사용)
  const { execSync } = await import("child_process");
  try {
    // PowerShell로 ZIP 해제
    execSync(
      `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destPath}' -Force"`,
      { timeout: 15000 }
    );
  } finally {
    // 임시 ZIP 삭제
    await fs.unlink(zipPath).catch(() => {});
  }

  // 해제된 SRT 파일 찾기
  const entries = await fs.readdir(destPath);
  const srtFile = entries.find(e => e.endsWith(".srt") && !e.startsWith("_"));
  if (!srtFile) throw new Error("No SRT file found in ZIP");

  return path.join(destPath, srtFile);
}

// ========================
// 통합 검색
// ========================

export async function searchSubtitles(
  imdbId: string,
  languages: string[] = ["en", "ko"]
): Promise<SubtitleResult[]> {
  // 두 API 병렬 검색
  const [osResults, subdlResults] = await Promise.all([
    searchOpenSubtitles(imdbId, languages),
    searchSubDL(imdbId, languages.map(l => l.toUpperCase())),
  ]);

  // SubDL 우선 (로그인 불필요), OpenSubtitles 추가
  return [...subdlResults, ...osResults];
}

export async function downloadSubtitle(
  result: SubtitleResult,
  movieDir: string
): Promise<string> {
  // 다운로드 디렉토리 확인/생성
  await fs.mkdir(movieDir, { recursive: true });

  if (result.source === "opensubtitles") {
    return downloadOpenSubtitle(result.downloadId, movieDir);
  } else {
    return downloadSubDL(result.downloadId, movieDir);
  }
}
