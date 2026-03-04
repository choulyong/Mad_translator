"use server";

import fs from "fs/promises";
import path from "path";
import { v4 as uuid } from "uuid";
import { db } from "@/lib/db";
import { movies } from "@/lib/db/schema";
import type { Movie } from "@/lib/db/schema";
import type { ActionResult, MovieMetadata } from "@/lib/types";
import { desc, eq, isNull, or } from "drizzle-orm";
import { isVideoFile, sanitizeFilename, getExtension } from "@/lib/utils";
import { parseFilename } from "@/lib/parser";
import { searchMovie, searchMovieMultiple, getMovieDetail, getImdbId } from "@/lib/tmdb";
import { getOmdbData } from "@/lib/omdb";
import { getKoreanWikiSummary, getEnglishWikiSummary } from "@/lib/wikipedia";
import { findSubtitlesForVideo, analyzeSubtitle, type SubtitleInfo } from "@/lib/subtitle";
import { searchSubtitles, downloadSubtitle, type SubtitleResult } from "@/lib/subtitle-search";

export async function getMovies(): Promise<ActionResult<Movie[]>> {
  try {
    const result = await db
      .select()
      .from(movies)
      .orderBy(desc(movies.createdAt));
    return { success: true, data: result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch movies";
    return { success: false, error: message };
  }
}

export async function getMovieCount(): Promise<number> {
  try {
    const result = await db.select().from(movies);
    return result.length;
  } catch {
    return 0;
  }
}

export async function getFileSizes(filePaths: string[]): Promise<ActionResult<Record<string, number>>> {
  try {
    const result: Record<string, number> = {};
    for (const fp of filePaths) {
      try {
        const stat = await fs.stat(fp);
        result[fp] = stat.size;
      } catch {
        result[fp] = 0;
      }
    }
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function deleteMovieWithFile(id: string, filePath: string): Promise<ActionResult> {
  try {
    try { await fs.unlink(filePath); } catch { /* 파일 없으면 무시 */ }
    await db.delete(movies).where(eq(movies.id, id));
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function deleteMovie(id: string): Promise<ActionResult> {
  try {
    await db.delete(movies).where(eq(movies.id, id));
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "삭제 실패";
    return { success: false, error: message };
  }
}

export async function deleteAllMovies(): Promise<ActionResult> {
  try {
    await db.delete(movies);
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "전체 삭제 실패";
    return { success: false, error: message };
  }
}

export async function updateMovie(
  id: string,
  data: { title?: string; overview?: string }
): Promise<ActionResult> {
  try {
    await db.update(movies).set(data).where(eq(movies.id, id));
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "수정 실패";
    return { success: false, error: message };
  }
}

export interface ImportedMovie {
  fileName: string;
  filePath: string;
  folderName?: string;
  title: string;
  year: string;
  tmdbId?: number;
  posterPath?: string | null;
  overview?: string;
  releaseDate?: string;
  genres?: string[];
  director?: string;
  writer?: string;
  cast?: string[];
  castProfiles?: { name: string; character: string; profilePath: string | null }[];
  rating?: number;
  runtime?: number | null;
  // OMDb (IMDb / Rotten Tomatoes / Metacritic)
  imdbId?: string | null;
  imdbRating?: string | null;
  rottenTomatoes?: string | null;
  metacritic?: string | null;
  awards?: string | null;
  writer_omdb?: string | null;
  rated?: string | null;
  boxOffice?: string | null;
  // Plot (상세 줄거리)
  plotFull?: string | null;
  plotFullKo?: string | null;
  // Wikipedia
  wikiSummary?: string | null;
  wikiOverview?: string | null;
  wikiUrl?: string | null;
  // Subtitles
  subtitles?: SubtitleInfo[];
}

/** 영화 메타데이터 수집 (TMDB + OMDb + Wikipedia) */
async function enrichMovieData(
  parsedTitle: string,
  yearStr: string | undefined
): Promise<Omit<ImportedMovie, "fileName" | "filePath" | "folderName">> {
  // 1) TMDB 검색
  const meta = await searchMovie(parsedTitle, yearStr);

  // 2) TMDB 상세 (출연진, 감독, 장르)
  const detail = meta?.tmdbId ? await getMovieDetail(meta.tmdbId) : null;

  // 3) TMDB → IMDb ID → OMDb (IMDb/RT/Metacritic 평점)
  const imdbId = meta?.tmdbId ? await getImdbId(meta.tmdbId) : null;
  const omdb = imdbId ? await getOmdbData(imdbId) : null;

  // Wikipedia 검색용 영어 제목: OMDb englishTitle > TMDB originalTitle > parsedTitle
  const englishTitle = omdb?.englishTitle || meta?.originalTitle || parsedTitle;

  // 4) 한국어 + 영어 위키피디아 (병렬 검색)
  const searchTitle = meta?.title || parsedTitle;
  const searchYear = meta?.year || yearStr;
  const [koWiki, enWiki] = await Promise.all([
    getKoreanWikiSummary(searchTitle, searchYear),
    getEnglishWikiSummary(englishTitle, searchYear),
  ]);

  // Plot 우선순위: 영어 위키 Plot > 한국어 위키 Plot > OMDB full plot
  let bestPlot = omdb?.plot || "";
  if (enWiki?.plot && enWiki.plot.length > bestPlot.length) bestPlot = enWiki.plot;
  if (koWiki?.plot && koWiki.plot.length > bestPlot.length) bestPlot = koWiki.plot;

  // wikiSummary: 가장 긴 Plot 또는 Summary
  const wikiSummary = bestPlot || koWiki?.summary || enWiki?.summary || "";

  // wikiOverview: Summary API (영어 우선, 더 상세)
  const wikiOverview = (enWiki?.summary && enWiki.summary.length > (koWiki?.summary?.length || 0))
    ? enWiki.summary
    : koWiki?.summary || enWiki?.summary || "";

  // overview 우선순위: 위키피디아 한국어 plot > summary > TMDB 한국어 > TMDB 영어
  const overview = koWiki?.plot || koWiki?.summary || detail?.overview || meta?.overview || "";

  // 5) 한글 번역 (plotFull + wikiOverview 병렬)
  const plotToSave = bestPlot || omdb?.plot || null;
  let plotFullKo: string | null = null;
  let wikiOverviewKo = wikiOverview;

  const needsPlotTranslate = plotToSave && (plotToSave.match(/[가-힣]/g) || []).length < 5;
  const needsOverviewTranslate = wikiOverview && (wikiOverview.match(/[가-힣]/g) || []).length < 5;

  if (needsPlotTranslate || needsOverviewTranslate) {
    try {
      const { translateToKorean } = await import("@/lib/translate");
      const tasks: Promise<string | null>[] = [];
      tasks.push(needsPlotTranslate ? translateToKorean(plotToSave!).catch(() => null) : Promise.resolve(null));
      tasks.push(needsOverviewTranslate ? translateToKorean(wikiOverview!).catch(() => null) : Promise.resolve(null));
      const [plotKo, overviewKo] = await Promise.all(tasks);
      if (plotKo && plotKo !== plotToSave) plotFullKo = plotKo;
      if (overviewKo && overviewKo !== wikiOverview) wikiOverviewKo = overviewKo;
    } catch {
      // 번역 실패해도 영어 데이터는 보존
    }
  }

  return {
    title: meta?.title ?? parsedTitle,
    year: meta?.year ?? (yearStr || ""),
    tmdbId: meta?.tmdbId,
    posterPath: meta?.posterPath,
    overview,
    releaseDate: meta?.releaseDate,
    genres: detail?.genres,
    director: detail?.director,
    writer: detail?.writer,
    cast: detail?.cast,
    castProfiles: detail?.castProfiles,
    rating: detail?.rating,
    runtime: detail?.runtime,
    imdbId: omdb?.imdbId || imdbId,
    imdbRating: omdb?.imdbRating,
    rottenTomatoes: omdb?.rottenTomatoes,
    metacritic: omdb?.metacritic,
    awards: omdb?.awards,
    writer_omdb: omdb?.writer,
    rated: omdb?.rated,
    boxOffice: omdb?.boxOffice,
    plotFull: plotToSave,
    plotFullKo,
    wikiSummary: wikiSummary || null,
    wikiOverview: wikiOverviewKo || null,
    wikiUrl: enWiki?.url || koWiki?.url || null,
  };
}

/** 재귀적으로 디렉토리를 탐색하여 비디오 파일 수집
 *  ※ withFileTypes 미사용 — NAS/UNC 경로에서 Dirent 타입이 부정확한 문제 회피
 *  ※ stat 호출은 20개씩 배치 — NAS 과부하 방지
 */
async function collectVideosRecursive(
  dirPath: string,
  rootDir: string,
  maxDepth: number = 15
): Promise<{ fileName: string; filePath: string; folderName?: string; parentDir: string }[]> {
  if (maxDepth <= 0) return [];

  // UNC 경로 처리 (scan.ts와 동일)
  // Detect failed UNC path: C:\192.168.0.2\torrent (single backslash + IP pattern)
  if (/^[A-Z]:\\[\d.]+[\\\/]/.test(dirPath)) {
    dirPath = dirPath.replace(/^[A-Z]:\\/, "").replace(/\\/g, "/");
  }

  // Normalize UNC/SMB path — keep forward slashes for Node.js compatibility
  const isUnc = dirPath.startsWith("\\\\") || dirPath.startsWith("//");
  if (isUnc) {
    dirPath = dirPath.replace(/\\/g, "/");
    if (!dirPath.startsWith("//")) dirPath = "//" + dirPath.replace(/^\/+/, "");
  }

  // rootDir도 동일하게 처리
  if (/^[A-Z]:\\[\d.]+[\\\/]/.test(rootDir)) {
    rootDir = rootDir.replace(/^[A-Z]:\\/, "").replace(/\\/g, "/");
  }
  if (rootDir.startsWith("\\\\") || rootDir.startsWith("//")) {
    rootDir = rootDir.replace(/\\/g, "/");
    if (!rootDir.startsWith("//")) rootDir = "//" + rootDir.replace(/^\/+/, "");
  }

  const results: { fileName: string; filePath: string; folderName?: string; parentDir: string }[] = [];

  try {
    // withFileTypes: false — NAS/UNC 호환
    const entryNames = await fs.readdir(dirPath);

    // 스캔 진행 로그 (첫 레벨에서만)
    if (maxDepth === 15 && entryNames.length > 0) {
      console.log(`[스캔] ${dirPath} — ${entryNames.length}개 항목`);
    }

    // 비디오 파일은 확장자로 즉시 판별 (stat 불필요)
    const videoNames = entryNames.filter((name) => isVideoFile(name));
    if (videoNames.length > 0) {
      // UNC 경로와 일반 경로 다르게 처리
      const isRoot = isUnc
        ? dirPath.replace(/\/+$/, "") === rootDir.replace(/\/+$/, "")
        : path.resolve(dirPath) === path.resolve(rootDir);
      console.log(`[영상 발견] ${dirPath} — ${videoNames.length}개: ${videoNames.slice(0, 3).join(", ")} (isRoot=${isRoot}, isUnc=${isUnc})`);
      // 폴더의 모든 영상을 추가 (하나가 아니라!)
      for (const videoName of videoNames) {
        results.push({
          fileName: videoName,
          filePath: isUnc
            ? dirPath.replace(/\/+$/, "") + "/" + videoName
            : path.join(dirPath, videoName),
          folderName: isRoot ? undefined : path.basename(dirPath),
          parentDir: dirPath,
        });
      }
    }

    // 알려진 파일 확장자 제외 (stat 호출 최소화)
    const FILE_EXTS = /\.(srt|ass|ssa|sub|vtt|sup|idx|nfo|jpg|jpeg|png|gif|bmp|tiff|webp|txt|log|nzb|torrent|rar|zip|7z|gz|bz2|xz|par2|sfv|md5|url|bat|sh|exe|msi|ini|xml|json|html|htm|pdf|doc|docx|csv|db|sqlite|iso|img|bin|cue|mp3|flac|wav|aac|ogg|wma|m4a)$/i;
    const dirCandidates = entryNames.filter(
      (name) => !name.startsWith(".") && !isVideoFile(name) && !FILE_EXTS.test(name)
    );

    // 배치 stat (20개씩 — NAS 과부하 방지)
    const STAT_BATCH = 20;
    for (let i = 0; i < dirCandidates.length; i += STAT_BATCH) {
      const batch = dirCandidates.slice(i, i + STAT_BATCH);
      const statResults = await Promise.allSettled(
        batch.map(async (name) => {
          const fullPath = isUnc
            ? dirPath.replace(/\/+$/, "") + "/" + name
            : path.join(dirPath, name);
          const stat = await fs.stat(fullPath);
          return { name, fullPath, isDir: stat.isDirectory() };
        })
      );

      for (const r of statResults) {
        if (r.status === "fulfilled" && r.value.isDir) {
          const subResults = await collectVideosRecursive(
            r.value.fullPath,
            rootDir,
            maxDepth - 1
          );
          results.push(...subResults);
        }
      }
    }
  } catch {
    // 접근 불가 디렉토리 무시
  }

  return results;
}

/** 폴더를 스캔해서 영화 정보를 추출 (DB에 넣지 않음, 미리보기용)
 *  TMDB 제목 검색만 (자막 검색 없음)
 */
export async function scanForLibrary(
  dirPath: string
): Promise<ActionResult<ImportedMovie[]>> {
  try {
    // UNC 경로 처리 (scan.ts와 동일)
    // Detect failed UNC path: C:\192.168.0.2\torrent (single backslash + IP pattern)
    if (/^[A-Z]:\\[\d.]+[\\\/]/.test(dirPath)) {
      dirPath = dirPath.replace(/^[A-Z]:\\/, "").replace(/\\/g, "/");
    }

    // Normalize UNC/SMB path — keep forward slashes for Node.js compatibility
    const isUnc = dirPath.startsWith("\\\\") || dirPath.startsWith("//");
    if (isUnc) {
      dirPath = dirPath.replace(/\\/g, "/");
      if (!dirPath.startsWith("//")) dirPath = "//" + dirPath.replace(/^\/+/, "");
    }

    await fs.access(dirPath);

    // 1. 재귀적으로 모든 비디오 파일 수집
    const videos = await collectVideosRecursive(dirPath, dirPath);
    console.log(`[scanForLibrary] ${dirPath} → ${videos.length}개 영상 발견`);

    // 2. 경량 스캔: 파일명 파싱만 수행 (TMDB API 호출 없음 - 즉시 완료)
    const results: ImportedMovie[] = [];

    for (const video of videos) {
      const parsed = parseFilename(video.folderName || video.fileName);

      // 자막 파일 검색 (로컬 파일시스템만)
      const subtitles = await findSubtitlesForVideo(video.fileName, [video.parentDir]);

      results.push({
        fileName: video.fileName,
        filePath: video.filePath,
        folderName: video.folderName,
        title: parsed.title,        // 파싱된 제목 (TMDB 조회 아님)
        year: parsed.year ? String(parsed.year) : "",
        tmdbId: undefined,         // TMDB 미조회
        posterPath: undefined,
        overview: undefined,
        releaseDate: undefined,
        subtitles,
      });
    }

    console.log(`[scanForLibrary] 완료: ${results.length}개 파일 (즉시)`);
    return { success: true, data: results };
  } catch (err) {
    const message = err instanceof Error ? err.message : "스캔 실패";
    return { success: false, error: message };
  }
}

/** 선택된 영화들을 라이브러리에 추가 */
export async function importToLibrary(
  items: ImportedMovie[]
): Promise<ActionResult<number>> {
  try {
    let count = 0;
    for (const item of items) {
      await db.insert(movies).values({
        id: uuid(),
        originalName: item.fileName,
        newName: item.fileName,
        filePath: item.filePath,
        tmdbId: item.tmdbId ?? null,
        title: item.title,
        releaseDate: item.releaseDate || null,
        posterPath: item.posterPath ?? null,
        overview: item.overview || null,
        genres: item.genres?.length ? JSON.stringify(item.genres) : null,
        director: item.director || null,
        writer: item.writer || item.writer_omdb || null,
        cast: item.cast?.length ? JSON.stringify(item.cast) : null,
        castProfiles: item.castProfiles?.length ? JSON.stringify(item.castProfiles) : null,
        rating: item.rating ? String(item.rating) : null,
        runtime: item.runtime ?? null,
        imdbId: item.imdbId || null,
        imdbRating: item.imdbRating || null,
        rottenTomatoes: item.rottenTomatoes || null,
        metacritic: item.metacritic || null,
        awards: item.awards || null,
        rated: item.rated || null,
        boxOffice: item.boxOffice || null,
        plotFull: item.plotFull || null,
        plotFullKo: item.plotFullKo || null,
        wikiSummary: item.wikiSummary || null,
        wikiOverview: item.wikiOverview || null,
        wikiUrl: item.wikiUrl || null,
        subtitleFiles: item.subtitles?.length ? JSON.stringify(item.subtitles) : null,
      });
      count++;
    }
    return { success: true, data: count };
  } catch (err) {
    const message = err instanceof Error ? err.message : "가져오기 실패";
    return { success: false, error: message };
  }
}

/** 선택되지 않은 영화를 nochoice 폴더로 이동 */
export async function moveUnselectedToNoChoice(
  scannedItems: ImportedMovie[],
  selectedIndices: number[]
): Promise<ActionResult<{ movedCount: number; movedFiles: string[]; failedFiles: string[] }>> {
  try {
    // 선택되지 않은 항목 찾기
    const unselected = scannedItems.filter((_, i) => !selectedIndices.includes(i));

    if (unselected.length === 0) {
      return { success: true, data: { movedCount: 0, movedFiles: [], failedFiles: [] } };
    }

    // 첫 번째 항목에서 부모 폴더 경로 추출
    const firstPath = unselected[0].filePath;
    const parentDir = path.dirname(firstPath);
    const noChoiceDir = path.join(parentDir, "nochoice");

    console.log(`[nochoice 이동] 부모 폴더: ${parentDir}, 대상: ${noChoiceDir}, 이동 대상: ${unselected.length}개`);

    // nochoice 폴더 생성
    await fs.mkdir(noChoiceDir, { recursive: true });

    const movedFiles: string[] = [];
    const failedFiles: string[] = [];

    for (const item of unselected) {
      try {
        const oldPath = item.filePath;
        const fileName = item.fileName;
        const newPath = path.join(noChoiceDir, fileName);

        console.log(`[이동] ${oldPath} → ${newPath}`);

        // 파일 이동
        await fs.rename(oldPath, newPath);
        movedFiles.push(fileName);
      } catch (moveErr) {
        console.error(`[이동 실패] ${item.fileName}:`, moveErr);
        failedFiles.push(item.fileName);
      }
    }

    console.log(`[nochoice 이동 완료] 성공: ${movedFiles.length}개, 실패: ${failedFiles.length}개`);

    return {
      success: true,
      data: { movedCount: movedFiles.length, movedFiles, failedFiles }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "이동 실패";
    return { success: false, error: message };
  }
}

/** 선택된 영화들을 풀 보강(TMDB+OMDb+Wiki+번역) + DB 저장 */
export async function enrichAndImportBatch(
  items: { fileName: string; filePath: string; folderName?: string; title: string; year?: string; tmdbId?: number; posterPath?: string | null; overview?: string; releaseDate?: string; subtitles: SubtitleInfo[] }[]
): Promise<ActionResult<{ imported: number; failed: number; movieIds: string[] }>> {
  try {
    let imported = 0;
    let failed = 0;
    const movieIds: string[] = [];

    const results = await Promise.allSettled(
      items.map(async (item) => {
        const data = await enrichMovieData(item.title, item.year);
        const movieId = uuid();
        await db.insert(movies).values({
          id: movieId,
          originalName: item.fileName,
          newName: item.fileName,
          filePath: item.filePath,
          tmdbId: data.tmdbId ?? null,
          title: data.title,
          releaseDate: data.releaseDate || null,
          posterPath: data.posterPath ?? null,
          overview: data.overview || null,
          genres: data.genres?.length ? JSON.stringify(data.genres) : null,
          director: data.director || null,
          writer: data.writer || data.writer_omdb || null,
          cast: data.cast?.length ? JSON.stringify(data.cast) : null,
          castProfiles: data.castProfiles?.length ? JSON.stringify(data.castProfiles) : null,
          rating: data.rating ? String(data.rating) : null,
          runtime: data.runtime ?? null,
          imdbId: data.imdbId || null,
          imdbRating: data.imdbRating || null,
          rottenTomatoes: data.rottenTomatoes || null,
          metacritic: data.metacritic || null,
          awards: data.awards || null,
          rated: data.rated || null,
          boxOffice: data.boxOffice || null,
          plotFull: data.plotFull || null,
          plotFullKo: data.plotFullKo || null,
          wikiSummary: data.wikiSummary || null,
          wikiOverview: data.wikiOverview || null,
          wikiUrl: data.wikiUrl || null,
          subtitleFiles: item.subtitles?.length ? JSON.stringify(item.subtitles) : null,
        });
        return movieId;
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        movieIds.push(r.value);
        imported++;
      } else {
        failed++;
      }
    }

    return { success: true, data: { imported, failed, movieIds } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "가져오기 실패";
    return { success: false, error: message };
  }
}

/** 라이브러리 영화의 폴더를 다른 위치로 이동 */
export async function moveMovieFolder(
  movieId: string,
  destinationDir: string
): Promise<ActionResult<string>> {
  try {
    const [movie] = await db.select().from(movies).where(eq(movies.id, movieId));
    if (!movie) return { success: false, error: "영화를 찾을 수 없습니다" };

    // 목적지 존재 확인
    await fs.access(destinationDir);
    const destStat = await fs.stat(destinationDir);
    if (!destStat.isDirectory()) return { success: false, error: "목적지가 디렉토리가 아닙니다" };

    const movieDir = path.dirname(movie.filePath);
    const movieFileName = path.basename(movie.filePath);

    // 폴더 단위 이동 (영화 파일의 부모 폴더)
    const folderName = path.basename(movieDir);
    const sourcePath = movieDir;
    let destPath = path.join(destinationDir, folderName);

    // 중복 처리
    let counter = 1;
    while (true) {
      try {
        await fs.access(destPath);
        destPath = path.join(destinationDir, `${folderName}_${counter}`);
        counter++;
      } catch {
        break;
      }
    }

    // 이동 시도 (같은 드라이브면 rename, 다르면 copy+delete)
    try {
      await fs.rename(sourcePath, destPath);
    } catch {
      // cross-device fallback: copy then delete
      const copyDir = async (src: string, dest: string) => {
        await fs.mkdir(dest, { recursive: true });
        const entries = await fs.readdir(src, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(src, entry.name);
          const dstPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            await copyDir(srcPath, dstPath);
          } else {
            await fs.copyFile(srcPath, dstPath);
          }
        }
      };
      await copyDir(sourcePath, destPath);
      await fs.rm(sourcePath, { recursive: true, force: true });
    }

    // DB 업데이트: filePath
    const newFilePath = path.join(destPath, movieFileName);
    await db.update(movies).set({ filePath: newFilePath }).where(eq(movies.id, movieId));

    // DB 업데이트: subtitleFiles 경로도 갱신
    if (movie.subtitleFiles) {
      try {
        const subs: { fileName: string; filePath: string; language: string; preview?: string }[] = JSON.parse(movie.subtitleFiles);
        const updatedSubs = subs.map((s) => ({
          ...s,
          filePath: path.join(destPath, s.fileName),
        }));
        await db.update(movies).set({
          subtitleFiles: JSON.stringify(updatedSubs),
        }).where(eq(movies.id, movieId));
      } catch { /* 자막 경로 업데이트 실패 시 무시 */ }
    }

    return { success: true, data: newFilePath };
  } catch (err) {
    const message = err instanceof Error ? err.message : "폴더 이동 실패";
    return { success: false, error: message };
  }
}

/** 라이브러리 영화의 자막 스캔 (기존 영화 재스캔) */
export async function scanSubtitles(): Promise<ActionResult<{ total: number; found: number }>> {
  try {
    const allMovies = await db.select().from(movies);
    let found = 0;

    for (const movie of allMovies) {
      try {
        const videoDir = path.dirname(movie.filePath);
        const parentDir = path.dirname(videoDir);
        // 자기 폴더 + 부모 폴더만 검색 (형제 폴더 검색 시 다른 영화 자막 교차 매칭 방지)
        const searchDirs = [videoDir, parentDir];

        const videoName = path.basename(movie.filePath);
        const subtitles = await findSubtitlesForVideo(videoName, searchDirs);

        // 항상 디스크 상태와 동기화 (자막이 삭제됐으면 DB에서도 제거)
        await db.update(movies).set({
          subtitleFiles: subtitles.length > 0 ? JSON.stringify(subtitles) : null,
        }).where(eq(movies.id, movie.id));
        if (subtitles.length > 0) found++;
      } catch { /* ignore individual failures */ }
    }

    return { success: true, data: { total: allMovies.length, found } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "자막 스캔 실패";
    return { success: false, error: message };
  }
}

/** 개별 자막 파일 삭제 */
export async function deleteSubtitleFile(
  movieId: string,
  subtitleFilePath: string,
  deleteFromDisk: boolean = false
): Promise<ActionResult> {
  try {
    const [movie] = await db.select().from(movies).where(eq(movies.id, movieId));
    if (!movie) return { success: false, error: "영화를 찾을 수 없습니다" };

    // 디스크에서도 삭제 (사용자 선택 시)
    if (deleteFromDisk) {
      try {
        await fs.access(subtitleFilePath);
        await fs.unlink(subtitleFilePath);
      } catch {
        // 파일이 이미 없으면 무시
      }
    }

    // DB에서 해당 자막 제거
    const existing: SubtitleInfo[] = movie.subtitleFiles
      ? JSON.parse(movie.subtitleFiles)
      : [];
    const updated = existing.filter(s => s.filePath !== subtitleFilePath);

    await db.update(movies).set({
      subtitleFiles: updated.length > 0 ? JSON.stringify(updated) : null,
    }).where(eq(movies.id, movieId));

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "자막 삭제 실패";
    return { success: false, error: message };
  }
}

/** 인터넷에서 자막 검색 */
export async function searchOnlineSubtitles(
  imdbId: string,
  languages?: string[]
): Promise<ActionResult<SubtitleResult[]>> {
  try {
    if (!imdbId) return { success: false, error: "IMDb ID가 없습니다" };
    const results = await searchSubtitles(imdbId, languages);
    return { success: true, data: results };
  } catch (err) {
    const message = err instanceof Error ? err.message : "자막 검색 실패";
    return { success: false, error: message };
  }
}

/** 자막 다운로드 + 영화 DB 업데이트 */
export async function downloadOnlineSubtitle(
  movieId: string,
  subtitle: SubtitleResult
): Promise<ActionResult<string>> {
  try {
    // 영화 정보 조회
    const [movie] = await db.select().from(movies).where(eq(movies.id, movieId));
    if (!movie) return { success: false, error: "영화를 찾을 수 없습니다" };

    const movieDir = path.dirname(movie.filePath);
    const downloadedPath = await downloadSubtitle(subtitle, movieDir);

    // 다운로드된 파일 분석
    const { language, preview } = await analyzeSubtitle(downloadedPath);

    // 영화 파일명 기반으로 자막 이름 변경
    const movieBase = path.basename(movie.filePath, path.extname(movie.filePath));
    const srtExt = path.extname(downloadedPath) || ".srt";
    const langSuffix = language === "en" ? "_Eng" : "";
    const newFileName = `${movieBase}${langSuffix}${srtExt}`;
    const newPath = path.join(movieDir, newFileName);

    // 동일 파일이 아니면 이름 변경
    let finalPath = downloadedPath;
    if (downloadedPath !== newPath) {
      let targetPath = newPath;
      // 이미 같은 이름 파일이 있으면 번호 붙이기
      let idx = 1;
      while (true) {
        try {
          await fs.access(targetPath);
          targetPath = path.join(movieDir, `${movieBase}${langSuffix}_${idx}${srtExt}`);
          idx++;
        } catch {
          break;
        }
      }
      await fs.rename(downloadedPath, targetPath);
      finalPath = targetPath;
    }

    // 기존 자막 목록에 추가
    const existing: SubtitleInfo[] = movie.subtitleFiles
      ? JSON.parse(movie.subtitleFiles)
      : [];

    existing.push({
      fileName: path.basename(finalPath),
      filePath: finalPath,
      language,
      preview,
    });

    await db.update(movies).set({
      subtitleFiles: JSON.stringify(existing),
    }).where(eq(movies.id, movieId));

    return { success: true, data: finalPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : "자막 다운로드 실패";
    return { success: false, error: message };
  }
}

/** 재탐색용 TMDB 복수 결과 검색 */
export async function searchMoviesForReidentify(
  query: string,
  year?: string
): Promise<ActionResult<MovieMetadata[]>> {
  try {
    const results = await searchMovieMultiple(query, year);
    return { success: true, data: results };
  } catch (err) {
    const message = err instanceof Error ? err.message : "검색 실패";
    return { success: false, error: message };
  }
}

/** 영화 재식별 — 선택된 tmdbId로 전체 데이터 재수집 */
export async function reidentifyMovie(
  movieId: string,
  tmdbId: number
): Promise<ActionResult> {
  try {
    // 1) TMDB 기본 정보 (detail API로 직접 가져오기)
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) return { success: false, error: "TMDB API 키가 없습니다" };

    const detailRes = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=ko-KR`,
      { headers: { Accept: "application/json" } }
    );
    if (!detailRes.ok) return { success: false, error: "TMDB 정보를 가져올 수 없습니다" };
    const tmdbData = await detailRes.json();

    // 2) TMDB 상세 (감독, 각본, 출연진+프로필, 장르, 런타임)
    const detail = await getMovieDetail(tmdbId);

    // 3) TMDB 트레일러 (YouTube)
    let trailerUrl: string | null = null;
    try {
      const videoRes = await fetch(
        `https://api.themoviedb.org/3/movie/${tmdbId}/videos?api_key=${apiKey}&language=ko-KR`,
        { headers: { Accept: "application/json" } }
      );
      if (videoRes.ok) {
        const videoData = await videoRes.json();
        const trailer = (videoData.results || []).find(
          (v: { type: string; site: string }) => v.type === "Trailer" && v.site === "YouTube"
        ) || (videoData.results || []).find(
          (v: { site: string }) => v.site === "YouTube"
        );
        if (trailer) {
          trailerUrl = `https://www.youtube.com/watch?v=${trailer.key}`;
        } else {
          // 한국어 없으면 영어 트레일러
          const enVideoRes = await fetch(
            `https://api.themoviedb.org/3/movie/${tmdbId}/videos?api_key=${apiKey}&language=en-US`,
            { headers: { Accept: "application/json" } }
          );
          if (enVideoRes.ok) {
            const enVideoData = await enVideoRes.json();
            const enTrailer = (enVideoData.results || []).find(
              (v: { type: string; site: string }) => v.type === "Trailer" && v.site === "YouTube"
            ) || (enVideoData.results || []).find(
              (v: { site: string }) => v.site === "YouTube"
            );
            if (enTrailer) trailerUrl = `https://www.youtube.com/watch?v=${enTrailer.key}`;
          }
        }
      }
    } catch { }

    // 4) IMDb ID → OMDb (평점, 각본, 등급, 박스오피스)
    const imdbId = await getImdbId(tmdbId);
    const omdb = imdbId ? await getOmdbData(imdbId) : null;

    // 5) 한국어 위키피디아
    const title = tmdbData.title || tmdbData.original_title || "";
    const year = tmdbData.release_date ? tmdbData.release_date.slice(0, 4) : undefined;
    const wiki = await getKoreanWikiSummary(title, year);

    // overview 우선순위: 위키 plot > summary > TMDB 상세 > TMDB 기본
    const overview = wiki?.plot || wiki?.summary || detail?.overview || tmdbData.overview || "";

    // OMDB 줄거리 한글 번역
    let plotFullKo: string | null = null;
    if (omdb?.plot) {
      try {
        const { translateToKorean } = await import("@/lib/translate");
        plotFullKo = await translateToKorean(omdb.plot);
      } catch { }
    }

    // writer 우선순위: TMDB 크레딧 > OMDb
    const writer = detail?.writer || omdb?.writer || null;

    // 6) 파일 리네임 + 자막 리네임 (독립적으로 처리)
    const [existing] = await db.select().from(movies).where(eq(movies.id, movieId));
    let newFilePath = existing?.filePath;
    let newOriginalName = existing?.originalName;
    let updatedSubtitleFiles = existing?.subtitleFiles || null;
    const safeTitle = sanitizeFilename(title);

    if (existing?.filePath && title && year) {
      const dir = path.dirname(existing.filePath);

      // 6-A) 영화 파일 리네임
      try {
        const oldFilePath = existing.filePath;
        const ext = getExtension(oldFilePath);
        const newName = `${safeTitle} (${year})${ext}`;
        const targetPath = path.join(dir, newName);

        if (oldFilePath !== targetPath) {
          // 대상 파일이 이미 존재하지 않는 경우에만 리네임
          let targetExists = false;
          try { await fs.access(targetPath); targetExists = true; } catch { }
          if (!targetExists) {
            await fs.rename(oldFilePath, targetPath);
            newFilePath = targetPath;
            newOriginalName = newName;
          }
        }
      } catch { }

      // 6-B) 자막 파일 리네임 — DB의 subtitleFiles 기록 기반 (영화 리네임과 독립)
      const renamedSubs: { fileName: string; filePath: string; language: string }[] = [];
      try {
        const existingSubs: { fileName: string; filePath: string; language: string }[] =
          existing.subtitleFiles ? JSON.parse(existing.subtitleFiles) : [];

        for (const sub of existingSubs) {
          const oldSubPath = sub.filePath;
          const subExt = path.extname(oldSubPath);
          const newSubName = `${safeTitle} (${year})${subExt}`;
          const newSubPath = path.join(dir, newSubName);

          if (oldSubPath === newSubPath) {
            // 이미 올바른 이름 — 그대로 유지
            renamedSubs.push({ fileName: newSubName, filePath: newSubPath, language: sub.language });
          } else {
            // 리네임 필요
            try {
              let oldExists = false;
              try { await fs.access(oldSubPath); oldExists = true; } catch { }
              if (oldExists) {
                let targetExists = false;
                try { await fs.access(newSubPath); targetExists = true; } catch { }
                if (!targetExists) {
                  await fs.rename(oldSubPath, newSubPath);
                }
                renamedSubs.push({ fileName: newSubName, filePath: newSubPath, language: sub.language });
              } else {
                // 원본 파일이 없으면 스킵
              }
            } catch { }
          }
        }
      } catch { }

      // 6-C) 디렉토리 스캔으로 추가 자막 파일 찾기 (DB에 없는 것들)
      // 기존 영화 파일명과 매칭되는 자막만 처리 (관련 없는 자막 리네임 방지)
      try {
        const dirEntries = await fs.readdir(dir);
        const alreadyHandled = new Set(renamedSubs.map(s => s.filePath));
        const langMap: Record<string, string> = { ko: "ko", kor: "ko", korean: "ko", en: "en", eng: "en", english: "en" };
        // 기존 영화 파일명 (확장자 제거, 소문자)
        const oldVideoBase = existing?.filePath
          ? path.basename(existing.filePath, path.extname(existing.filePath)).toLowerCase()
          : "";

        for (const entry of dirEntries) {
          if (!/\.(srt|vtt|ass|sub|ssa)$/i.test(entry)) continue;
          const entryPath = path.join(dir, entry);
          if (alreadyHandled.has(entryPath)) continue;

          // 새 이름으로 시작하는 자막은 이미 올바름
          if (entry.startsWith(`${safeTitle} (${year})`)) {
            const subExt = path.extname(entry);
            renamedSubs.push({
              fileName: entry,
              filePath: entryPath,
              language: langMap[entry.slice(`${safeTitle} (${year})`.length, -subExt.length).replace(/^\./, "").toLowerCase()] || "und",
            });
            continue;
          }

          // 기존 영화 파일명과 매칭되는 자막만 리네임 (접두사 매칭)
          const entryBase = path.basename(entry, path.extname(entry)).toLowerCase();
          if (oldVideoBase && !entryBase.startsWith(oldVideoBase)) continue;

          // 이전 이름의 자막 파일 발견 → 리네임
          const subExt = path.extname(entry);
          const baseName = path.basename(entry, subExt);
          // suffix 추출: 파일명에서 마지막 괄호 뒤 부분 (e.g. ".ko" from "틴에이지 크라켄 루비 (2023).ko")
          const suffixMatch = baseName.match(/\)(.*)$/);
          const suffix = suffixMatch ? suffixMatch[1] : "";
          const newSubName = `${safeTitle} (${year})${suffix}${subExt}`;
          const newSubPath = path.join(dir, newSubName);

          try {
            let targetExists = false;
            try { await fs.access(newSubPath); targetExists = true; } catch { }
            if (!targetExists) {
              await fs.rename(entryPath, newSubPath);
            }
            const lang = suffix.replace(/^\./, "").toLowerCase();
            renamedSubs.push({
              fileName: newSubName,
              filePath: newSubPath,
              language: langMap[lang] || lang || "und",
            });
          } catch { }
        }
      } catch { }

      if (renamedSubs.length > 0) {
        updatedSubtitleFiles = JSON.stringify(renamedSubs);
      } else {
        updatedSubtitleFiles = null;
      }
    }

    // 7) DB 업데이트 — 모든 필드를 초기화하고 새 데이터로 덮어쓰기
    await db
      .update(movies)
      .set({
        // 핵심 식별 정보
        tmdbId,
        title,
        newName: newOriginalName || existing?.newName || title,
        filePath: newFilePath,
        originalName: newOriginalName,
        // TMDB 기본 정보
        posterPath: tmdbData.poster_path || null,
        backdropPath: tmdbData.backdrop_path || null,
        overview,
        releaseDate: tmdbData.release_date || null,
        tagline: tmdbData.tagline || null,
        budget: tmdbData.budget || null,
        revenue: tmdbData.revenue || null,
        productionCountries: tmdbData.production_countries
          ? JSON.stringify(tmdbData.production_countries.map((c: { name: string }) => c.name))
          : null,
        // TMDB 상세 (크레딧)
        genres: detail?.genres?.length ? JSON.stringify(detail.genres) : null,
        director: detail?.director || null,
        writer: writer,
        cast: detail?.cast?.length ? JSON.stringify(detail.cast) : null,
        castProfiles: detail?.castProfiles?.length ? JSON.stringify(detail.castProfiles) : null,
        rating: detail?.rating ? String(detail.rating) : null,
        runtime: detail?.runtime ?? null,
        // 트레일러
        trailerUrl,
        // OMDb 데이터
        imdbId: omdb?.imdbId || imdbId || null,
        imdbRating: omdb?.imdbRating || null,
        rottenTomatoes: omdb?.rottenTomatoes || null,
        metacritic: omdb?.metacritic || null,
        awards: omdb?.awards || null,
        rated: omdb?.rated || null,
        plotFull: omdb?.plot || null,
        plotFullKo: plotFullKo || null,
        boxOffice: omdb?.boxOffice || null,
        // 위키피디아
        wikiSummary: wiki?.plot || wiki?.summary || null,
        wikiOverview: wiki?.summary || null,
        wikiUrl: wiki?.url || null,
        // 자막 파일 (리네임된 경우 업데이트)
        subtitleFiles: updatedSubtitleFiles,
      })
      .where(eq(movies.id, movieId));

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "재식별 실패";
    return { success: false, error: message };
  }
}

/** 개별 영화 자막 동기화 (디스크 ↔ DB) */
export async function scanSubtitlesSingle(
  movieId: string
): Promise<ActionResult<{ found: number }>> {
  try {
    const [movie] = await db.select().from(movies).where(eq(movies.id, movieId));
    if (!movie) return { success: false, error: "영화를 찾을 수 없습니다" };

    const videoDir = path.dirname(movie.filePath);
    const parentDir = path.dirname(videoDir);
    // 자기 폴더 + 부모 폴더만 검색 (형제 폴더 검색 시 다른 영화 자막 교차 매칭 방지)
    const searchDirs = [videoDir, parentDir];

    const videoName = path.basename(movie.filePath);
    const subtitles = await findSubtitlesForVideo(videoName, searchDirs);

    await db.update(movies).set({
      subtitleFiles: subtitles.length > 0 ? JSON.stringify(subtitles) : null,
    }).where(eq(movies.id, movie.id));

    return { success: true, data: { found: subtitles.length } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "자막 동기화 실패";
    return { success: false, error: message };
  }
}

/** 번역 페이지용 영화 + 영어 자막 조회 (SRT 실패해도 영화 데이터는 반환) */
export async function getMovieForTranslation(
  movieId: string
): Promise<ActionResult<{ movie: Movie; srtContent: string | null; srtFileName: string | null; srtError?: string }>> {
  try {
    const [movie] = await db.select().from(movies).where(eq(movies.id, movieId));
    if (!movie) return { success: false, error: "영화를 찾을 수 없습니다" };

    // subtitleFiles JSON 파싱 → 영어(en) 또는 미지정 자막 찾기
    const subs: SubtitleInfo[] = movie.subtitleFiles
      ? JSON.parse(movie.subtitleFiles)
      : [];

    const englishSub = subs.find(
      (s) => s.language === "en" || s.language === "unknown"
    );

    if (!englishSub) {
      // 영어 자막 없어도 영화 데이터는 반환
      return {
        success: true,
        data: { movie, srtContent: null, srtFileName: null, srtError: "영어 자막 파일이 없습니다" },
      };
    }

    // SRT 파일 읽기 시도
    try {
      const srtContent = await fs.readFile(englishSub.filePath, "utf-8");
      return {
        success: true,
        data: { movie, srtContent, srtFileName: englishSub.fileName },
      };
    } catch (readErr) {
      // 파일 읽기 실패해도 영화 데이터는 반환
      const readMsg = readErr instanceof Error ? readErr.message : "파일 읽기 실패";
      return {
        success: true,
        data: { movie, srtContent: null, srtFileName: null, srtError: readMsg },
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "번역용 데이터 조회 실패";
    return { success: false, error: message };
  }
}

/** 번역된 SRT를 원본 영화와 같은 폴더에 저장 */
export async function exportSrtToFile(
  movieFilePath: string,
  movieTitle: string,
  srtContent: string
): Promise<ActionResult<{ savedPath: string }>> {
  try {
    const dir = path.dirname(movieFilePath);
    // 파일명에 사용 불가 문자 제거
    const safeName = movieTitle.replace(/[<>:"/\\|?*]/g, "").trim();
    const fileName = `${safeName}.ko.srt`;
    const savePath = path.join(dir, fileName);

    await fs.writeFile(savePath, srtContent, "utf-8");
    return { success: true, data: { savedPath: savePath } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "SRT 파일 저장 실패";
    return { success: false, error: message };
  }
}

/** 자막 파일 전체 내용 읽기 */
export async function readSubtitleFile(filePath: string): Promise<ActionResult<string>> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return { success: true, data: content };
  } catch (err) {
    const message = err instanceof Error ? err.message : "자막 파일 읽기 실패";
    return { success: false, error: message };
  }
}

/** 개별 영화 OMDB + Wikipedia 보강 + 줄거리 한글 번역 (핵심 로직) */
async function enrichMovieSingle(movie: Movie): Promise<boolean> {
  const currentPlotLen = (movie.plotFull || "").length;
  const needsPlotEnrich = !movie.plotFull || currentPlotLen < 1500;
  const needsKoTranslation = !movie.plotFullKo || (movie.plotFullKo.length < 200 && needsPlotEnrich);

  const needsWikiOverview = !movie.wikiOverview || (movie.wikiOverview.length < 200);

  // plotFullKo가 없으면 항상 번역 필요
  const needsTranslation = !movie.plotFullKo;

  // 이미 모든 데이터가 충분하면 스킵 (단, plotFullKo가 있으면)
  if (movie.imdbRating && !needsPlotEnrich && !needsTranslation && !needsWikiOverview) return false;

  let omdbData = null;
  let koWiki = null;
  let enWiki = null;

  // OMDB 데이터 + Wikipedia 데이터 병렬 조회
  const year = movie.releaseDate?.slice(0, 4);

  // OMDB 데이터 가져오기 (Promise 준비)
  const omdbPromise = (async () => {
    if (!movie.imdbRating && needsPlotEnrich) {
      // 1차: tmdbId가 있으면 IMDb ID 경유
      if (movie.tmdbId) {
        const imdbId = movie.imdbId || (await getImdbId(movie.tmdbId));
        if (imdbId) {
          return await getOmdbData(imdbId);
        }
      }
      // 2차: title로 직접 검색
      const { searchOmdb } = await import("@/lib/omdb");
      return await searchOmdb(movie.title, year);
    }
    return null;
  })();

  // Wikipedia 데이터 가져오기 (Promise 준비)
  const wikiPromise = (async () => {
    try {
      const engTitle = movie.title;
      console.log(`[ENRICH] Wikipedia search — title="${engTitle}", year="${year}"`);

      // 한국어 + 영어 위키피디아 병렬 검색
      const [ko, en] = await Promise.all([
        getKoreanWikiSummary(movie.title, year),
        getEnglishWikiSummary(engTitle, year),
      ]);
      return { ko, en };
    } catch (wikiErr) {
      console.error(`[ENRICH] Wikipedia error:`, wikiErr);
      return { ko: null, en: null };
    }
  })();

  // OMDB와 Wikipedia 병렬 완료 대기
  [omdbData, { ko: koWiki, en: enWiki }] = await Promise.all([omdbPromise, wikiPromise]);

  let bestPlot = omdbData?.plot || movie.plotFull || "";

  // Wikipedia에서 더 긴 줄거리 + Summary 가져오기
  let wikiSummaryToSave: string | null = null;
  let wikiOverviewToSave: string | null = null;
  console.log(`[ENRICH] bestPlot=${bestPlot.length}chars, wikiSummary=${movie.wikiSummary ? 'exists' : 'null'}, needsWikiOverview=${needsWikiOverview}`);
  if (bestPlot.length < 1500 || !movie.wikiSummary || needsWikiOverview) {
    console.log(`[ENRICH] EN Wiki — plot=${enWiki?.plot?.length || 0}chars, summary=${enWiki?.summary?.length || 0}chars`);
    console.log(`[ENRICH] KO Wiki — plot=${koWiki?.plot?.length || 0}chars, summary=${koWiki?.summary?.length || 0}chars`);

    // Plot 우선순위: 영어 위키 > 한국어 위키
    if (enWiki?.plot && enWiki.plot.length > bestPlot.length) {
      bestPlot = enWiki.plot;
      console.log(`[ENRICH] Using EN Wiki plot (${bestPlot.length} chars)`);
    }
    if (koWiki?.plot && koWiki.plot.length > bestPlot.length) {
      bestPlot = koWiki.plot;
      console.log(`[ENRICH] Using KO Wiki plot (${bestPlot.length} chars)`);
    }

    // wikiSummary: 가장 긴 Plot 또는 Summary
    if (enWiki?.plot && enWiki.plot.length > 50) {
      wikiSummaryToSave = enWiki.plot;
    } else if (koWiki?.plot && koWiki.plot.length > 50) {
      wikiSummaryToSave = koWiki.plot;
    } else if (koWiki?.summary && koWiki.summary.length > 50) {
      wikiSummaryToSave = koWiki.summary;
    } else if (enWiki?.summary && enWiki.summary.length > 50) {
      wikiSummaryToSave = enWiki.summary;
    }

    // wikiOverview: Summary API (영어 우선, 더 상세)
    if (enWiki?.summary && enWiki.summary.length > (koWiki?.summary?.length || 0)) {
      wikiOverviewToSave = enWiki.summary;
    } else if (koWiki?.summary && koWiki.summary.length > 50) {
      wikiOverviewToSave = koWiki.summary;
    } else if (enWiki?.summary && enWiki.summary.length > 50) {
      wikiOverviewToSave = enWiki.summary;
    }
  }

  // OMDB 데이터 먼저 저장 (번역 실패해도 데이터는 보존)
  const updates: Record<string, unknown> = {};
  if (omdbData?.imdbId && !movie.imdbId) updates.imdbId = omdbData.imdbId;
  if (omdbData?.imdbRating && !movie.imdbRating) updates.imdbRating = omdbData.imdbRating;
  if (omdbData?.rottenTomatoes && !movie.rottenTomatoes) updates.rottenTomatoes = omdbData.rottenTomatoes;
  if (omdbData?.metacritic && !movie.metacritic) updates.metacritic = omdbData.metacritic;
  if (omdbData?.awards && !movie.awards) updates.awards = omdbData.awards;

  // 더 긴 줄거리로 업데이트
  if (bestPlot && bestPlot.length > currentPlotLen) {
    updates.plotFull = bestPlot;
  }

  // 한국어 위키 줄거리 저장
  if (wikiSummaryToSave && (!movie.wikiSummary || wikiSummaryToSave.length > (movie.wikiSummary?.length || 0))) {
    updates.wikiSummary = wikiSummaryToSave;
  }
  // 번역 작업 병렬 처리 (wikiOverview 번역 + 줄거리 한글 번역)
  const plotToTranslate = (updates.plotFull as string) || movie.plotFull;
  const needsPlotTranslate = plotToTranslate && (plotToTranslate.match(/[가-힣]/g) || []).length < 5 && (needsKoTranslation || updates.plotFull);
  const needsOverviewTranslate = wikiOverviewToSave
    && (wikiOverviewToSave.match(/[가-힣]/g) || []).length < 5;

  if (needsPlotTranslate || needsOverviewTranslate) {
    try {
      const { translateToKorean } = await import("@/lib/translate");
      // 줄거리 + 개요 병렬 번역
      const [plotKo, overviewKo] = await Promise.all([
        needsPlotTranslate ? translateToKorean(plotToTranslate!).catch(() => null) : Promise.resolve(null),
        needsOverviewTranslate ? translateToKorean(wikiOverviewToSave!).catch(() => null) : Promise.resolve(null),
      ]);

      if (plotKo && plotKo !== plotToTranslate) {
        updates.plotFullKo = plotKo;
      }
      if (overviewKo && overviewKo !== wikiOverviewToSave) {
        wikiOverviewToSave = overviewKo;
      }
      // 번역 실패 시 한국어 위키 줄거리 있으면 사용
      if (!updates.plotFullKo && wikiSummaryToSave && wikiSummaryToSave.length > 100) {
        updates.plotFullKo = wikiSummaryToSave;
      }
    } catch {
      // 번역 실패해도 나머지 데이터는 저장
    }
  }

  // 위키 개요(Summary) 저장 (번역 후)
  if (wikiOverviewToSave && (!movie.wikiOverview || wikiOverviewToSave.length > (movie.wikiOverview?.length || 0))) {
    updates.wikiOverview = wikiOverviewToSave;
  }

  // plotFullKo만缺失해도 반드시 저장 (다른 데이터가 최신이여도)
  if (!updates.plotFullKo && needsKoTranslation && plotToTranslate) {
    updates.plotFullKo = plotToTranslate; // 번역 실패 시 원문 저장
  }

  if (Object.keys(updates).length === 0) return false;

  await db.update(movies).set(updates).where(eq(movies.id, movie.id));
  return true;
}

/** 개별 영화 보강 (상세 다이얼로그에서 호출) */
export async function enrichMovie(movieId: string): Promise<ActionResult<{ title: string }>> {
  try {
    const [movie] = await db.select().from(movies).where(eq(movies.id, movieId));
    if (!movie) return { success: false, error: "영화를 찾을 수 없습니다" };

    const updated = await enrichMovieSingle(movie);
    if (updated) {
      return { success: true, data: { title: movie.title } };
    }
    return { success: true, error: "이미 모든 데이터가 보강되어 있습니다", data: { title: movie.title } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "보강 실패";
    return { success: false, error: message };
  }
}

/** 한글 번역 초기화 후 재보강 (plotFullKo가 없거나 잘못된 경우 강제 재실행) */
export async function resetAndEnrichMovie(movieId: string): Promise<ActionResult<{ title: string }>> {
  try {
    const [movie] = await db.select().from(movies).where(eq(movies.id, movieId));
    if (!movie) return { success: false, error: "영화를 찾을 수 없습니다" };

    // plotFullKo + wikiOverview 초기화 → 줄거리 한글 번역 + Summary 재번역 모두 강제 실행
    await db.update(movies).set({ plotFullKo: null, wikiOverview: null }).where(eq(movies.id, movieId));

    // 초기화된 movie 객체로 재보강
    const resetMovie = { ...movie, plotFullKo: null, wikiOverview: null };
    const updated = await enrichMovieSingle(resetMovie as typeof movie);
    if (updated) {
      return { success: true, data: { title: movie.title } };
    }
    return { success: false, error: "재보강 실패 — 줄거리 원문이 없을 수 있습니다" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "재보강 실패";
    return { success: false, error: message };
  }
}

/** 보강 대상 영화 ID 목록 반환 (실시간 진행률 UI용) */
export async function getEnrichTargets(): Promise<ActionResult<{ ids: string[]; total: number }>> {
  try {
    const allMovies = await db.select().from(movies);
    // plotFull이 1500자 미만이거나, plotFullKo가 없거나, imdbRating이 없거나, wikiOverview가 짧은 영화
    const targets = allMovies.filter((m) => {
      const plotLen = (m.plotFull || "").length;
      const overviewLen = (m.wikiOverview || "").length;
      return !m.imdbRating || !m.plotFull || plotLen < 1500 || !m.plotFullKo || overviewLen < 200;
    });
    return { success: true, data: { ids: targets.map((m) => m.id), total: allMovies.length } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "대상 조회 실패";
    return { success: false, error: message };
  }
}

/** 라이브러리 전체 보강 (누락 항목만) — 레거시 호환용 */
export async function enrichLibrary(): Promise<ActionResult<{ total: number; enriched: number }>> {
  try {
    const targets = await db
      .select()
      .from(movies)
      .where(or(isNull(movies.imdbRating), isNull(movies.plotFull), isNull(movies.plotFullKo)));

    let enriched = 0;

    for (const movie of targets) {
      try {
        const updated = await enrichMovieSingle(movie);
        if (updated) enriched++;
      } catch {
        // 개별 실패 시 다음 영화로 계속
      }
    }

    return { success: true, data: { total: targets.length, enriched } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "보강 실패";
    return { success: false, error: message };
  }
}

/* ─── Library Source Tracking (스캔 폴더 기억) ─── */

const LIBRARY_SOURCES_PATH = path.join(process.cwd(), ".library-sources.json");

async function getLibrarySources(): Promise<string[]> {
  try {
    const content = await fs.readFile(LIBRARY_SOURCES_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function saveLibrarySources(sources: string[]): Promise<void> {
  const unique = [...new Set(sources)];
  await fs.writeFile(LIBRARY_SOURCES_PATH, JSON.stringify(unique, null, 2), "utf-8");
}

/** 라이브러리 소스 폴더 등록 (임포트 시 자동 호출) */
export async function addLibrarySource(dirPath: string): Promise<void> {
  const sources = await getLibrarySources();
  if (!sources.includes(dirPath)) {
    sources.push(dirPath);
    await saveLibrarySources(sources);
  }
}

/** 등록된 라이브러리 소스 폴더 목록 조회 */
export async function getLibrarySourcesList(): Promise<string[]> {
  return getLibrarySources();
}

/** 라이브러리 소스 폴더 삭제 */
export async function removeLibrarySource(dirPath: string): Promise<void> {
  const sources = await getLibrarySources();
  const filtered = sources.filter((s) => s !== dirPath);
  await saveLibrarySources(filtered);
}

/** 등록된 소스 폴더에서 새 영화만 감지 (파일시스템만, API 호출 없음) — 재귀 탐색 */
export async function detectNewMoviesInLibrary(): Promise<ActionResult<ImportedMovie[]>> {
  try {
    const sources = await getLibrarySources();
    if (sources.length === 0) return { success: true, data: [] };

    const allMovies = await db.select().from(movies);
    const existingPaths = new Set(
      allMovies.map((m) => m.filePath.replace(/\\/g, "/"))
    );

    const newItems: ImportedMovie[] = [];
    const seenPaths = new Set<string>();

    for (let source of sources) {
      try {
        // UNC 경로 처리
        if (/^[A-Z]:\\[\d.]+[\\\/]/.test(source)) {
          source = source.replace(/^[A-Z]:\\/, "").replace(/\\/g, "/");
        }
        if (source.startsWith("\\\\") || source.startsWith("//")) {
          source = source.replace(/\\/g, "/");
          if (!source.startsWith("//")) source = "//" + source.replace(/^\/+/, "");
        }

        await fs.access(source);

        // 재귀적으로 모든 비디오 파일 수집
        const videos = await collectVideosRecursive(source, source);

        for (const video of videos) {
          const normalized = video.filePath.replace(/\\/g, "/");
          if (existingPaths.has(normalized) || seenPaths.has(normalized)) continue;

          const parsed = parseFilename(video.folderName || video.fileName);
          const subtitles = await findSubtitlesForVideo(video.fileName, [video.parentDir]);
          seenPaths.add(normalized);
          newItems.push({
            fileName: video.fileName,
            filePath: video.filePath,
            folderName: video.folderName,
            title: parsed.title,
            year: parsed.year ? String(parsed.year) : "",
            subtitles,
          });
        }
      } catch {
        // skip inaccessible source
      }
    }

    return { success: true, data: newItems };
  } catch (err) {
    const message = err instanceof Error ? err.message : "새 영화 감지 실패";
    return { success: false, error: message };
  }
}

/** 신규 파일 정보 (빌드 호환용) */
export interface NewFileInfo {
  fileName: string;
  filePath: string;
  folderName?: string;
  sourceDir?: string;
}

/** 신규 파일 감지 (빌드 호환용) */
export async function detectNewFiles(): Promise<ActionResult<NewFileInfo[]>> {
  return { success: true, data: [] };
}

/** 신규 파일 보강 및 임포트 (빌드 호환용) */
export async function enrichAndImportNewFile(file: any): Promise<ActionResult<void>> {
  return { success: true };
}
