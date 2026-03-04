import fs from "fs/promises";
import path from "path";

export interface SubtitleInfo {
  fileName: string;
  filePath: string;
  language: "ko" | "en" | "unknown";
  preview: string;
}

const SUBTITLE_EXTS = [".srt", ".ass", ".ssa", ".sub", ".vtt"];

function isSubtitleFile(name: string): boolean {
  return SUBTITLE_EXTS.includes(path.extname(name).toLowerCase());
}

/** 한글 문자 비율로 언어 판별 */
function detectLanguage(text: string): "ko" | "en" | "unknown" {
  // SRT 타임코드/숫자/태그 제거
  const cleaned = text
    .replace(/\d+/g, "")
    .replace(/-->|:|,|\./g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{[^}]+\}/g, "")
    .trim();

  if (cleaned.length === 0) return "unknown";

  // 한글 문자 수 카운트 (가-힣 + ㄱ-ㅎ + ㅏ-ㅣ)
  const koreanChars = (cleaned.match(/[\uAC00-\uD7AF\u3130-\u318F\u31F0-\u31FF]/g) || []).length;
  const ratio = koreanChars / cleaned.length;

  if (ratio > 0.15) return "ko";
  // 영어 문자 체크
  const latinChars = (cleaned.match(/[a-zA-Z]/g) || []).length;
  const latinRatio = latinChars / cleaned.length;
  if (latinRatio > 0.3) return "en";

  return "unknown";
}

/** SRT 파일을 읽어서 언어 판별 + 미리보기 추출 */
async function analyzeSubtitle(filePath: string): Promise<{ language: SubtitleInfo["language"]; preview: string }> {
  try {
    const buf = await fs.readFile(filePath);

    // UTF-8, UTF-16LE, EUC-KR 순서로 시도
    let text = buf.toString("utf-8");

    // BOM 제거
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // UTF-16 LE BOM
    if (buf[0] === 0xFF && buf[1] === 0xFE) {
      text = buf.toString("utf16le").slice(1);
    }

    // 앞 2000자만 분석
    const sample = text.slice(0, 2000);
    const language = detectLanguage(sample);

    // 미리보기: 실제 대사만 추출 (타임코드 제거), 앞 500자
    const lines = sample.split(/\r?\n/);
    const dialogLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // 숫자만(순서번호), 빈 줄, 타임코드 건너뛰기
      if (!trimmed) continue;
      if (/^\d+$/.test(trimmed)) continue;
      if (/\d{2}:\d{2}:\d{2}/.test(trimmed)) continue;
      dialogLines.push(trimmed);
      if (dialogLines.join("\n").length > 500) break;
    }

    return { language, preview: dialogLines.join("\n").slice(0, 500) };
  } catch {
    return { language: "unknown", preview: "" };
  }
}

/** 영화 파일명에 매칭되는 자막 파일 찾기 */
function getVideoBaseName(videoName: string): string {
  return path.basename(videoName, path.extname(videoName)).toLowerCase();
}

/** 자막 파일이 영화와 매칭되는지 (파일명 접두사 기반) */
function isSubtitleMatch(subtitleName: string, videoBaseName: string): boolean {
  const subBase = path.basename(subtitleName, path.extname(subtitleName)).toLowerCase();

  // 정확 매칭 또는 접두사 매칭 (예: movie.ko.srt → movie, movie_Eng.srt → movie)
  // 역방향 매칭: 자막명이 영상명보다 짧은 경우 (예: videoBase="주토피아 2 (2025)_1", subBase="주토피아 2 (2025)")
  if (subBase === videoBaseName || subBase.startsWith(videoBaseName) || videoBaseName.startsWith(subBase)) return true;

  return false;
}

/** 주어진 디렉토리들에서 비디오에 매칭되는 자막 찾기 */
export async function findSubtitlesForVideo(
  videoName: string,
  searchDirs: string[]
): Promise<SubtitleInfo[]> {
  const videoBase = getVideoBaseName(videoName);
  const results: SubtitleInfo[] = [];
  const seen = new Set<string>();

  for (const dir of searchDirs) {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (!isSubtitleFile(entry)) continue;
        if (!isSubtitleMatch(entry, videoBase)) continue;

        const fullPath = path.join(dir, entry);
        if (seen.has(fullPath)) continue;
        seen.add(fullPath);

        const { language, preview } = await analyzeSubtitle(fullPath);
        results.push({ fileName: entry, filePath: fullPath, language, preview });
      }
    } catch {
      // 디렉토리 접근 실패 무시
    }
  }

  // 중복 제거: 같은 파일경로 제거
  const unique = results.filter((r, i, arr) => arr.findIndex(x => x.filePath === r.filePath) === i);
  return unique;
}

/** 스캔 목록 전체에서 자막 파일 수집 (같은 폴더 아니어도) */
export async function findAllSubtitles(
  scanDirs: string[]
): Promise<Map<string, string[]>> {
  // dir → subtitle file paths
  const subtitleMap = new Map<string, string[]>();

  for (const dir of scanDirs) {
    try {
      const entries = await fs.readdir(dir);
      const subs = entries.filter(isSubtitleFile);
      if (subs.length > 0) {
        subtitleMap.set(dir, subs.map(s => path.join(dir, s)));
      }
    } catch {
      // ignore
    }
  }

  return subtitleMap;
}

export { isSubtitleFile, analyzeSubtitle, getVideoBaseName, isSubtitleMatch };
