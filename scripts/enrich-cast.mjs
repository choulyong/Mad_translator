import Database from "better-sqlite3";

const db = new Database("local.db");
const TMDB_KEY = "c34f1455daa668c1f65229691e1cab5a";

const targets = db.prepare(
  "SELECT id, title, tmdb_id FROM movies WHERE tmdb_id IS NOT NULL AND cast_profiles IS NULL"
).all();

console.log(`출연진 사진 보강: ${targets.length}개\n`);
let enriched = 0;

for (const movie of targets) {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/movie/${movie.tmdb_id}/credits?api_key=${TMDB_KEY}`
    );
    const data = await res.json();

    if (data.cast?.length) {
      const profiles = data.cast.slice(0, 10).map(c => ({
        name: c.name,
        character: c.character,
        profilePath: c.profile_path,
      }));

      db.prepare('UPDATE movies SET cast_profiles = ? WHERE id = ?')
        .run(JSON.stringify(profiles), movie.id);
      enriched++;

      const withPhoto = profiles.filter(p => p.profilePath).length;
      console.log(`OK: ${movie.title} - ${profiles.length}명 (사진 ${withPhoto})`);
    }
  } catch (e) {
    console.log(`ERROR: ${movie.title} - ${e.message}`);
  }
}

console.log(`\n완료: ${enriched}/${targets.length}개`);
