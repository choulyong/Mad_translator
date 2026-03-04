import json
from typing import Dict, Any, List
from app.services.vertex_ai import get_vertex_ai

# [LORE] Generation System Prompt
LORE_GENERATION_PROMPT = """
Analyze the following English SRT subtitle file for the movie/show "{title}".
Extract and return a JSON object with this exact structure:

```json
{{
  "title": "...",
  "genre": "...",
  "setting": "...",
  "tone_profile": "...",
  "characters": [
    {{
      "id": "CHAR_001",
      "name": "...",
      "name_alt": ["...", "..."],
      "species_or_role": "...",
      "default_tone": "...",
      "personality_keywords": ["...", "..."]
    }}
  ],
  "relationships": [
    {{
      "from": "CHAR_001",
      "to": "CHAR_002",
      "type": "...",
      "tone_rule": "..."
    }}
  ],
  "glossary": [
    {{"term_en": "...", "term_ko": "...", "context": "..."}}
  ],
  "proper_nouns_keep": ["...", "..."],
  "era_speech_style": "..."
}}
```

Rules:
- Identify ALL named characters from the dialogue.
- Infer relationships from context (who speaks formally/informally to whom).
- List all proper nouns that should NOT be translated in `proper_nouns_keep`.
- Detect the genre and overall tone from dialogue patterns.
- Return ONLY valid JSON, no markdown fences, no preamble.
"""

async def run_pass_0_lore(job: dict, blocks: List[Dict[str, Any]], title: str) -> Dict[str, Any]:
    """
    Pass 0: Extract Dynamic LORE metadata using LLM.
    """
    job["current_pass"] = "Pass 0: Dynamic LORE 추출"
    job["logs"].append(f"> [Pass 0] '{title}' 작품의 Dynamic LORE 추출 중...")

    try:
        translator = get_vertex_ai()
        
        # 샘플링 (전체 대본을 다 넣으면 너무 길어질 수 있으므로 최대 500개 블록 정도를 사용)
        sample_blocks = blocks[:500]
        srt_lines = []
        for b in sample_blocks:
            idx = b.get("id", "")
            en_text = b.get("en", "").replace('\n', ' ')
            srt_lines.append(f"{idx}: {en_text}")
            
        srt_content = "\\n".join(srt_lines)
        user_prompt = f"English Subtitles:\\n{srt_content}"
        
        system_instruction = LORE_GENERATION_PROMPT.format(title=title)

        def make_lore_call(*args, **kwargs):
            return translator.client.models.generate_content(
                model=translator.model,
                contents=user_prompt,
                config={
                    "system_instruction": system_instruction,
                    "max_output_tokens": 8192,
                    "temperature": 0.2, # 낮은 온도로 안정적 JSON 생성
                }
            )

        import asyncio
        loop = asyncio.get_event_loop()
        response, error = await loop.run_in_executor(
            None, lambda: translator._retry_with_backoff(make_lore_call)
        )

        if error:
            job["logs"].append(f"> [Pass 0 LORE] API 에러: {str(error)[:100]}")
            return {}

        raw_text = response.text.strip()
        
        # Remove Markdown Fences if LLM hallucinated them
        if raw_text.startswith("```json"):
            raw_text = raw_text[7:]
        if raw_text.startswith("```"):
            raw_text = raw_text[3:]
        if raw_text.endswith("```"):
            raw_text = raw_text[:-3]
            
        raw_text = raw_text.strip()

        try:
            lore_json = json.loads(raw_text)
            job["logs"].append(f"> [Pass 0 LORE] LORE 추출 완료 (캐릭터: {len(lore_json.get('characters', []))}명)")
            return lore_json
        except json.JSONDecodeError as je:
            job["logs"].append(f"> [Pass 0 LORE] JSON Parsing Error. Fallback to Empty LORE.")
            print(f"LORE JSON ERROR: {raw_text}")
            return {}

    except Exception as e:
        job["logs"].append(f"> [Pass 0 LORE] 예외 발생: {str(e)[:100]}")
        return {}
