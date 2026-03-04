import os
import sys
import asyncio
import json
import re

# Add backend to path
sys.path.append(os.path.join(os.path.dirname(__file__)))

from app.core.k_cinematic_prompt import get_v5_qc_prompt
from app.api.subtitles import get_vertex_ai, _parse_translation_response, _remove_translationese, remove_periods, fix_speech_flip

async def run_qc_test():
    title = "Zootopia 2 (2025)"
    genre = "Animation, Adventure, Comedy"
    character_relations = "- Nick → Judy: 편한 동료, 반말\n- Bogo → Nick: 직장 상사, 권위적 하대"
    
    # 더미 데이터 생성 (의도적으로 번역투와 마침표를 섞음)
    dummy_blocks = [
        {"index": 1, "start": "00:00:01,000", "end": "00:00:03,000", "en": "Oh, carrots. Are you kidding me?", "ko": "오, 홍당무. 당신은 나를 놀리고 있는 건가요?"},
        {"index": 2, "start": "00:00:03,000", "end": "00:00:05,000", "en": "Chief Bogo needs us right now.", "ko": "보고 서장님이 지금 바로 우리를 필요로 합니다."},
        {"index": 3, "start": "00:00:05,000", "end": "00:00:07,000", "en": "Hustle up, Hopps. We got a situation.", "ko": "서두르십시오, 홉스. 우리는 상황을 가졌습니다."}
    ]
    
    source_lines = [f"{b['index']}: {b['ko']}" for b in dummy_blocks]
    source_payload = "\n".join(source_lines)
    
    user_parts = [f"[작품: {title} / 장르: {genre}]"]
    user_parts.append(f"\n다음 번역된 자막을 QC 규칙에 따라 교정하세요:\n\n{source_payload}")
    user_prompt = "\n".join(user_parts)
    
    system_instruction = get_v5_qc_prompt(
        title=title,
        genre=genre,
        character_relations=character_relations
    )
    
    translator = get_vertex_ai()
    
    print(">>> Requesting Gemini API for QC...")
    response = translator.client.models.generate_content(
        model=translator.model,
        contents=user_prompt,
        config={
            "system_instruction": system_instruction,
            "max_output_tokens": 8192,
            "temperature": 0.1,
            "thinking_config": {"thinking_budget": 1024},
        }
    )
    
    raw_content = response.text
    print("\n--- [RAW GEMINI RESPONSE] ---")
    print(raw_content)
    print("-----------------------------\n")
    
    # 방금 추가한 파서 로직 테스트
    parsed = []
    try:
        json_match = re.search(r'\{.*\}', raw_content, re.DOTALL)
        if json_match:
            json_data = json.loads(json_match.group(0))
            if "qc_results" in json_data and isinstance(json_data["qc_results"], list):
                parsed = json_data["qc_results"]
                print(f"[QC] Successfully parsed {len(parsed)} items from qc_results key.")
        
        if not parsed:
            print("[QC] Falling back to default array parser...")
            parsed = _parse_translation_response(raw_content, dummy_blocks)
    except Exception as parse_err:
        print(f"[QC-WARN] Failed to parse qc_results JSON directly: {parse_err}. Falling back...")
        parsed = _parse_translation_response(raw_content, dummy_blocks)

    print("\n--- [PARSED BLOCKS] ---")
    print(json.dumps(parsed, ensure_ascii=False, indent=2))
    print("------------------------\n")

if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    asyncio.run(run_qc_test())
