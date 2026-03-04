"""
Pass 3: Terminology Lock & Hard Postprocessing (V6)

역할:
- 금지어 치환 (빠른 Regex)
- 형태소/문장부호 통일 (빠른 Regex)
- [V6 핵심] LLM 기반 Terminology Lock (고유명사 무관용 강제)
"""

import re
import math
import asyncio
from typing import Dict, Any, List, Tuple

from app.api.subtitles import get_vertex_ai
from app.core.k_cinematic_prompt import get_v6_pass_3_terminology_prompt

# ═══ 빠른 Regex 교정 패턴 (V6용 최소화 유지) ═══
_TRANSLATIONESE_ENDINGS = [
    (re.compile(r'될\s?것입니다$'), '될 거예요'),
    (re.compile(r'할\s?것입니다$'), '할 거예요'),
    (re.compile(r'있을\s?것입니다$'), '있을 거예요'),
    (re.compile(r'없을\s?것입니다$'), '없을 거예요'),
    (re.compile(r'일\s?것입니다$'), '일 거예요'),
    (re.compile(r'([가-힣])\s?것입니다$'), lambda m: m.group(1) + ' 거예요'),
    (re.compile(r'하게 될 것입니다$'), '하게 될 거예요'),
    (re.compile(r'게 될 것입니다$'), '게 될 거예요'),
    (re.compile(r'주시기\s?바랍니다$'), '주세요'),
]

_TRANSLATIONESE_NOUNS = [
    (re.compile(r'초석'), '기반'),
    (re.compile(r'파트너십'), '협력'),
    (re.compile(r'목표치'), '목표'),
    (re.compile(r'프로세스'), '과정'),
    (re.compile(r'도전과제'), '도전'),
]

