import Database from "better-sqlite3";

const db = new Database("local.db");
const TMDB_KEY = "c34f1455daa668c1f65229691e1cab5a";
const OMDB_KEY = "f01bb28";

// 포스터, 장르, 감독, 출연진, 줄거리 등이 부실한 영화들
const targets = db.prepare(
  "SELECT id, title, tmdb_id, imdb_id, poster_path, overview, genres, director, \"cast\", release_date, rating, runtime FROM movies WHERE poster_path IS NULL OR overview IS NULL OR genres IS NULL OR director IS NULL"
).all();

console.log(`보강 대상: ${targets.length}개\n`);

let enriched = 0;

for (const movie of targets) {
  console.log(`--- ${movie.title} ---`);
  const updates = {};

  try {
    // 1) TMDB ID가 없으면 TMDB 검색으로 찾기
    let tmdbId = movie.tmdb_id;
    if (!tmdbId) {
      const year = movie.release_date?.slice(0, 4);
      // 한국어로 먼저
      let searchRes = await fetch(
        `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(movie.title)}&language=ko-KR${year ? `&year=${year}` : ""}`
      );
      let searchData = await searchRes.json();

      if (!searchData.results?.length) {
        // 영어로 재시도
        searchRes = await fetch(
          `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(movie.title)}&language=en-US${year ? `&year=${year}` : ""}`
        );
        searchData = await searchRes.json();
      }

      // IMDb ID로 TMDB find 시도
      if (!searchData.results?.length && movie.imdb_id) {
        const findRes = await fetch(
          `https://api.themoviedb.org/3/find/${movie.imdb_id}?api_key=${TMDB_KEY}&external_source=imdb_id`
        );
        const findData = await findRes.json();
        if (findData.movie_results?.length) {
          tmdbId = findData.movie_results[0].id;
          console.log(`  TMDB find by IMDb ID: ${tmdbId}`);
        }
      }

      if (searchData.results?.length) {
        tmdbId = searchData.results[0].id;
        console.log(`  TMDB search found: ${tmdbId}`);
      }

      if (tmdbId) updates.tmdb_id = tmdbId;
    }

    // 2) TMDB 상세 정보 가져오기
    if (tmdbId) {
      // 한국어 상세
      const detailRes = await fetch(
        `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}&language=ko-KR`
      );
      const detail = await detailRes.json();

      // 영어 상세 (overview fallback)
      const enRes = await fetch(
        `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}&language=en-US`
      );
      const enDetail = await enRes.json();

      // Credits
      const creditRes = await fetch(
        `https://api.themoviedb.org/3/movie/${tmdbId}/credits?api_key=${TMDB_KEY}`
      );
      const credits = await creditRes.json();

      // 포스터
      if (!movie.poster_path && (detail.poster_path || enDetail.poster_path)) {
        updates.poster_path = detail.poster_path || enDetail.poster_path;
        console.log(`  poster: ${updates.poster_path}`);
      }

      // 줄거리 - 한국어 우선, 없으면 영어
      if (!movie.overview) {
        updates.overview = detail.overview || enDetail.overview || null;
        if (updates.overview) console.log(`  overview: ${updates.overview.slice(0, 50)}...`);
      }

      // 장르
      if (!movie.genres && detail.genres?.length) {
        updates.genres = JSON.stringify(detail.genres.map(g => g.name));
        console.log(`  genres: ${updates.genres}`);
      }

      // 감독
      if (!movie.director && credits.crew?.length) {
        const director = credits.crew.find(c => c.job === "Director");
        if (director) {
          updates.director = director.name;
          console.log(`  director: ${updates.director}`);
        }
      }

      // 출연진
      if (!movie.cast && credits.cast?.length) {
        updates.cast = JSON.stringify(credits.cast.slice(0, 10).map(c => c.name));
        console.log(`  cast: ${credits.cast.slice(0, 3).map(c => c.name).join(", ")}...`);
      }

      // 출시일
      if (!movie.release_date && detail.release_date) {
        updates.release_date = detail.release_date;
      }

      // TMDB 평점
      if (!movie.rating && detail.vote_average) {
        updates.rating = String(detail.vote_average);
      }

      // 런타임
      if (!movie.runtime && detail.runtime) {
        updates.runtime = detail.runtime;
      }

      // IMDb ID
      if (!movie.imdb_id) {
        const idsRes = await fetch(
          `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${TMDB_KEY}`
        );
        const ids = await idsRes.json();
        if (ids.imdb_id) {
          updates.imdb_id = ids.imdb_id;
          console.log(`  imdb_id: ${updates.imdb_id}`);
        }
      }
    }

    // 3) OMDB에서 줄거리 보강 (overview가 여전히 없으면)
    if (!movie.overview && !updates.overview && movie.imdb_id) {
      const omdbRes = await fetch(`https://www.omdbapi.com/?apikey=${OMDB_KEY}&i=${movie.imdb_id}&plot=full`);
      const omdb = await omdbRes.json();
      if (omdb.Response === "True" && omdb.Plot && omdb.Plot !== "N/A") {
        updates.overview = omdb.Plot;
        console.log(`  overview (OMDB): ${omdb.Plot.slice(0, 50)}...`);
      }
    }

    // DB 업데이트
    const keys = Object.keys(updates);
    if (keys.length > 0) {
      const setClauses = keys.map(k => k === "cast" ? `"cast" = ?` : `${k} = ?`).join(", ");
      const values = keys.map(k => updates[k]);
      values.push(movie.id);
      db.prepare(`UPDATE movies SET ${setClauses} WHERE id = ?`).run(...values);
      enriched++;
      console.log(`  ✓ ${keys.length}개 필드 업데이트\n`);
    } else {
      console.log(`  - 업데이트할 항목 없음\n`);
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}\n`);
  }
}

console.log(`\n완료: ${enriched}/${targets.length}개 보강됨`);

// 최종 통계
const stats = db.prepare(
  "SELECT COUNT(*) as total, SUM(CASE WHEN poster_path IS NOT NULL THEN 1 ELSE 0 END) as has_poster, SUM(CASE WHEN overview IS NOT NULL THEN 1 ELSE 0 END) as has_overview, SUM(CASE WHEN genres IS NOT NULL THEN 1 ELSE 0 END) as has_genres, SUM(CASE WHEN director IS NOT NULL THEN 1 ELSE 0 END) as has_director, SUM(CASE WHEN imdb_rating IS NOT NULL OR rotten_tomatoes IS NOT NULL THEN 1 ELSE 0 END) as has_ratings FROM movies"
).get();
console.log("\n=== 최종 통계 ===");
console.log(`전체: ${stats.total}개`);
console.log(`포스터: ${stats.has_poster}개`);
console.log(`줄거리: ${stats.has_overview}개`);
console.log(`장르: ${stats.has_genres}개`);
console.log(`감독: ${stats.has_director}개`);
console.log(`평점: ${stats.has_ratings}개`);
