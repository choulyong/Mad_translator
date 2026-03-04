import type { MovieMetadata } from "@/lib/types";

const BASE_URL = "https://api.themoviedb.org/3";

interface TmdbSearchResult {
  id: number;
  title: string;
  original_title: string;
  release_date: string;
  poster_path: string | null;
  overview: string;
}

interface TmdbSearchResponse {
  results: TmdbSearchResult[];
}

async function searchTmdb(
  query: string,
  year: string | undefined,
  language: string
): Promise<TmdbSearchResult | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  const params = new URLSearchParams({
    api_key: apiKey,
    query,
    language,
  });
  if (year) {
    params.set("year", year);
  }

  const res = await fetch(`${BASE_URL}/search/movie?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) return null;

  const data: TmdbSearchResponse = await res.json();
  return data.results.length > 0 ? data.results[0] : null;
}

async function searchTmdbMultiple(
  query: string,
  year: string | undefined,
  language: string
): Promise<TmdbSearchResult[]> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return [];

  const params = new URLSearchParams({
    api_key: apiKey,
    query,
    language,
  });
  if (year) {
    params.set("year", year);
  }

  const res = await fetch(`${BASE_URL}/search/movie?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) return [];

  const data: TmdbSearchResponse = await res.json();
  return data.results || [];
}

/** TMDB 복수 결과 검색 (재탐색용) — 최대 10개 */
export async function searchMovieMultiple(
  query: string,
  year?: string
): Promise<MovieMetadata[]> {
  // 한국어 검색
  const koResults = await searchTmdbMultiple(query, year, "ko-KR");
  // 영어 검색
  const enResults = await searchTmdbMultiple(query, year, "en-US");

  // 병합 + 중복 제거 (tmdbId 기준)
  const seen = new Set<number>();
  const merged: TmdbSearchResult[] = [];
  for (const r of [...koResults, ...enResults]) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      merged.push(r);
    }
  }

  // 최대 10개
  return merged.slice(0, 10).map((r) => ({
    tmdbId: r.id,
    title: r.title,
    originalTitle: r.original_title,
    year: r.release_date ? r.release_date.slice(0, 4) : "",
    releaseDate: r.release_date || "",
    posterPath: r.poster_path,
    overview: r.overview || "",
  }));
}

export async function searchMovie(
  query: string,
  year?: string
): Promise<MovieMetadata | null> {
  // First try Korean
  let result = await searchTmdb(query, year, "ko-KR");

  // Fallback to English
  if (!result) {
    result = await searchTmdb(query, year, "en-US");
  }

  if (!result) return null;

  return {
    tmdbId: result.id,
    title: result.title,
    originalTitle: result.original_title,
    year: result.release_date ? result.release_date.slice(0, 4) : "",
    releaseDate: result.release_date || "",
    posterPath: result.poster_path,
    overview: result.overview || "",
  };
}

/** TMDB 영화 상세 + 출연진/감독 정보 */
export interface TmdbMovieDetail {
  genres: string[];
  director: string;
  writer: string;
  cast: string[];
  castProfiles: { name: string; character: string; profilePath: string | null }[];
  rating: number;
  runtime: number | null;
  overview: string;
}

export async function getMovieDetail(tmdbId: number): Promise<TmdbMovieDetail | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  try {
    // Fetch movie details (ko-KR first for Korean genre names)
    const detailParams = new URLSearchParams({
      api_key: apiKey,
      language: "ko-KR",
    });
    const detailRes = await fetch(
      `${BASE_URL}/movie/${tmdbId}?${detailParams.toString()}`,
      { headers: { Accept: "application/json" } }
    );
    if (!detailRes.ok) return null;
    const detail = await detailRes.json();

    // Fetch credits
    const creditParams = new URLSearchParams({ api_key: apiKey });
    const creditRes = await fetch(
      `${BASE_URL}/movie/${tmdbId}/credits?${creditParams.toString()}`,
      { headers: { Accept: "application/json" } }
    );
    if (!creditRes.ok) return null;
    const credits = await creditRes.json();

    // Extract director from crew
    const director =
      credits.crew?.find(
        (c: { job: string; name: string }) => c.job === "Director"
      )?.name || "";

    // Extract writer/screenplay from crew
    const writers: string[] = (credits.crew || [])
      .filter((c: { job: string; department: string }) =>
        c.job === "Screenplay" || c.job === "Writer" || c.job === "Story"
      )
      .slice(0, 5)
      .map((c: { name: string }) => c.name);
    const writer = [...new Set(writers)].join(", ");

    // Extract top 10 cast members (names only)
    const cast: string[] = (credits.cast || [])
      .slice(0, 10)
      .map((c: { name: string }) => c.name);

    // Extract top 10 cast with profiles (name, character, photo)
    const castProfiles = (credits.cast || [])
      .slice(0, 10)
      .map((c: { name: string; character: string; profile_path: string | null }) => ({
        name: c.name,
        character: c.character || "",
        profilePath: c.profile_path || null,
      }));

    // Extract genres
    const genres: string[] = (detail.genres || []).map(
      (g: { name: string }) => g.name
    );

    // Overview — use Korean if available, fallback to English
    let overview = detail.overview || "";
    if (!overview) {
      const enParams = new URLSearchParams({
        api_key: apiKey,
        language: "en-US",
      });
      const enRes = await fetch(
        `${BASE_URL}/movie/${tmdbId}?${enParams.toString()}`,
        { headers: { Accept: "application/json" } }
      );
      if (enRes.ok) {
        const enDetail = await enRes.json();
        overview = enDetail.overview || "";
      }
    }

    return {
      genres,
      director,
      writer,
      cast,
      castProfiles,
      rating: detail.vote_average || 0,
      runtime: detail.runtime || null,
      overview,
    };
  } catch (err) {
    console.error("[TMDB] getMovieDetail error:", err);
    return null;
  }
}

/** TMDB → IMDb ID 가져오기 (OMDb 연동용) */
export async function getImdbId(tmdbId: number): Promise<string | null> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return null;

  try {
    const params = new URLSearchParams({ api_key: apiKey });
    const res = await fetch(
      `${BASE_URL}/movie/${tmdbId}/external_ids?${params.toString()}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.imdb_id || null;
  } catch {
    return null;
  }
}