async def run_pass_3(
    job: Dict[str, Any],
    blocks: List[Dict[str, Any]],
    confirmed_levels: Dict[str, Dict[str, Any]] = None,
    character_relations: Dict[str, str] = None,
    strategy: Dict[str, Any] = None,
) -> List[Dict[str, Any]]:
    job["current_pass"] = "Pass 3: 용어 및 형태소 교정"
    job["progress"] = 95
    job["logs"].append("> [Pass 3] 용어/형태소 교정 중...")

    strategy = strategy or {}
    fixed_terms_list = strategy.get("fixed_terms", [])
    
    # 1. 빠른 형태소/금지어 교정 (Regex)
    stats = {"ellipsis": 0, "endings": 0, "nouns": 0}
    for block in blocks:
        text = block.get("ko", "")
        if not text:
            continue
            
        original_text = text
        
        # 금지어 하드코딩 치환
        for pat, rep in [(re.compile(r'생일\s?소년'), "오늘의 주인공"),
                         (re.compile(r'생일\s?소녀'), "오늘의 주인공"),
                         (re.compile(r'나쁜\s?남자'), "나쁜 놈"),
                         (re.compile(r'좋은\s?소녀'), "착한 아이")]:
            text = pat.sub(rep, text)
            
        # 괄호/마침표/과다 구두점
        text = re.sub(r"!\s*!+", "!", text)
        text = re.sub(r"\?\s*\?+", "?", text)
        if "…" in text or "..." in text:
            text = text.replace("...", "…").replace(".....", "…")
            stats["ellipsis"] += 1
            
        # 어미 교정
        for pattern, replacement in _TRANSLATIONESE_ENDINGS:
            if callable(replacement):
                m = pattern.search(text)
                if m:
                    text = text[:m.start()] + replacement(m)
                    stats["endings"] += 1
                    break
            else:
                new_text = pattern.sub(replacement, text)
                if new_text != text:
                    text = new_text
                    stats["endings"] += 1
                    break

        # 명사 교정
        for pattern, replacement in _TRANSLATIONESE_NOUNS:
            new_text = pattern.sub(replacement, text)
            if new_text != text:
                text = new_text
                stats["nouns"] += 1
                
        if text != original_text:
            block["ko"] = text

    # 2. V6 LLM 기반 Terminology Lock
    if not fixed_terms_list:
        job["logs"].append("> [Pass 3] 전략에 고유용어(Glossary)가 없어 LLM 용어 교정을 패스합니다.")
        job["progress"] = 98
        return blocks

    # Glossary 텍스트화
    glossary_lines = []
    for term in fixed_terms_list:
        en = term.get("original", "").strip()
        ko = term.get("translation", "").strip()
        if en and ko:
            glossary_lines.append(f"- {en} -> {ko}")
            
    if not glossary_lines:
        job["progress"] = 98
        return blocks
        
    glossary_str = "\n".join(glossary_lines)
    system_prompt = get_v6_pass_3_terminology_prompt(glossary_str)
    
    # 전략: 전체 블록을 검사할 필요 없이, 영어(en) 원문에 glossary 단어가 포함된 블록만 선별!
    candidate_indices = []
    for i, b in enumerate(blocks):
        en_text = b.get("en", "").lower()
        if not en_text: continue
        
        has_term = False
        for term in fixed_terms_list:
            original = term.get("original", "").strip().lower()
            if original and original in en_text:
                has_term = True
                break
        if has_term:
            candidate_indices.append(i)

    if not candidate_indices:
        job["logs"].append("> [Pass 3] 번역본 내에 Glossary 대상 단어가 발견되지 않았습니다.")
        job["progress"] = 98
        return blocks

    job["logs"].append(f"  🔍 [Pass 3] {len(candidate_indices)}개 블록에서 고유용어 발견 → LLM(Terminology Lock) 가동")
    
    translator = get_vertex_ai()
    BATCH_SIZE = 30
    num_batches = math.ceil(len(candidate_indices) / BATCH_SIZE)
    term_total_fixed = 0
    
    for bi in range(num_batches):
        if job.get("cancelled"):
            break
            
        batch_idxs = candidate_indices[bi * BATCH_SIZE:(bi + 1) * BATCH_SIZE]
        batch_blocks = [blocks[i] for i in batch_idxs]
        
        lines = []
        for b in batch_blocks:
            en = b.get("en", "").replace("\n", " ")
            ko = b.get("ko", "").replace("\n", " ")
            lines.append(f"{b.get('id')}: [EN] {en} | [KO] {ko}")
            
        user_content = "Input:\n" + "\n".join(lines)
        
        try:
            def make_term_call():
                return translator.client.models.generate_content(
                    model=translator.model,
                    contents=user_content,
                    config={
                        "system_instruction": system_prompt,
                        "max_output_tokens": 8192,
                        "temperature": 0.1,
                    }
                )

            import asyncio as _asyncio
            response, error = await _asyncio.to_thread(translator._retry_with_backoff, make_term_call)
            
            if error or not response:
                job["logs"].append(f"  ⚠ [Pass 3 배치 {bi + 1}] LLM 호출 실패")
                continue
                
            # JSON Parse (using custom parser inline)
            import json
            resp_text = response.text
            parsed = []
            try:
                if "```json" in resp_text:
                    resp_text = resp_text.split("```json")[1].split("```")[0]
                elif "```" in resp_text:
                    resp_text = resp_text.split("```")[1].split("```")[0]
                else:
                    s = resp_text.find('[')
                    e = resp_text.rfind(']') + 1
                    if s != -1:
                        resp_text = resp_text[s:e]
                
                parsed = json.loads(resp_text)
            except:
                pass
                
            batch_fixed = 0
            for item in parsed:
                if isinstance(item, dict) and "index" in item and "text" in item:
                    target_id = item["index"]
                    for block in blocks:
                        if block.get("id") == target_id:
                            old_ko = block.get("ko", "")
                            new_ko = item["text"].strip()
                            if new_ko and new_ko != old_ko:
                                block["ko"] = new_ko
                                batch_fixed += 1
                            break
                            
            term_total_fixed += batch_fixed
            
        except Exception as e:
            job["logs"].append(f"  ⚠ [Pass 3 배치 {bi + 1}] 오류: {str(e)[:80]}")
            
    if term_total_fixed > 0:
        job["logs"].append(f"  ✅ [Pass 3] 총 {term_total_fixed}건 용어 일관성 규칙(Terminology Lock) 적용 완료")
    else:
        job["logs"].append(f"  ℹ [Pass 3] 용어 검증 완료 (위반 항목 없음)")

    job["progress"] = 98
    job["logs"].append("> [Pass 3] 완료")
    return blocks
