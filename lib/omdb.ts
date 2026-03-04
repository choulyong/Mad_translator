const BASE_URL = "https://www.omdbapi.com";

export interface OmdbRatings {
  imdbRating: string | null;
  rottenTomatoes: string | null;
  metacritic: string | null;
  imdbId: string | null;
  plot: string | null;
  awards: string | null;
  writer: string | null;
  rated: string | null;
  boxOffice: string | null;
  englishTitle: string | null;
}

export async function getOmdbData(imdbId: string): Promise<OmdbRatings | null> {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey || !imdbId) return null;

  try {
    const res = await fetch(
      `${BASE_URL}/?apikey=${apiKey}&i=${imdbId}&plot=full`
    );
    if (!res.ok) return null;

    const data = await res.json();
    if (data.Response === "False") return null;

    // Extract Rotten Tomatoes from Ratings array
    const rtRating = data.Ratings?.find(
      (r: { Source: string; Value: string }) =>
        r.Source === "Rotten Tomatoes"
    );

    return {
      imdbRating: data.imdbRating !== "N/A" ? data.imdbRating : null,
      rottenTomatoes: rtRating?.Value || null,
      metacritic: data.Metascore !== "N/A" ? data.Metascore : null,
      imdbId: data.imdbID || null,
      plot: data.Plot !== "N/A" ? data.Plot : null,
      awards: data.Awards !== "N/A" ? data.Awards : null,
      writer: data.Writer !== "N/A" ? data.Writer : null,
      rated: data.Rated !== "N/A" ? data.Rated : null,
      boxOffice: data.BoxOffice !== "N/A" ? data.BoxOffice : null,
      englishTitle: data.Title || null,
    };
  } catch (err) {
    console.error("[OMDb] Error:", err);
    return null;
  }
}

/** Search by title (when no IMDb ID available) */
export async function searchOmdb(
  title: string,
  year?: string
): Promise<OmdbRatings | null> {
  const apiKey = process.env.OMDB_API_KEY;
  if (!apiKey) return null;

  try {
    const params = new URLSearchParams({
      apikey: apiKey,
      t: title,
      type: "movie",
      plot: "full",
    });
    if (year) params.set("y", year);

    const res = await fetch(`${BASE_URL}/?${params.toString()}`);
    if (!res.ok) return null;

    const data = await res.json();
    if (data.Response === "False") return null;

    const rtRating = data.Ratings?.find(
      (r: { Source: string; Value: string }) =>
        r.Source === "Rotten Tomatoes"
    );

    return {
      imdbRating: data.imdbRating !== "N/A" ? data.imdbRating : null,
      rottenTomatoes: rtRating?.Value || null,
      metacritic: data.Metascore !== "N/A" ? data.Metascore : null,
      imdbId: data.imdbID || null,
      plot: data.Plot !== "N/A" ? data.Plot : null,
      awards: data.Awards !== "N/A" ? data.Awards : null,
      writer: data.Writer !== "N/A" ? data.Writer : null,
      rated: data.Rated !== "N/A" ? data.Rated : null,
      boxOffice: data.BoxOffice !== "N/A" ? data.BoxOffice : null,
      englishTitle: data.Title || null,
    };
  } catch (err) {
    console.error("[OMDb] Search error:", err);
    return null;
  }
}
