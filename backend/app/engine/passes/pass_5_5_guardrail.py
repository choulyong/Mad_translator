import asyncio
import re
from app.services.vertex_ai import VertexTranslator
from app.core.tone_mapper import RelationToneMapper

def sanitize_pronouns(text: str, target_tone: str) -> str:
    """물리적 대명사 강제 통제/치환 로직 (Pronoun Annihilation)"""
    if not text: return text
    
    # 그녀 처리 (그 애)
    text = re.sub(r'(?<![가-힣])그녀가(?![가-힣])', '그 애가', text)
    text = re.sub(r'(?<![가-힣])그녀는(?![가-힣])', '그 애는', text)
    text = re.sub(r'(?<![가-힣])그녀를(?![가-힣])', '그 애를', text)
    text = re.sub(r'(?<![가-힣])그녀에게(?![가-힣])', '그 애한테', text)
    text = re.sub(r'(?<![가-힣])그녀의(?![가-힣])', '그 애의', text)
    text = re.sub(r'(?<![가-힣])그녀도(?![가-힣])', '그 애도', text)
    text = re.sub(r'(?<![가-힣])그녀(?![가-힣])', '그 애', text)
    
    # 당신 처리
    if target_tone == 'banmal':
        text = re.sub(r'(?<![가-힣])당신이(?![가-힣])', '네가', text)
        text = re.sub(r'(?<![가-힣])당신은(?![가-힣])', '너는', text)
        text = re.sub(r'(?<![가-힣])당신을(?![가-힣])', '너를', text)
        text = re.sub(r'(?<![가-힣])당신에게(?![가-힣])', '너에게', text)
        text = re.sub(r'(?<![가-힣])당신의(?![가-힣])', '네', text)
        text = re.sub(r'(?<![가-힣])당신도(?![가-힣])', '너도', text)
        text = re.sub(r'(?<![가-힣])당신(?![가-힣])', '너', text)
    else:
        # 존댓말일 경우 '당신' 삭제. 삭제 시 띄어쓰기 붕괴 방지를 위해 뒤의 공백까지 묶어 삭제.
        text = re.sub(r'(?<![가-힣])당신이\s*', '', text)
        text = re.sub(r'(?<![가-힣])당신은\s*', '', text)
        text = re.sub(r'(?<![가-힣])당신을\s*', '', text)
        text = re.sub(r'(?<![가-힣])당신에게\s*', '', text)
        text = re.sub(r'(?<![가-힣])당신의\s*', '', text)
        text = re.sub(r'(?<![가-힣])당신도\s*', '', text)
        text = re.sub(r'(?<![가-힣])당신\s*', '', text)
        
    # 그가 처리 (그놈)
    text = re.sub(r'(?<![가-힣])그가(?![가-힣])', '그놈이', text)
    text = re.sub(r'(?<![가-힣])그는(?![가-힣])', '그놈은', text)
    text = re.sub(r'(?<![가-힣])그를(?![가-힣])', '그놈을', text)
    text = re.sub(r'(?<![가-힣])그에게(?![가-힣])', '그놈에게', text)
    text = re.sub(r'(?<![가-힣])그의(?![가-힣])', '그놈의', text)
    text = re.sub(r'(?<![가-힣])그도(?![가-힣])', '그놈도', text)
    
    # 이중 공백 통일
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def check_tone_violation(ko_text: str, target_tone: str) -> bool:
    """하드코딩된 종결어미 검사기"""
    ko_clean = re.sub(r'[^\w\s]', '', ko_text).strip()
    if not ko_clean:
        return False
        
    ends_with_honorific = ko_clean.endswith("요") or ko_clean.endswith("니다") or ko_clean.endswith("까") or ko_clean.endswith("시죠")
    ends_with_banmal = (
        ko_clean.endswith("어") or 
        ko_clean.endswith("지") or 
        ko_clean.endswith("야") or 
        ko_clean.endswith("군") or 
        ko_clean.endswith("냐") or
        (ko_clean.endswith("다") and not ko_clean.endswith("니다"))
    )
    
    if target_tone == "banmal" and ends_with_honorific:
        return True
    elif target_tone == "honorific" and ends_with_banmal:
        return True
        
    return False

