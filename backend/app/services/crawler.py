import os
import re
import requests
from bs4 import BeautifulSoup
from typing import Dict, List, Any, Optional

class MetadataScraper:
    """
    🏛️ Subtitle OS: Automated Metadata Crawler
    TMDB API (한글 지원) + OMDB API 백업 + IMDb 상세정보
    """
    def __init__(self):
        # TMDB API - 한글 검색 지원 (무료: https://www.themoviedb.org/settings/api)
        self.tmdb_api_key = os.getenv("TMDB_API_KEY", "c34f1455daa668c1f65229691e1cab5a")
        self.tmdb_base_url = "https://api.themoviedb.org/3"

        # OMDB API (백업용)
        self.omdb_api_key = os.getenv("OMDB_API_KEY", "trilogy")
        self.omdb_url = "http://www.omdbapi.com/"

        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "accept": "application/json"
        }

        # 캐릭터 데이터베이스 (메모리 캐시)
        self._character_cache: Dict[str, Dict] = {}

    def search_movie(self, title: str):
        """
        TMDB API를 사용하여 영화 정보 검색 (한글/영어 모두 지원).
        TMDB 실패 시 OMDB로 폴백.
        """
        print(f"[TMDB] Searching for: {title}")

        # 연도 추출 (예: "주토피아 2016" → year_hint = "2016")
        year_match = re.search(r'\b(19|20)\d{2}\b', title)
        year_hint = year_match.group(0) if year_match else None
        title_without_year = re.sub(r'\s*(19|20)\d{2}\s*$', '', title).strip()

        try:
            # 1. TMDB 검색 (한글/영어 자동 감지)
            search_url = f"{self.tmdb_base_url}/search/movie"
            params = {
                "api_key": self.tmdb_api_key,
                "query": title_without_year,
                "language": "ko-KR",  # 한글 우선
                "include_adult": "false"
            }
            if year_hint:
                params["year"] = year_hint

            response = requests.get(search_url, headers=self.headers, params=params, timeout=10)
            data = response.json()

            if data.get("results") and len(data["results"]) > 0:
                # ✅ FIX: 제목과 연도를 정확히 매칭하는 로직
                movie = self._find_best_match(
                    data["results"],
                    title_without_year,
                    year_hint
                )

                if not movie:
                    # 매칭 실패 시 첫 번째 결과 사용 (fallback)
                    print(f"[TMDB] No exact match found, using first result")
                    movie = data["results"][0]

                movie_id = movie["id"]
                movie_title = movie.get('title', title)
                movie_year = movie.get('release_date', '')[:4] if movie.get('release_date') else ''
                print(f"[TMDB] Found: {movie_title} ({movie_year}) (ID: {movie_id})")

                # 2. 상세 정보 + 출연진 조회
                detail_url = f"{self.tmdb_base_url}/movie/{movie_id}"
                detail_params = {"api_key": self.tmdb_api_key, "language": "ko-KR", "append_to_response": "credits"}
                detail_response = requests.get(detail_url, headers=self.headers, params=detail_params, timeout=10)
                detail = detail_response.json()

                # 장르 추출
                genres = [g["name"] for g in detail.get("genres", [])]

                # 감독/출연진 추출 (캐릭터 정보 포함)
                credits = detail.get("credits", {})
                directors = [c["name"] for c in credits.get("crew", []) if c.get("job") == "Director"]

                # 상세 캐릭터 정보 (배우 → 캐릭터명 매핑)
                cast_list = credits.get("cast", [])[:10]  # 상위 10명
                characters = []
                actors = []

                for cast in cast_list:
                    actor_name = cast.get("name", "")
                    character_name = cast.get("character", "")
                    gender = "남성" if cast.get("gender") == 2 else "여성" if cast.get("gender") == 1 else ""

                    actors.append(actor_name)
                    characters.append({
                        "actor": actor_name,
                        "character": character_name,
                        "gender": gender,
                        "order": cast.get("order", 99)
                    })

                # 키워드 정보 가져오기 (추가 API 호출)
                keywords = self._get_keywords(movie_id)

                # 포스터 URL
                poster_path = detail.get("poster_path")
                poster_url = f"https://image.tmdb.org/t/p/w500{poster_path}" if poster_path else ""

                # 🆕 Wikipedia에서 상세 정보 가져오기 (다국어 지원)
                orig_title = detail.get("original_title", "")
                year = detail.get("release_date", "")[:4] if detail.get("release_date") else ""
                original_language = detail.get("original_language", "en")
                imdb_id = detail.get("imdb_id", "")

                # 한국 영화면 한국어 위키 먼저, 아니면 영어 먼저
                wiki_data = self.get_wikipedia_multilang(orig_title, year, original_language)
                wikipedia_plot = wiki_data.get("plot", "")
                wikipedia_cast = wiki_data.get("cast_info", "")
                wikipedia_lang = wiki_data.get("lang", "")

                # OMDB full plot 가져오기 (Wikipedia보다 간결하지만 신뢰도 높음)
                omdb_full_plot = ""
                if imdb_id:
                    omdb_full_plot = self.get_full_plot(imdb_id) or ""
                    if omdb_full_plot:
                        print(f"[OMDB] Full plot: {len(omdb_full_plot)} chars")

                # 줄거리 조합: 가장 긴 것을 선택 (Wikipedia, OMDB, TMDB 중)
                synopsis = detail.get("overview", "줄거리 정보 없음")
                plot_candidates = [
                    ("Wikipedia", wikipedia_plot),
                    ("OMDB", omdb_full_plot),
                    ("TMDB", synopsis),
                ]
                detailed_plot = max(plot_candidates, key=lambda x: len(x[1]))[1] or synopsis
                print(f"[Plot] Best source: {max(plot_candidates, key=lambda x: len(x[1]))[0]} ({len(detailed_plot)} chars)")

                # 캐시에 저장
                movie_data = {
                    "title": detail.get("title", movie.get("title", title)),
                    "orig_title": orig_title,
                    "genre": genres,
                    "runtime": f"{detail.get('runtime', 0)} min" if detail.get('runtime') else "Unknown",
                    "fps": "23.976 fps",
                    "quality": "HD",
                    "synopsis": synopsis,  # TMDB 짧은 요약
                    "detailed_plot": detailed_plot,  # 🆕 Wikipedia 상세 줄거리
                    "poster_url": poster_url,
                    "year": year,
                    "director": ", ".join(directors) if directors else "",
                    "actors": ", ".join(actors) if actors else "",
                    "imdb_rating": str(detail.get("vote_average", "")),
                    "imdb_id": imdb_id,
                    "tmdb_id": str(movie_id),
                    # 🆕 새로운 상세 정보
                    "characters": characters,  # 배우→캐릭터 매핑
                    "keywords": keywords,  # 영화 키워드
                    "tagline": detail.get("tagline", ""),  # 영화 태그라인
                    "original_language": detail.get("original_language", ""),
                    "production_countries": [c.get("name") for c in detail.get("production_countries", [])],
                    # 🆕 Wikipedia 정보
                    "wikipedia_plot": wikipedia_plot,
                    "wikipedia_cast": wikipedia_cast,
                    "wikipedia_lang": wikipedia_lang,  # "en" 또는 "ko"
                    "has_wikipedia": bool(wikipedia_plot),
                    "omdb_full_plot": omdb_full_plot
                }

                # 캐시에 저장
                self._character_cache[str(movie_id)] = movie_data

                print(f"[TMDB+Wiki] Movie data ready. Wikipedia plot: {len(wikipedia_plot)} chars, Characters: {len(characters)}")

                return movie_data
            else:
                print(f"[TMDB] No results, trying OMDB...")
                return self._search_omdb(title)

        except Exception as e:
            print(f"[TMDB] Error: {e}, falling back to OMDB")
            return self._search_omdb(title)

    def _find_best_match(self, results: List[Dict[str, Any]], title_without_year: str, year_hint: Optional[str]) -> Optional[Dict[str, Any]]:
        """
        🔍 TMDB 검색 결과에서 제목과 연도를 정확히 매칭

        Logic:
        1. 정확한 제목 매칭 (완전 일치)
        2. 부분 제목 매칭 ("Zootopia 2" → "Zootopia" 포함 검사)
        3. 연도 일치 확인 (year_hint 제공 시)
        4. 신뢰도 점수 계산 후 최고 점수 반환

        Returns:
            - 일치하는 영화: Dict (title, id, release_date 포함)
            - 일치 없음: None
        """
        best_match = None
        best_score = 0

        for movie in results:
            movie_title = movie.get('title', '').strip()
            release_date = movie.get('release_date', '')
            movie_year = release_date[:4] if release_date else ''

            score = 0

            # 1️⃣ 정확한 제목 매칭 (최고 점수: 100)
            if movie_title.lower() == title_without_year.lower():
                score = 100

            # 2️⃣ 부분 제목 매칭 (예: "Zootopia 2" → "Zootopia" 검사)
            elif title_without_year.lower() in movie_title.lower():
                score = 80
            elif movie_title.lower() in title_without_year.lower():
                score = 70

            # 3️⃣ 단어 순서 상관없이 주요 단어 일치 (예: "Zootopia 2" vs "2 Zootopia")
            elif all(word.lower() in movie_title.lower() for word in title_without_year.split() if len(word) > 3):
                score = 60

            # 4️⃣ 연도 일치 여부 (year_hint 있을 때만)
            if score > 0 and year_hint:
                if movie_year == year_hint:
                    score += 20  # 연도 일치 보너스
                else:
                    score -= 10  # 연도 불일치 페널티

            # 🏆 최고 점수 업데이트
            if score > best_score:
                best_score = score
                best_match = movie
                print(f"[TMDB] Match: {movie_title} ({movie_year}) - Score: {score}")

        # ✅ 일정 점수 이상일 때만 반환 (낮은 점수는 None 반환 → fallback 사용)
        return best_match if best_score >= 60 else None

    def _search_omdb(self, title: str):
        """OMDB API 백업 검색 (영어만 지원)"""
        try:
            params = {
                "apikey": self.omdb_api_key,
                "t": title,
                "plot": "full"
            }
            response = requests.get(self.omdb_url, params=params, timeout=10)
            data = response.json()

            if data.get("Response") == "True":
                genre_list = data.get("Genre", "").split(", ") if data.get("Genre") else []
                return {
                    "title": data.get("Title", title),
                    "orig_title": data.get("Title", title),
                    "genre": genre_list,
                    "runtime": data.get("Runtime", "Unknown"),
                    "fps": "23.976 fps",
                    "quality": "HD",
                    "synopsis": data.get("Plot", "No synopsis available."),
                    "poster_url": data.get("Poster", "") if data.get("Poster") != "N/A" else "",
                    "year": data.get("Year", ""),
                    "director": data.get("Director", ""),
                    "actors": data.get("Actors", ""),
                    "imdb_rating": data.get("imdbRating", ""),
                    "imdb_id": data.get("imdbID", "")
                }
            else:
                return {
                    "title": title,
                    "orig_title": "",
                    "genre": [],
                    "runtime": "",
                    "fps": "",
                    "quality": "",
                    "synopsis": f"'{title}'에 대한 검색 결과가 없습니다.",
                    "poster_url": "",
                    "error": "Movie not found"
                }
        except Exception as e:
            return {"error": str(e), "title": title, "synopsis": "검색 오류"}
    
    def search_movies(self, title: str, limit: int = 5):
        """
        여러 검색 결과 반환 (제목 검색).
        """
        try:
            params = {
                "apikey": self.omdb_api_key,
                "s": title,  # 검색어로 여러 결과
            }
            response = requests.get(self.omdb_url, params=params, timeout=10)
            data = response.json()
            
            if data.get("Response") == "True":
                results = []
                for movie in data.get("Search", [])[:limit]:
                    results.append({
                        "title": movie.get("Title", ""),
                        "year": movie.get("Year", ""),
                        "type": movie.get("Type", ""),
                        "poster_url": movie.get("Poster", "") if movie.get("Poster") != "N/A" else "",
                        "imdb_id": movie.get("imdbID", "")
                    })
                return {"results": results, "total": int(data.get("totalResults", 0))}
            else:
                return {"results": [], "total": 0, "error": data.get("Error", "No results")}

        except Exception as e:
            return {"results": [], "total": 0, "error": str(e)}

    def _get_keywords(self, movie_id: int) -> List[str]:
        """TMDB 영화 키워드 가져오기"""
        try:
            url = f"{self.tmdb_base_url}/movie/{movie_id}/keywords"
            params = {"api_key": self.tmdb_api_key}
            response = requests.get(url, headers=self.headers, params=params, timeout=5)
            data = response.json()
            return [k["name"] for k in data.get("keywords", [])[:15]]
        except Exception as e:
            print(f"[TMDB] Keywords error: {e}")
            return []

    def _is_title_relevant(self, result_title: str, movie_title: str) -> bool:
        """검색 결과 제목이 영화 제목과 관련 있는지 검증 (목록/무관 문서 필터링)"""
        rt = result_title.lower()
        mt = movie_title.lower()

        # 목록/리스트 문서 거부
        if rt.startswith("list of") or "목록" in rt or "filmography" in rt:
            return False

        # 영화 제목 핵심 단어가 결과 제목에 포함되는지 확인
        import re
        core_words = [w for w in re.split(r'\s+', re.sub(r'[^a-z가-힣0-9\s]', '', mt)) if len(w) > 2]
        if not core_words:
            return True

        match_count = sum(1 for w in core_words if w in rt)
        return match_count / len(core_words) >= 0.5

    def _is_film_content(self, extract: str) -> bool:
        """Wikipedia 내용이 실제로 영화에 관한 것인지 검증"""
        if not extract:
            return False
        # 첫 500자에서 영화 관련 키워드 확인
        head = extract[:500].lower()
        film_indicators = [
            # 영어
            "film", "movie", "directed", "starring", "screenplay",
            "released", "box office", "production", "cinematography",
            # 한국어
            "영화", "감독", "출연", "개봉", "제작", "각본", "배급",
        ]
        matches = sum(1 for kw in film_indicators if kw in head)
        return matches >= 2  # 최소 2개 이상 영화 키워드가 있어야 함

    def _extract_sections(self, extract: str, plot_markers: list, cast_markers: list) -> Dict[str, str]:
        """Wikipedia 전체 텍스트에서 Plot/Cast 섹션 추출"""
        result = {"plot": "", "cast_info": ""}

        # Plot 섹션 추출
        for marker in plot_markers:
            if marker in extract:
                plot_start = extract.find(marker) + len(marker)
                plot_end = extract.find("\n==", plot_start)
                if plot_end == -1:
                    plot_end = len(extract)
                result["plot"] = extract[plot_start:plot_end].strip()
                break

        # Cast 섹션 추출
        for marker in cast_markers:
            if marker in extract:
                cast_start = extract.find(marker) + len(marker)
                cast_end = extract.find("\n==", cast_start)
                if cast_end == -1:
                    cast_end = len(extract)
                result["cast_info"] = extract[cast_start:cast_end].strip()
                break

        # Plot이 없으면 도입부 사용
        if not result["plot"] and extract:
            first_section = extract.find("\n==")
            if first_section > 100:
                result["plot"] = extract[:first_section].strip()

        return result

    def _fetch_page_extract(self, base_url: str, page_title: str, headers: dict) -> str:
        """Wikipedia 페이지의 전체 텍스트(extract) 가져오기"""
        params = {
            "action": "query",
            "titles": page_title,
            "prop": "extracts",
            "explaintext": "true",
            "format": "json"
        }
        response = requests.get(base_url, params=params, headers=headers, timeout=10)
        data = response.json()
        pages = data.get("query", {}).get("pages", {})
        for page_id, page in pages.items():
            if page_id != "-1" and page.get("extract"):
                return page["extract"]
        return ""

    def get_wikipedia_info(self, title: str, year: str = "", lang: str = "en") -> Dict[str, Any]:
        """
        🌐 Wikipedia에서 영화 상세 정보 가져오기
        1단계: 정확한 페이지명으로 직접 조회
        2단계: 실패 시 검색 API로 fallback (제목 관련성 검증 포함)
        """
        result = {
            "plot": "",
            "cast_info": "",
            "full_extract": "",
            "lang": lang
        }

        try:
            base_url = f"https://{lang}.wikipedia.org/w/api.php"
            headers = {"User-Agent": "SubtitleOS/1.0 (Translation Tool)"}

            if lang == "ko":
                plot_markers = ["== 줄거리 ==", "== 시놉시스 =="]
                cast_markers = ["== 출연 ==", "== 출연진 ==", "== 주연 =="]
                # 직접 조회 시도 순서
                direct_titles = [f"{title} (영화)", title]
            else:
                plot_markers = ["== Plot ==", "== Synopsis =="]
                cast_markers = ["== Cast =="]
                direct_titles = [
                    f"{title} ({year} film)" if year else f"{title} (film)",
                    f"{title} (film)",
                    title,
                ]

            # ─── 1단계: 정확한 페이지명으로 직접 조회 ───
            for page_title in direct_titles:
                print(f"[Wikipedia-{lang}] Direct lookup: {page_title}")
                extract = self._fetch_page_extract(base_url, page_title, headers)
                if extract:
                    result["full_extract"] = extract
                    sections = self._extract_sections(extract, plot_markers, cast_markers)
                    result["plot"] = sections["plot"]
                    result["cast_info"] = sections["cast_info"]
                    if result["plot"]:
                        print(f"[Wikipedia-{lang}] Direct hit! Plot: {len(result['plot'])} chars")
                        return result

            # ─── 2단계: 검색 API fallback (제목 관련성 검증) ───
            if lang == "ko":
                search_queries = [f"{title} 영화", title]
            else:
                search_queries = [
                    f"{title} {year} film" if year else f"{title} film",
                    title,
                ]

            for query in search_queries:
                print(f"[Wikipedia-{lang}] Search fallback: {query}")
                search_params = {
                    "action": "query",
                    "list": "search",
                    "srsearch": query,
                    "format": "json",
                    "srlimit": 5
                }
                response = requests.get(base_url, params=search_params, headers=headers, timeout=10)
                data = response.json()
                search_results = data.get("query", {}).get("search", [])

                # 관련성 필터링
                relevant = [r for r in search_results if self._is_title_relevant(r["title"], title)]
                if not relevant:
                    continue

                # 영화 관련 키워드 포함 우선
                film_kw = ["영화", "필름"] if lang == "ko" else ["film", "movie"]
                best = next(
                    (r for r in relevant if any(kw in r["title"].lower() for kw in film_kw)),
                    relevant[0]
                )

                # 관련 결과를 순회하며 영화 내용인지 검증
                for candidate in ([best] + [r for r in relevant if r != best]):
                    print(f"[Wikipedia-{lang}] Search checking: {candidate['title']}")
                    extract = self._fetch_page_extract(base_url, candidate["title"], headers)
                    if not extract:
                        continue
                    # 내용이 실제로 영화에 관한 것인지 검증
                    if not self._is_film_content(extract):
                        print(f"[Wikipedia-{lang}] Skipped (not film content): {candidate['title']}")
                        continue
                    result["full_extract"] = extract
                    sections = self._extract_sections(extract, plot_markers, cast_markers)
                    result["plot"] = sections["plot"]
                    result["cast_info"] = sections["cast_info"]
                    if result["plot"]:
                        print(f"[Wikipedia-{lang}] Search hit! Plot: {len(result['plot'])} chars")
                        return result

            if not result["plot"]:
                print(f"[Wikipedia-{lang}] No relevant article found for '{title}'")

        except Exception as e:
            print(f"[Wikipedia-{lang}] Error: {e}")

        return result

    def get_wikipedia_multilang(self, title: str, year: str = "", original_language: str = "en") -> Dict[str, Any]:
        """
        🌍 다국어 Wikipedia 검색
        한국 영화면 한국어 먼저, 아니면 영어 먼저 검색
        """
        result = {"plot": "", "cast_info": "", "full_extract": "", "lang": ""}

        # 검색 순서 결정
        if original_language == "ko":
            # 한국 영화 → 한국어 먼저
            langs = ["ko", "en"]
        else:
            # 외국 영화 → 영어 먼저
            langs = ["en", "ko"]

        for lang in langs:
            wiki_result = self.get_wikipedia_info(title, year, lang)
            if wiki_result.get("plot"):
                print(f"[Wikipedia] Found content in {lang}")
                return wiki_result

        print(f"[Wikipedia] No content found in any language")
        return result

    def enrich_with_wikipedia(self, title: str, year: str = "") -> Dict[str, Any]:
        """
        🚀 Wikipedia 정보로 메타데이터 강화
        TMDB 정보와 결합하여 최대한의 번역 컨텍스트 제공
        """
        wiki_info = self.get_wikipedia_info(title, year)

        # 줄거리에서 캐릭터 이름 추출 시도
        characters_from_plot = []
        plot = wiki_info.get("plot", "")

        if plot:
            # 간단한 캐릭터 추출 (대문자로 시작하는 이름 패턴)
            import re
            # "Name" 패턴 찾기 (예: Joey, Michael, Noah)
            name_pattern = r'\b([A-Z][a-z]+)\b'
            potential_names = re.findall(name_pattern, plot[:1500])

            # 빈도수로 필터링 (2번 이상 등장)
            from collections import Counter
            name_counts = Counter(potential_names)
            common_words = {'The', 'After', 'While', 'When', 'During', 'One', 'She', 'He', 'Her', 'His', 'They'}
            characters_from_plot = [
                name for name, count in name_counts.most_common(10)
                if count >= 2 and name not in common_words
            ]

        return {
            "wikipedia_plot": plot,
            "wikipedia_cast": wiki_info.get("cast_info", ""),
            "extracted_characters": characters_from_plot,
            "has_wikipedia": bool(plot)
        }

    def get_full_plot(self, imdb_id: str) -> Optional[str]:
        """IMDb에서 상세 줄거리 가져오기 (OMDB full plot)"""
        try:
            params = {
                "apikey": self.omdb_api_key,
                "i": imdb_id,
                "plot": "full"
            }
            response = requests.get(self.omdb_url, params=params, timeout=10)
            data = response.json()
            if data.get("Response") == "True":
                return data.get("Plot", "")
            return None
        except Exception as e:
            print(f"[OMDB] Full plot error: {e}")
            return None

    def get_character_database(self, tmdb_id: str) -> Dict[str, Any]:
        """
        🎭 캐릭터 데이터베이스 반환
        번역 시 캐릭터 정보를 활용할 수 있도록 구조화된 데이터 제공
        """
        if tmdb_id in self._character_cache:
            cached = self._character_cache[tmdb_id]
            return {
                "title": cached.get("title", ""),
                "characters": cached.get("characters", []),
                "character_map": {
                    c["character"]: {
                        "actor": c["actor"],
                        "gender": c["gender"],
                        "is_lead": c["order"] < 3
                    }
                    for c in cached.get("characters", []) if c.get("character")
                },
                "keywords": cached.get("keywords", []),
                "genre": cached.get("genre", [])
            }
        return {"characters": [], "character_map": {}, "keywords": [], "genre": []}

    def enrich_for_translation(self, tmdb_id: str) -> Dict[str, Any]:
        """
        🚀 번역을 위한 강화 데이터 수집
        TMDB + OMDB를 결합하여 최대한의 정보 수집
        """
        result = {
            "characters": [],
            "character_summary": "",
            "plot_keywords": [],
            "genre_hints": [],
            "translation_hints": []
        }

        # 캐시된 데이터 확인
        if tmdb_id not in self._character_cache:
            print(f"[WARN] No cached data for TMDB ID: {tmdb_id}")
            return result

        cached = self._character_cache[tmdb_id]

        # 캐릭터 정보
        characters = cached.get("characters", [])
        result["characters"] = characters

        # 캐릭터 요약 생성 (번역 프롬프트용)
        char_summaries = []
        for c in characters[:7]:
            char_name = c.get("character", "")
            gender = c.get("gender", "")
            actor = c.get("actor", "")
            if char_name:
                summary = f"• {char_name}"
                if gender:
                    summary += f" ({gender})"
                if actor:
                    summary += f" - 배우: {actor}"
                char_summaries.append(summary)

        result["character_summary"] = "\n".join(char_summaries)

        # 키워드
        result["plot_keywords"] = cached.get("keywords", [])

        # 장르 기반 번역 힌트
        genres = cached.get("genre", [])
        result["genre_hints"] = genres

        translation_hints = []
        if "애니메이션" in genres or "Animation" in genres:
            translation_hints.append("아동용 애니메이션의 경우 순화된 표현 사용")
        if "코미디" in genres or "Comedy" in genres:
            translation_hints.append("유머와 말장난은 한국 문화에 맞게 현지화")
        if "액션" in genres or "Action" in genres:
            translation_hints.append("액션 장면의 짧은 외침은 간결하게")
        if "로맨스" in genres or "Romance" in genres:
            translation_hints.append("로맨스 대사는 자연스러운 한국어 감정 표현으로")
        if "SF" in genres or "Science Fiction" in genres:
            translation_hints.append("SF 용어는 기존 번역 관례 따르기")
        if "호러" in genres or "Horror" in genres:
            translation_hints.append("공포 분위기를 살리는 어휘 선택")
        if "가족" in genres or "Family" in genres:
            translation_hints.append("가족 영화는 모든 연령대가 이해 가능하게")

        result["translation_hints"] = translation_hints

        return result
