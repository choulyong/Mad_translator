import Database from "better-sqlite3";

const db = new Database("local.db");
const API_KEY = "f01bb28";

// imdb_id는 있지만 imdb_rating이 없는 영화들
const targets = db.prepare(
  "SELECT id, title, imdb_id FROM movies WHERE imdb_rating IS NULL AND imdb_id IS NOT NULL"
).all();

console.log("IMDb ID로 재시도:", targets.length, "개\n");

let enriched = 0;

for (const movie of targets) {
  try {
    const res = await fetch(`https://www.omdbapi.com/?apikey=${API_KEY}&i=${movie.imdb_id}`);
    const data = await res.json();

    if (data.Response === "True") {
      const rt = data.Ratings?.find((r) => r.Source === "Rotten Tomatoes");
      const imdbRating = data.imdbRating !== "N/A" ? data.imdbRating : null;
      const rottenTomatoes = rt?.Value || null;
      const metacritic = data.Metascore !== "N/A" ? data.Metascore : null;
      const awards = data.Awards !== "N/A" ? data.Awards : null;

      const hasData = imdbRating || rottenTomatoes || metacritic;

      if (hasData) {
        db.prepare(
          "UPDATE movies SET imdb_rating = COALESCE(?, imdb_rating), rotten_tomatoes = COALESCE(?, rotten_tomatoes), metacritic = COALESCE(?, metacritic), awards = COALESCE(?, awards) WHERE id = ?"
        ).run(imdbRating, rottenTomatoes, metacritic, awards, movie.id);
        enriched++;
      }

      console.log(
        hasData ? "OK" : "NO RATING",
        ":", movie.title,
        `[${movie.imdb_id}]`,
        "- IMDb:", imdbRating || "N/A",
        "RT:", rottenTomatoes || "N/A",
        "MC:", metacritic || "N/A"
      );
    } else {
      console.log("NOT FOUND:", movie.title, `[${movie.imdb_id}]`, data.Error);
    }
  } catch (e) {
    console.log("ERROR:", movie.title, e.message);
  }
}

console.log("\n완료:", enriched + "/" + targets.length, "개 보강됨");

// 최종 현황
const total = db.prepare("SELECT COUNT(*) as cnt FROM movies").get();
const withRating = db.prepare("SELECT COUNT(*) as cnt FROM movies WHERE imdb_rating IS NOT NULL OR rotten_tomatoes IS NOT NULL").get();
const noRating = db.prepare("SELECT COUNT(*) as cnt FROM movies WHERE imdb_rating IS NULL AND rotten_tomatoes IS NULL").get();
console.log(`\n전체: ${total.cnt}개 | 평점있음: ${withRating.cnt}개 | 없음: ${noRating.cnt}개`);
