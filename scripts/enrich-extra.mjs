import Database from "better-sqlite3";

const db = new Database("local.db");
const TMDB_KEY = "c34f1455daa668c1f65229691e1cab5a";
const OMDB_KEY = "f01bb28";

const movies = db.prepare(
  "SELECT id, title, tmdb_id, imdb_id, backdrop_path, tagline, trailer_url, budget, revenue, production_countries, writer, rated, plot_full, box_office FROM movies"
).all();

console.log(`전체 ${movies.length}개 영화 보강 시작\n`);
let enriched = 0;

for (const movie of movies) {
  const updates = {};
  console.log(`--- ${movie.title} ---`);

  try {
    // === TMDB 보강 ===
    if (movie.tmdb_id) {
      // 한국어 상세
      const koRes = await fetch(
        `https://api.themoviedb.org/3/movie/${movie.tmdb_id}?api_key=${TMDB_KEY}&language=ko-KR`
      );
      const ko = await koRes.json();

      // 영어 상세 (fallback)
      const enRes = await fetch(
        `https://api.themoviedb.org/3/movie/${movie.tmdb_id}?api_key=${TMDB_KEY}&language=en-US`
      );
      const en = await enRes.json();

      // 배경 이미지
      if (!movie.backdrop_path) {
        const bp = ko.backdrop_path || en.backdrop_path;
        if (bp) {
          updates.backdrop_path = bp;
          console.log(`  backdrop: ${bp}`);
        }
      }

      // 태그라인
      if (!movie.tagline) {
        const tl = ko.tagline || en.tagline;
        if (tl) {
          updates.tagline = tl;
          console.log(`  tagline: ${tl}`);
        }
      }

      // 제작비 / 수익
      if (!movie.budget && en.budget > 0) {
        updates.budget = en.budget;
        console.log(`  budget: $${(en.budget / 1e6).toFixed(1)}M`);
      }
      if (!movie.revenue && en.revenue > 0) {
        updates.revenue = en.revenue;
        console.log(`  revenue: $${(en.revenue / 1e6).toFixed(1)}M`);
      }

      // 제작 국가
      if (!movie.production_countries && en.production_countries?.length) {
        const countries = en.production_countries.map(c => c.name);
        updates.production_countries = JSON.stringify(countries);
        console.log(`  countries: ${countries.join(", ")}`);
      }

      // 각본가 (credits)
      if (!movie.writer) {
        const credRes = await fetch(
          `https://api.themoviedb.org/3/movie/${movie.tmdb_id}/credits?api_key=${TMDB_KEY}`
        );
        const cred = await credRes.json();
        const writers = cred.crew?.filter(c =>
          c.job === "Writer" || c.job === "Screenplay" || c.job === "Story"
        ).map(c => c.name) || [];
        if (writers.length > 0) {
          updates.writer = [...new Set(writers)].join(", ");
          console.log(`  writer: ${updates.writer}`);
        }
      }

      // 트레일러 (YouTube)
      if (!movie.trailer_url) {
        const vidRes = await fetch(
          `https://api.themoviedb.org/3/movie/${movie.tmdb_id}/videos?api_key=${TMDB_KEY}&language=ko-KR`
        );
        const vid = await vidRes.json();

        // 한국어 트레일러 먼저
        let trailer = vid.results?.find(v => v.type === "Trailer" && v.site === "YouTube");

        if (!trailer) {
          // 영어 트레일러
          const vidEnRes = await fetch(
            `https://api.themoviedb.org/3/movie/${movie.tmdb_id}/videos?api_key=${TMDB_KEY}&language=en-US`
          );
          const vidEn = await vidEnRes.json();
          trailer = vidEn.results?.find(v => v.type === "Trailer" && v.site === "YouTube");
          // 티저라도
          if (!trailer) {
            trailer = vidEn.results?.find(v => v.type === "Teaser" && v.site === "YouTube");
          }
        }

        if (trailer) {
          updates.trailer_url = `https://www.youtube.com/watch?v=${trailer.key}`;
          console.log(`  trailer: ${updates.trailer_url}`);
        }
      }
    }

    // === OMDB 보강 ===
    if (movie.imdb_id) {
      const omdbRes = await fetch(
        `https://www.omdbapi.com/?apikey=${OMDB_KEY}&i=${movie.imdb_id}&plot=full`
      );
      const omdb = await omdbRes.json();

      if (omdb.Response === "True") {
        // 상세 줄거리
        if (!movie.plot_full && omdb.Plot && omdb.Plot !== "N/A") {
          updates.plot_full = omdb.Plot;
          console.log(`  plot_full: ${omdb.Plot.slice(0, 60)}...`);
        }

        // 연령 등급
        if (!movie.rated && omdb.Rated && omdb.Rated !== "N/A") {
          updates.rated = omdb.Rated;
          console.log(`  rated: ${omdb.Rated}`);
        }

        // 각본가 (OMDB fallback)
        if (!movie.writer && !updates.writer && omdb.Writer && omdb.Writer !== "N/A") {
          updates.writer = omdb.Writer;
          console.log(`  writer (OMDB): ${omdb.Writer}`);
        }

        // 박스오피스
        if (!movie.box_office && omdb.BoxOffice && omdb.BoxOffice !== "N/A") {
          updates.box_office = omdb.BoxOffice;
          console.log(`  box_office: ${omdb.BoxOffice}`);
        }
      }
    }

    // DB 업데이트
    const keys = Object.keys(updates);
    if (keys.length > 0) {
      const setClauses = keys.map(k => `${k} = ?`).join(", ");
      const values = keys.map(k => updates[k]);
      values.push(movie.id);
      db.prepare(`UPDATE movies SET ${setClauses} WHERE id = ?`).run(...values);
      enriched++;
      console.log(`  => ${keys.length}개 필드 업데이트\n`);
    } else {
      console.log(`  - 업데이트 없음\n`);
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}\n`);
  }
}

console.log(`\n완료: ${enriched}/${movies.length}개 보강됨`);

// 통계
const stats = db.prepare(`
  SELECT COUNT(*) as total,
    SUM(CASE WHEN backdrop_path IS NOT NULL THEN 1 ELSE 0 END) as backdrop,
    SUM(CASE WHEN tagline IS NOT NULL THEN 1 ELSE 0 END) as tagline,
    SUM(CASE WHEN trailer_url IS NOT NULL THEN 1 ELSE 0 END) as trailer,
    SUM(CASE WHEN budget > 0 THEN 1 ELSE 0 END) as budget,
    SUM(CASE WHEN revenue > 0 THEN 1 ELSE 0 END) as revenue,
    SUM(CASE WHEN production_countries IS NOT NULL THEN 1 ELSE 0 END) as countries,
    SUM(CASE WHEN writer IS NOT NULL THEN 1 ELSE 0 END) as writer,
    SUM(CASE WHEN rated IS NOT NULL THEN 1 ELSE 0 END) as rated,
    SUM(CASE WHEN plot_full IS NOT NULL THEN 1 ELSE 0 END) as plot_full,
    SUM(CASE WHEN box_office IS NOT NULL THEN 1 ELSE 0 END) as box_office
  FROM movies
`).get();

console.log("\n=== 최종 통계 ===");
console.log(`전체: ${stats.total}개`);
console.log(`배경이미지: ${stats.backdrop}개`);
console.log(`태그라인: ${stats.tagline}개`);
console.log(`트레일러: ${stats.trailer}개`);
console.log(`제작비: ${stats.budget}개`);
console.log(`수익: ${stats.revenue}개`);
console.log(`제작국가: ${stats.countries}개`);
console.log(`각본가: ${stats.writer}개`);
console.log(`연령등급: ${stats.rated}개`);
console.log(`상세줄거리: ${stats.plot_full}개`);
console.log(`박스오피스: ${stats.box_office}개`);
