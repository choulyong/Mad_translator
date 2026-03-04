export interface WikiResult {
  plot: string;      // == Plot == 섹션 (상세 줄거리)
  summary: string;   // Summary API (영화 개요/배경 정보)
  url: string;
}

function isTitleRelevant(resultTitle: string, movieTitle: string): boolean {
  const rt = resultTitle.toLowerCase();
  const mt = movieTitle.toLowerCase();

  if (rt.startsWith("list of") || rt.startsWith("목록") || rt.includes("filmography")) {
    return false;
  }

  const coreWords = mt
    .replace(/['']/g, "'")
    .replace(/[^a-z가-힣0-9\s']/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (coreWords.length === 0) return true;

  const normalizedResult = rt.replace(/['']/g, "'");
  const matchCount = coreWords.filter((w) => normalizedResult.includes(w)).length;
  return matchCount / coreWords.length >= 0.5;
}

function isFilmContent(extract: string): boolean {
  if (!extract) return false;
  const head = extract.toLowerCase().slice(0, 500);
  const filmIndicators = [
    "film", "movie", "directed", "starring", "screenplay",
    "released", "box office", "production", "cinematography",
    "영화", "감독", "출연", "개봉", "제작", "각본", "배급",
  ];
  return filmIndicators.filter((kw) => head.includes(kw)).length >= 2;
}

/**
 * Wikipedia 전체 문서에서 Plot/줄거리 섹션 추출
 */
function extractPlotSection(fullText: string, lang: string): string {
  const plotMarkers = lang === "ko"
    ? ["== 줄거리 ==", "== 시놉시스 =="]
    : ["== Plot ==", "== Synopsis =="];

  for (const marker of plotMarkers) {
    const idx = fullText.indexOf(marker);
    if (idx === -1) continue;

    const start = idx + marker.length;
    const end = fullText.indexOf("\n==", start);
    const plot = fullText.slice(start, end === -1 ? undefined : end).trim();
    if (plot.length > 50) return plot;
  }

  return "";
}

/**
 * Wikipedia 페이지 전체 텍스트(extract) 가져오기
 */
async function fetchFullExtract(baseApi: string, pageTitle: string): Promise<string> {
  const params = new URLSearchParams({
    action: "query",
    titles: pageTitle,
    prop: "extracts",
    explaintext: "true",
    format: "json",
  });
  const res = await fetch(`${baseApi}/w/api.php?${params.toString()}`);
  if (!res.ok) return "";

  const data = await res.json();
  const pages = data?.query?.pages;
  if (!pages) return "";

  for (const [pageId, page] of Object.entries(pages)) {
    if (pageId !== "-1" && (page as { extract?: string }).extract) {
      return (page as { extract: string }).extract;
    }
  }
  return "";
}

/**
 * Summary API로 영화 개요 가져오기
 */
async function fetchSummary(baseApi: string, pageTitle: string): Promise<{ extract: string; url: string }> {
  try {
    const titleEncoded = encodeURIComponent(pageTitle.replace(/ /g, "_"));
    const res = await fetch(`${baseApi}/api/rest_v1/page/summary/${titleEncoded}`);
    if (!res.ok) return { extract: "", url: "" };
    const data = await res.json();
    return {
      extract: data?.extract || "",
      url: data?.content_urls?.desktop?.page || "",
    };
  } catch {
    return { extract: "", url: "" };
  }
}

/**
 * 검색 → 관련성 검증 → Plot 섹션 + Summary API 둘 다 가져오기
 */
async function searchAndGetBoth(
  lang: string,
  queries: string[],
  movieTitle: string
): Promise<WikiResult | null> {
  const baseApi = `https://${lang}.wikipedia.org`;

  for (const query of queries) {
    try {
      // 1) 검색
      const searchUrl = `${baseApi}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5`;
      const searchRes = await fetch(searchUrl);
      if (!searchRes.ok) continue;

      const searchData = await searchRes.json();
      const results = searchData?.query?.search;
      if (!results || results.length === 0) continue;

      // 2) 관련성 필터
      const filmKeywords = lang === "ko" ? ["영화", "필름"] : ["film", "movie"];
      const relevant = results.filter((r: { title: string }) =>
        isTitleRelevant(r.title, movieTitle)
      );
      if (relevant.length === 0) continue;

      const best =
        relevant.find((r: { title: string }) =>
          filmKeywords.some((kw) => r.title.toLowerCase().includes(kw))
        ) || relevant[0];

      // 3) 전체 문서 가져오기
      const fullText = await fetchFullExtract(baseApi, best.title);
      if (!fullText) continue;

      // 영화 내용 검증
      if (!isFilmContent(fullText)) {
        console.log(`[Wikipedia] Skipped (not film): "${best.title}"`);
        continue;
      }

      // 4) Plot 섹션 추출
      const plotSection = extractPlotSection(fullText, lang);

      // 5) Summary API 가져오기 (항상)
      const { extract: summaryText, url } = await fetchSummary(baseApi, best.title);

      if (plotSection || (summaryText && summaryText.length > 50)) {
        console.log(`[Wikipedia] "${best.title}" — plot=${plotSection.length}chars, summary=${summaryText.length}chars`);
        return {
          plot: plotSection,
          summary: summaryText,
          url,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/** 한국어 위키피디아에서 영화 정보 가져오기 */
export async function getKoreanWikiSummary(
  title: string,
  year?: string
): Promise<WikiResult | null> {
  const queries = [
    `${title} ${year || ""} 영화`.trim(),
    `${title} (영화)`,
    title,
  ];
  return searchAndGetBoth("ko", queries, title);
}

/** 영어 위키피디아에서 영화 정보 가져오기 */
export async function getEnglishWikiSummary(
  title: string,
  year?: string
): Promise<WikiResult | null> {
  const queries = [
    `${title} ${year || ""} film`.trim(),
    `${title} (film)`,
    title,
  ];
  return searchAndGetBoth("en", queries, title);
}
