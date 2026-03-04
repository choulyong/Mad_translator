import Database from "better-sqlite3";

const db = new Database("local.db");
const API_KEY = "f01bb28";

const targets = db.prepare("SELECT id, title, tmdb_id, imdb_id, release_date FROM movies WHERE imdb_rating IS NULL").all();
console.log("보강 대상:", targets.length, "개\n");

let enriched = 0;

for (const movie of targets) {
  try {
    let data = null;

    // 1차: imdb_id로 조회
    if (movie.imdb_id) {
      const res = await fetch(`https://www.omdbapi.com/?apikey=${API_KEY}&i=${movie.imdb_id}`);
      const json = await res.json();
      if (json.Response === "True") data = json;
    }

    // 2차: title로 검색
    if (!data) {
      const year = movie.release_date ? movie.release_date.slice(0, 4) : "";
      const params = new URLSearchParams({ apikey: API_KEY, t: movie.title, type: "movie" });
      if (year) params.set("y", year);
      const res = await fetch(`https://www.omdbapi.com/?${params.toString()}`);
      const json = await res.json();
      if (json.Response === "True") data = json;
    }

    if (data) {
      const rt = data.Ratings?.find((r) => r.Source === "Rotten Tomatoes");
      const imdbRating = data.imdbRating !== "N/A" ? data.imdbRating : null;
      const rottenTomatoes = rt?.Value || null;
      const metacritic = data.Metascore !== "N/A" ? data.Metascore : null;
      const awards = data.Awards !== "N/A" ? data.Awards : null;
      const imdbId = data.imdbID || movie.imdb_id;

      if (imdbRating || rottenTomatoes || metacritic) {
        db.prepare(
          "UPDATE movies SET imdb_id = COALESCE(?, imdb_id), imdb_rating = COALESCE(?, imdb_rating), rotten_tomatoes = COALESCE(?, rotten_tomatoes), metacritic = COALESCE(?, metacritic), awards = COALESCE(?, awards) WHERE id = ?"
        ).run(imdbId, imdbRating, rottenTomatoes, metacritic, awards, movie.id);
        enriched++;
        console.log("OK:", movie.title, "- IMDb:", imdbRating, "RT:", rottenTomatoes, "MC:", metacritic);
      } else {
        console.log("NO DATA:", movie.title);
      }
    } else {
      console.log("NOT FOUND:", movie.title);
    }
  } catch (e) {
    console.log("ERROR:", movie.title, e.message);
  }
}

console.log("\n완료:", enriched + "/" + targets.length, "개 보강됨");

const remaining = db.prepare("SELECT COUNT(*) as cnt FROM movies WHERE imdb_rating IS NULL").get();
console.log("남은 미보강:", remaining.cnt, "개");
