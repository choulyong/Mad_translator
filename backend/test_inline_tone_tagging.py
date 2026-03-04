import asyncio
import os
import sys
import re
from dotenv import load_dotenv

load_dotenv()
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.api.subtitles import get_vertex_ai
from app.core.tone_mapper import RelationToneMapper

async def main():
    print("=== 1. Setup Test Data & Tone Mapper ===")
    strategy_rel = [
        {"from": "Deck", "to": "Father", "speech_level": "honorific"},
        {"from": "Father", "to": "Deck", "speech_level": "banmal"},
        {"from": "Tia", "to": "Deck", "speech_level": "banmal"},
        {"from": "Deck", "to": "Tia", "speech_level": "honorific"}
    ]
    mapper = RelationToneMapper(strategy_rel)
    
    raw_blocks = [
        {"id": 1, "speaker": "Deck", "addressee": "Father", "en": "I have completed the mission as instructed."},
        {"id": 2, "speaker": "Father", "addressee": "Deck", "en": "Good. Now return to the base immediately."},
        {"id": 3, "speaker": "Tia", "addressee": "Deck", "en": "What did you just say? Are you crazy?"},
        {"id": 4, "speaker": "Deck", "addressee": "Tia", "en": "Please calm down. We need to focus."}
    ]

    print("\n=== 2. Task A: Inline Tag Injection Simulation ===")
    api_blocks = []
    for b in raw_blocks:
        speaker = b.get("speaker")
        addressee = b.get("addressee")
        original_en = b.get("en")
        
        target_tone = mapper.get_tone(speaker, addressee)
        inline_tag = f"[System: {speaker} -> {addressee} ({target_tone})] "
        tagged_en = inline_tag + original_en
        
        api_blocks.append({
            "index": b["id"],
            "text": tagged_en
        })
        print(f"[INJECTED] Block {b['id']} -> {tagged_en}")
        
    print("\n=== 3. Task B: VertexTranslator Batch Translation ===")
    translator = get_vertex_ai()
    
    # 더미 context
    context_info = {
        "genre": "Sci-Fi / Action",
        "personas": "Deck: Young soldier, Father: Strict general, Tia: Hot-tempered warrior."
    }
    
    print("Calling LLM (this might take a few seconds)...")
    res = await translator.translate_batch(api_blocks, context_info)
    raw_response = res.get("data", "")
    
    print("\n[RAW LLM OUTPUT]")
    print(raw_response)
    
    print("\n=== 4. Task C: Tag Stripper Guardrail Test ===")
    import json
    
    # 파싱
    parsed = []
    try:
        # LLM이 markdown 백틱을 쓸 수 있음
        text_clean = raw_response
        if "```json" in text_clean:
            text_clean = text_clean.split("```json")[1].split("```")[0].strip()
        elif "```" in text_clean:
            text_clean = text_clean.split("```")[1].split("```")[0].strip()
            
        parsed = json.loads(text_clean)
    except Exception as e:
        print("JSON 파싱 에러:", e)
        return
        
    print("\n[AFTER GUARDRAIL - FINAL KO RESULT]")
    for trans in parsed:
        text = trans.get("ko") or trans.get("text", "")
        # 가드레일 동작
        stripped_text = re.sub(r'\[(?:System|시스템).*?\]', '', text).strip()
        print(f"ID {trans.get('id', trans.get('index'))}: {stripped_text}")

if __name__ == "__main__":
    asyncio.run(main())
