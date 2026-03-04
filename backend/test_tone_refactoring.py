import asyncio
import os
import sys
from dotenv import load_dotenv

load_dotenv()
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from app.core.tone_mapper import RelationToneMapper
from app.engine.passes.pass_5_5_guardrail import run_final_tone_guardrail

async def main():
    print("=== 1. RelationToneMapper Test ===")
    
    # 1. 초기 셋업 (Strategy)
    strategy_rel = [
        {"from": "Tia", "to": "Deck", "speech_level": "banmal"},
        {"from": "Deck", "to": "Tia", "speech_level": "honorific"}
    ]
    mapper = RelationToneMapper(strategy_rel)
    
    # 2. 동적 추가 (Pass 0.5)
    dynamic_rel = {
        "Deck → Manager": "권위적. 존댓말 사용"
    }
    mapper.update_from_dynamic_extraction(dynamic_rel)
    
    print("Tia -> Deck Tone:", mapper.get_tone("Tia", "Deck")) # Expected: banmal
    print("Deck -> Tia Tone:", mapper.get_tone("Deck", "Tia")) # Expected: honorific
    print("Deck -> Manager Tone:", mapper.get_tone("Deck", "Manager")) # Expected: honorific
    
    print("\nAnchors:")
    print(mapper.inject_few_shot_anchor("Tia", "Deck"))
    print(mapper.inject_few_shot_anchor("Deck", "Tia"))
    
    print("\n=== 2. LLM Guardrail Test ===")
    
    job = {"logs": []}
    blocks = [
        {"id": 1, "speaker": "Tia", "addressee": "Deck", "ko": "알았어요. 당장 갈게요."}, # Violates banmal target
        {"id": 2, "speaker": "Tia", "addressee": "Deck", "ko": "빨리 와!"}, # Good
        {"id": 3, "speaker": "Deck", "addressee": "Tia", "ko": "지금 가고 있어."}, # Violates honorific target
        {"id": 4, "speaker": "Deck", "addressee": "Tia", "ko": "알겠습니다. 금방 가겠습니다."} # Good
    ]
    
    print("Before Guardrail:")
    for b in blocks:
        print(f"  [{b['speaker']}->{b['addressee']}]: {b['ko']}")
        
    blocks = await run_final_tone_guardrail(job, blocks, mapper)
    
    print("\nAfter Guardrail:")
    for b in blocks:
        print(f"  [{b['speaker']}->{b['addressee']}]: {b['ko']}")
        
    print("\nLogs:")
    for log in job["logs"]:
        print(log)

if __name__ == "__main__":
    asyncio.run(main())
