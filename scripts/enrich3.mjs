import Database from "better-sqlite3";

const db = new Database("local.db");
const OMDB_KEY = "f01bb28";
const TMDB_KEY = "c34f1455daa668c1f65229691e1cab5a";

const targets = db.prepare(
  "SELECT id, title, tmdb_id, imdb_id FROM movies WHERE imdb_rating IS NULL AND rotten_tomatoes IS NULL"
).all();

console.log("영어 원제로 재시도:", targets.length, "개\n");

let enriched = 0;

for (const movie of targets) {
  try {
    let englishTitle = null;
    let year = null;
    let imdbId = movie.imdb_id;

    // TMDB에서 영어 원제 + IMDb ID 가져오기
    if (movie.tmdb_id) {
      const res = await fetch(
        `https://api.themoviedb.org/3/movie/${movie.tmdb_id}?api_key=${TMDB_KEY}&language=en-US`
      );
      if (res.ok) {
        const detail = await res.json();
        englishTitle = detail.original_title || detail.title;
        year = detail.release_date?.slice(0, 4);
        console.log(`  TMDB: "${movie.title}" → "${englishTitle}" (${year})`);
      }

      // IMDb ID도 가져오기
      if (!imdbId) {
        const idRes = await fetch(
          `https://api.themoviedb.org/3/movie/${movie.tmdb_id}/external_ids?api_key=${TMDB_KEY}`
        );
        if (idRes.ok) {
          const ids = await idRes.json();
          imdbId = ids.imdb_id || null;
          if (imdbId) console.log(`  IMDb ID found: ${imdbId}`);
        }
      }
    }

    // 귀멸의 칼날은 tmdb_id 없으니 파일명에서 추출
    if (!englishTitle && movie.title.includes("Demon.Slayer")) {
      englishTitle = "Demon Slayer Infinity Castle";
      year = "2025";
      console.log(`  파일명 추출: "${englishTitle}" (${year})`);
    }

    let data = null;

    // 1차: IMDb ID로 직접 조회
    if (imdbId) {
      const res = await fetch(`https://www.omdbapi.com/?apikey=${OMDB_KEY}&i=${imdbId}`);
      const json = await res.json();
      if (json.Response === "True" && json.imdbRating !== "N/A") {
        data = json;
        console.log(`  OMDB by IMDb ID: found`);
      }
    }

    // 2차: 영어 제목으로 검색
    if (!data && englishTitle) {
      const params = new URLSearchParams({ apikey: OMDB_KEY, t: englishTitle, type: "movie" });
      if (year) params.set("y", year);
      const res = await fetch(`https://www.omdbapi.com/?${params.toString()}`);
      const json = await res.json();
      if (json.Response === "True") {
        data = json;
        console.log(`  OMDB by title: found`);
      } else {
        // 연도 없이 재시도
        const params2 = new URLSearchParams({ apikey: OMDB_KEY, t: englishTitle, type: "movie" });
        const res2 = await fetch(`https://www.omdbapi.com/?${params2.toString()}`);
        const json2 = await res2.json();
        if (json2.Response === "True") {
          data = json2;
          console.log(`  OMDB by title (no year): found`);
        }
      }
    }

    if (data) {
      const rt = data.Ratings?.find((r) => r.Source === "Rotten Tomatoes");
      const imdbRating = data.imdbRating !== "N/A" ? data.imdbRating : null;
      const rottenTomatoes = rt?.Value || null;
      const metacritic = data.Metascore !== "N/A" ? data.Metascore : null;
      const awards = data.Awards !== "N/A" ? data.Awards : null;
      const foundImdbId = data.imdbID || imdbId;

      if (imdbRating || rottenTomatoes || metacritic) {
        db.prepare(
          "UPDATE movies SET imdb_id = COALESCE(?, imdb_id), imdb_rating = COALESCE(?, imdb_rating), rotten_tomatoes = COALESCE(?, rotten_tomatoes), metacritic = COALESCE(?, metacritic), awards = COALESCE(?, awards) WHERE id = ?"
        ).run(foundImdbId, imdbRating, rottenTomatoes, metacritic, awards, movie.id);
        enriched++;
        console.log(`  ✓ IMDb: ${imdbRating || "N/A"} | RT: ${rottenTomatoes || "N/A"} | MC: ${metacritic || "N/A"}\n`);
      } else {
        console.log(`  ✗ 평점 데이터 없음\n`);
      }
    } else {
      console.log(`  ✗ OMDB에서 찾을 수 없음\n`);
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}\n`);
  }
}

console.log("완료:", enriched + "/" + targets.length, "개 보강됨");

const total = db.prepare("SELECT COUNT(*) as cnt FROM movies").get();
const withRating = db.prepare("SELECT COUNT(*) as cnt FROM movies WHERE imdb_rating IS NOT NULL OR rotten_tomatoes IS NOT NULL").get();
const noRating = db.prepare("SELECT COUNT(*) as cnt FROM movies WHERE imdb_rating IS NULL AND rotten_tomatoes IS NULL").get();
console.log(`전체: ${total.cnt}개 | 평점있음: ${withRating.cnt}개 | 없음: ${noRating.cnt}개`);
