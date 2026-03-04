import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const db = new Database("local.db");

const SUBTITLE_EXTS = [".srt", ".ass", ".ssa", ".sub", ".vtt"];

function isSubtitleFile(name) {
  return SUBTITLE_EXTS.includes(path.extname(name).toLowerCase());
}

function detectLanguage(text) {
  const cleaned = text
    .replace(/\d+/g, "")
    .replace(/-->|:|,|\./g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{[^}]+\}/g, "")
    .trim();
  if (cleaned.length === 0) return "unknown";

  const koreanChars = (cleaned.match(/[\uAC00-\uD7AF\u3130-\u318F]/g) || []).length;
  const ratio = koreanChars / cleaned.length;
  if (ratio > 0.15) return "ko";

  const latinChars = (cleaned.match(/[a-zA-Z]/g) || []).length;
  const latinRatio = latinChars / cleaned.length;
  if (latinRatio > 0.3) return "en";

  return "unknown";
}

function analyzeSubtitle(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    let text = buf.toString("utf-8");
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (buf[0] === 0xFF && buf[1] === 0xFE) {
      text = buf.toString("utf16le").slice(1);
    }

    const sample = text.slice(0, 2000);
    const language = detectLanguage(sample);

    const lines = sample.split(/\r?\n/);
    const dialogLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\d+$/.test(trimmed)) continue;
      if (/\d{2}:\d{2}:\d{2}/.test(trimmed)) continue;
      dialogLines.push(trimmed);
      if (dialogLines.join("\n").length > 500) break;
    }

    return { language, preview: dialogLines.join("\n").slice(0, 500) };
  } catch (e) {
    return { language: "unknown", preview: "" };
  }
}

/** 재귀적으로 자막 파일 찾기 (Subs/ 하위폴더 포함, 1단계까지) */
function findSubtitlesInDir(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && isSubtitleFile(entry.name)) {
        results.push(fullPath);
      } else if (entry.isDirectory() && entry.name.toLowerCase() === "subs") {
        // Subs/ 하위 폴더도 탐색
        try {
          const subEntries = fs.readdirSync(fullPath);
          for (const subEntry of subEntries) {
            if (isSubtitleFile(subEntry)) {
              results.push(path.join(fullPath, subEntry));
            }
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return results;
}

// ---

const movies = db.prepare("SELECT id, title, file_path FROM movies").all();
console.log(`전체 ${movies.length}개 영화 자막 스캔\n`);

let found = 0;

for (const movie of movies) {
  const videoDir = path.dirname(movie.file_path);

  // 영화 폴더 안의 모든 자막 파일 (Subs/ 포함)
  const subtitlePaths = findSubtitlesInDir(videoDir);

  // 한글/영어만 필터 (불필요한 언어 제외하려면 여기서)
  const subtitles = [];
  for (const subPath of subtitlePaths) {
    const { language, preview } = analyzeSubtitle(subPath);
    // 파일명에 언어 힌트가 있으면 활용
    const fileName = path.basename(subPath).toLowerCase();
    let finalLang = language;
    if (fileName.includes("_ko") || fileName.includes(".kor") || fileName.includes("korean")) finalLang = "ko";
    else if (fileName.includes(".eng") || fileName.includes("english") || fileName.includes(".en.")) finalLang = "en";

    subtitles.push({
      fileName: path.basename(subPath),
      filePath: subPath,
      language: finalLang,
      preview,
    });
  }

  if (subtitles.length > 0) {
    // 한글 + 영어만 우선 저장 (나머지 언어는 제외 가능하나, 일단 전부 저장)
    db.prepare("UPDATE movies SET subtitle_files = ? WHERE id = ?")
      .run(JSON.stringify(subtitles), movie.id);
    found++;

    const koCount = subtitles.filter(s => s.language === "ko").length;
    const enCount = subtitles.filter(s => s.language === "en").length;
    const otherCount = subtitles.length - koCount - enCount;
    const parts = [];
    if (koCount) parts.push(`한글 ${koCount}`);
    if (enCount) parts.push(`EN ${enCount}`);
    if (otherCount) parts.push(`기타 ${otherCount}`);
    console.log(`${movie.title}: ${subtitles.length}개 (${parts.join(", ")})`);
  }
}

console.log(`\n완료: ${found}/${movies.length}개 영화에 자막 발견`);
