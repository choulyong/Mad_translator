from fastapi import APIRouter, HTTPException
from app.services.crawler import MetadataScraper
from app.services.vertex_ai import VertexTranslator

router = APIRouter()
scraper = MetadataScraper()
translator = VertexTranslator()

@router.get("/search")
async def search_movie(title: str):
    import traceback
    try:
        data = scraper.search_movie(title)
    except Exception as e:
        print(f"[METADATA 500] search_movie error: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))

    if data is None:
        raise HTTPException(status_code=404, detail=f"Movie not found: {title}")

    # 영어 줄거리를 한글로 번역
    if data.get("detailed_plot"):
        try:
            korean_plot = await translate_plot_to_korean(data["detailed_plot"], data.get("title", ""))
            data["detailed_plot_ko"] = korean_plot
        except Exception as e:
            print(f"[Plot Translation] Error: {e}")
            data["detailed_plot_ko"] = ""
    else:
        data["detailed_plot_ko"] = ""

    return data

async def translate_plot_to_korean(plot_text: str, title: str) -> str:
    """
    영어 줄거리를 한글로 번역
    """
    if not plot_text or len(plot_text.strip()) < 10:
        return ""

    # 번역 프롬프트
    prompt = f"""당신은 영화 줄거리 번역 전문가입니다.
영화 '{title}'의 영어 줄거리를 자연스러운 한글로 번역해주세요.

번역 규칙:
1. 자연스러운 한글 표현 사용
2. 원문의 의미를 정확히 전달
3. 영화 타이틀이나 인명은 원문 유지 가능
4. 한국 관객이 쉽게 이해할 수 있도록

영어 줄거리:
{plot_text[:3000]}

한글 번역:"""

    try:
        import asyncio as _asyncio
        loop = _asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: translator.client.models.generate_content(
                model="gemini-2.5-flash",
                contents=prompt,
                config={
                    "temperature": 0.3,
                    "top_p": 0.9,
                    "max_output_tokens": 1000,
                    "thinking_config": {"thinking_budget": 0},
                }
            )
        )

        if response.text:
            return response.text.strip()
    except Exception as e:
        print(f"[Gemini Translation] Error: {e}")

    return ""
