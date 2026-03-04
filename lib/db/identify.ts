"use server";

import type { ActionResult, MovieMetadata } from "@/lib/types";
import { parseFilename } from "@/lib/parser";
import { searchMovie } from "@/lib/tmdb";
import { getImdbId } from "@/lib/tmdb";
import { getOmdbData, searchOmdb } from "@/lib/omdb";
import { translateToKorean } from "@/lib/translate";

export async function identifyMovie(
  filename: string
): Promise<ActionResult<MovieMetadata>> {
  try {
    const parsed = parseFilename(filename);
    const yearStr = parsed.year ? String(parsed.year) : undefined;

    // 1차: TMDB 검색
    let metadata = await searchMovie(parsed.title, yearStr);

    if (metadata) {
      // TMDB 성공 → OMDB로 평점 보강
      const imdbId = await getImdbId(metadata.tmdbId);
      if (imdbId) {
        const omdb = await getOmdbData(imdbId);
        if (omdb) {
          metadata.imdbId = omdb.imdbId;
          metadata.imdbRating = omdb.imdbRating;
          metadata.rottenTomatoes = omdb.rottenTomatoes;
          metadata.metacritic = omdb.metacritic;
        }
      }

      // If overview is in English, translate to Korean
      if (metadata.overview && !/[가-힣]/.test(metadata.overview)) {
        const translated = await translateToKorean(metadata.overview);
        if (translated) metadata.overview = translated;
      }

      return { success: true, data: metadata };
    }

    // 2차: TMDB 실패 → OMDB 폴백 검색
    const omdbResult = await searchOmdb(parsed.title, yearStr);
    if (omdbResult) {
      const fallbackMetadata: MovieMetadata = {
        tmdbId: 0,
        title: parsed.title,
        originalTitle: parsed.title,
        year: yearStr || "",
        releaseDate: "",
        posterPath: null,
        overview: omdbResult.plot || "",
        imdbId: omdbResult.imdbId,
        imdbRating: omdbResult.imdbRating,
        rottenTomatoes: omdbResult.rottenTomatoes,
        metacritic: omdbResult.metacritic,
      };

      return { success: true, data: fallbackMetadata };
    }

    return { success: false, error: `Could not identify: ${parsed.title}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Identification failed";
    return { success: false, error: message };
  }
}