async def run_final_tone_guardrail(job: dict, blocks: list, tone_mapper: RelationToneMapper) -> list:
    """
    [Task C] LLM 기반 FinalToneGuardrail
    기존의 기계적 정규식(Regex Bomber)을 완전히 대체하는 초경량 LLM 패스.
    RelationToneMapper의 기준에 어긋나는 블록만 식별하여 '매끄럽게 어미만 다듬도록' 지시한다.
    실패 시 While Loop 방어막을 통해 재시도(Retry)한다.
    """
    job["logs"].append(f"  🛡️ [Pass 5.5] Final Tone Guardrail 스캔 시작...")
    
    # 1. Inspect
    suspicious_blocks = []
    
    for b in blocks:
        ko = b.get("ko", "").strip()
        speaker = b.get("speaker")
        addressee = b.get("addressee")
        start_time = b.get("start") # 타임스탬프 기반 톤 매퍼용
        
        if not ko or not speaker:
            continue
            
        target_tone = tone_mapper.get_tone(speaker, addressee, start_time)
        
        if check_tone_violation(ko, target_tone):
            suspicious_blocks.append({
                "block": b,
                "target_tone": target_tone,
                "original_ko": ko
            })

    if not suspicious_blocks:
        job["logs"].append(f"  ✓ [Pass 5.5] 톤 위반 의심 블록 없음. (Pass)")
        return blocks

    job["logs"].append(f"  ⚠ [Pass 5.5] 톤 위반 의심 블록 {len(suspicious_blocks)}개 감지. LLM 교정 시작...")

    # 2. LLM Fix
    translator = VertexTranslator()

    base_prompt = """You are the FINAL subtitle quality gate for a Korean subtitle translation pipeline.

The subtitle line you receive is already translated and almost final.
Your task is NOT to translate and NOT to rewrite the sentence.

Your ONLY job is to enforce tone consistency between characters.

The target tone rule (speaker → addressee) is provided.
If the sentence ending violates the required tone, correct ONLY the ending.

━━━━━━━━━━━━━━━━━━
ABSOLUTE RULES
━━━━━━━━━━━━━━━━━━

1. No Re-Translation
Do NOT translate the line again.
Do NOT reinterpret the meaning.

2. Meaning Preservation (Critical)
The meaning must remain IDENTICAL.
Do not add or remove information.

3. Minimal Edit Policy
Modify the smallest possible number of characters.
Prefer changing ONLY the sentence ending.

4. Do NOT change:
- nouns
- verbs
- subjects
- objects
- worldbuilding terms
- character names
- terminology

5. ZERO-TOLERANCE TONE ENFORCEMENT (CRITICAL)
You MUST enforce the Target Tone with ZERO exceptions.
Do NOT allow sudden emotional shifts (e.g., anger, intense battle, sadness) or intimacy to break or override the Target Tone.
The Target Tone mapping is ABSOLUTE throughout the entire timeline.
If Target Tone is POLITE (존댓말), even if the characters become close or the situation is life-threatening, the ending MUST be polite (e.g., "티아라고 부르세요" NOT "티아라고 불러도 돼").
If the sentence ending violates the required tone, you must ruthlessly correct it.

6. Tone Endings Guide
If Target Tone = INFORMAL (반말):
Allowed endings include examples such as:
다 / 해 / 하지 / 하지마 / 해라 / 군 / 네 / 지

If Target Tone = POLITE (존댓말):
Allowed endings include examples such as:
요 / 합니다 / 합니다만 / 입니다 / 하세요 / 죠 / 군요

Only adjust the ending if the tone is wrong.

6. Subtitle Naturalness
Keep the sentence concise and natural for spoken Korean subtitles.
Do NOT expand the sentence.

7. Hallucination Prevention
You MUST NOT introduce new words that are not already present in the line.

8. Output Format
Return ONLY the corrected Korean subtitle line.
No explanations. No JSON. No markdown ticks.
"""

    async def process_single_block(sb):
        MAX_RETRIES = 3
        last_ko_attempt = sb['original_ko']
        
        loop = asyncio.get_event_loop()
        
        for attempt in range(MAX_RETRIES):
            target_rule = "INFORMAL (반말)" if sb["target_tone"] == "banmal" else "POLITE (존댓말)"
            
            prompt = base_prompt + f"\n━━━━━━━━━━━━━━━━━━\nINPUT\n━━━━━━━━━━━━━━━━━━\n\nTarget Tone:\n{target_rule}\n\nSubtitle Line:\n{sb['original_ko']}\n"
            
            if attempt > 0:
                prompt += f"\n[System Error: 타겟 톤 위반. 종결어미를 규칙({target_rule})에 맞게 즉시 수정하라]\n이전 실패한 결과: {last_ko_attempt}\n"
                
            prompt += "\n━━━━━━━━━━━━━━━━━━\nOUTPUT\n━━━━━━━━━━━━━━━━━━\n\nReturn ONLY the corrected Korean subtitle line.\n"
            
            try:
                response = await loop.run_in_executor(
                    None, 
                    lambda: translator.client.models.generate_content(
                        model=translator.model,
                        contents=prompt,
                        config={"temperature": 0.0}
                    )
                )
                corrected_text = response.text.strip()
                
                if corrected_text:
                    # Guardrail Check - Again
                    if not check_tone_violation(corrected_text, sb["target_tone"]):
                        # Success
                        if sb["block"]["ko"] != corrected_text:
                            sb["block"]["ko"] = corrected_text
                            return 1
                        return 0
                    else:
                        # Failed again
                        print(f"  [Pass 5.5] Tone violation loop triggered (Attempt {attempt+1}/{MAX_RETRIES}): '{corrected_text}' violated '{target_rule}'")
                        last_ko_attempt = corrected_text
            except Exception as e:
                print(f"[ERROR Guardrail] {e}")
                
        return 0 # MAX_RETRIES 소진

    results = await asyncio.gather(*(process_single_block(sb) for sb in suspicious_blocks))
    fix_count = sum(results)

    # ==========================================
    # 3. 최후의 물리적 대명사 세탁 (Pronoun Annihilation)
    # LLM 의존도 0%로 강제 치환
    # ==========================================
    sanitize_count = 0
    for b in blocks:
        ko = b.get("ko", "").strip()
        if not ko: continue
        
        speaker = b.get("speaker")
        addressee = b.get("addressee")
        start_time = b.get("start")
        
        target_tone = "honorific"
        if speaker:
            target_tone = tone_mapper.get_tone(speaker, addressee, start_time)
            
        sanitized_ko = sanitize_pronouns(ko, target_tone)
        if sanitized_ko != ko:
            b["ko"] = sanitized_ko
            sanitize_count += 1

    job["logs"].append(f"  🛡️ [Pass 5.5] Final Tone Guardrail — {fix_count}개 톤 교정 완료 (결정론적 락 적용 완료)")
    if sanitize_count > 0:
        job["logs"].append(f"  🔪 [Pass 5.5] Pronoun Annihilation — {sanitize_count}개 물리적 대명사 강제 치환 완료")
        
    return blocks
