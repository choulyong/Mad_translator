import json
import math
import re
from typing import List, Dict, Any

from app.api.subtitles import get_vertex_ai


def get_pass_5_polish_prompt() -> str:
    """Pass 5: Risk-Gated Micro-Polish 전용 프롬프트."""
    return """You are a final polishing editor for Korean subtitles.
Your job is to fix unnatural phrasing ONLY if you are 100% sure it improves readability without changing the tone or meaning.

━━━━━━━━━━━━━━━━━━
ABSOLUTE RULES
━━━━━━━━━━━━━━━━━━

1. Do NOT change the tone (~어, ~요).
2. Fix awkward spacing, typos, and clumsy grammar.
3. If the Korean text is already natural, RETURN IT EXACTLY AS IS. Do not over-correct.

Output ONLY a JSON array of the corrected lines:
[{"index": 1, "text": "Corrected line"}]
"""


def _parse_polish_response(response_text: str) -> List[Dict[str, Any]]:
    """LLM 응답에서 배열 파싱"""
    results = []
    try:
        if "```json" in response_text:
            json_str = response_text.split("```json")[1].split("```")[0].strip()
        elif "```" in response_text:
            json_str = response_text.split("```")[1].split("```")[0].strip()
        else:
            start = response_text.find('[')
            end = response_text.rfind(']') + 1
            if start == -1:
                return results
            json_str = response_text[start:end]

        data = json.loads(json_str)
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    idx = item.get("index", item.get("id"))
                    text = item.get("text", item.get("ko", ""))
                    if idx is not None:
                        results.append({
                            "id": idx,
                            "ko": text.strip(),
                        })
    except Exception as e:
        print(f"[Pass 5] JSON Parse Error: {e}")
    return results


async def run_final_polish(
    job: Dict[str, Any],
    blocks: List[Dict[str, Any]],
    metadata: Dict[str, Any] = None,
) -> List[Dict[str, Any]]:
    """
    Pass 5: Risk-Gated Micro-Polish & Rollback Gate 실행
    """
    job["current_pass"] = "Pass 5: 마이크로 폴리싱 (부분 윤문)"
    job["progress"] = 92
    job["logs"].append("> [Pass 5] 위험군 자막 탐지 및 마이크로 폴리싱 시작...")

    # --- Task A: Python-based Risk Scorer ---
    risk_blocks = []
    translationese_re = re.compile(r"\b(당신|그는|그녀는|나의|우리의)\b")
    
    for i, block in enumerate(blocks):
        ko = str(block.get("ko") or "").strip()
        if not ko:
            continue
            
        is_risk = False
        
        # 1. CPS 임계치 위험
        max_chars = block.get("max_chars")
        if max_chars and max_chars > 0:
            if len(ko) / max_chars >= 0.95:
                is_risk = True
                
        # 2. 어미 기계적 반복 (마지막 2글자)
        if not is_risk and i > 0 and len(ko) >= 2:
            prev_block = blocks[i-1]
            prev_ko = str(prev_block.get("ko") or "").strip()
            if len(prev_ko) >= 2 and ko[-2:] == prev_ko[-2:]:
                is_risk = True
                
        # 3. 잔존 번역투
        if not is_risk and translationese_re.search(ko):
            is_risk = True
            
        if is_risk:
            # Context 수집
            context_prev = str(blocks[i-1].get("ko") or "") if i > 0 else ""
            context_next = str(blocks[i+1].get("ko") or "") if i < len(blocks)-1 else ""
            risk_payload = {
                "id": block.get("id", block.get("index")),
                "max_chars": max_chars or 0,
                "context_prev": context_prev,
                "current_ko": ko,
                "context_next": context_next,
                "original_max_chars": max_chars, # Rollback 용
                "old_ko": ko # Rollback 용
            }
            risk_blocks.append(risk_payload)

    if not risk_blocks:
        job["logs"].append("  ✅ [Pass 5] 위험군으로 탐지된 자막이 없습니다. (완벽한 상태) 스킵합니다.")
        job["progress"] = 97
        return blocks
        
    job["logs"].append(f"  🔍 [Pass 5] 전체 {len(blocks)}개 중 {len(risk_blocks)}개의 위험군 자막 블록 탐지됨.")

    # --- Task B: LLM Micro-Polish 프롬프트 및 배칭 ---
    POLISH_BATCH_SIZE = 30
    system_prompt = get_pass_5_polish_prompt()
    translator = get_vertex_ai()

    num_batches = math.ceil(len(risk_blocks) / POLISH_BATCH_SIZE)
    total_polished = 0
    total_rollbacks = 0

    async def process_batch(bi: int, batch: List[Dict[str, Any]]) -> Dict[str, Any]:
        lines = []
        for b in batch:
            payload = {
                "id": b["id"],
                "max_chars": b["max_chars"],
                "context_prev": b["context_prev"],
                "current_ko": b["current_ko"],
                "context_next": b["context_next"]
            }
            lines.append(json.dumps(payload, ensure_ascii=False))
            
        user_content = "Input:\n" + "\n".join(lines)

        try:
            def make_polish_call():
                return translator.client.models.generate_content(
                    model=translator.model,
                    contents=user_content,
                    config={
                        "system_instruction": system_prompt,
                        "temperature": 0.1, 
                        "response_mime_type": "application/json"
                    }
                )

            import asyncio as _asyncio
            response = await _asyncio.to_thread(make_polish_call)
            
            res_text = response.text
            updates = _parse_polish_response(res_text)
            
            return {"bi": bi, "updates": updates, "batch": batch, "error": None}
            
        except Exception as e:
            return {"bi": bi, "updates": [], "batch": batch, "error": str(e)}

    # 태스크 목록 생성
    tasks = []
    for bi in range(num_batches):
        batch = risk_blocks[bi * POLISH_BATCH_SIZE:(bi + 1) * POLISH_BATCH_SIZE]
        tasks.append(process_batch(bi, batch))

    # 병렬 실행 (await asyncio.gather)
    job["logs"].append(f"  ⚡ [Pass 5] {num_batches}개 배치 병렬 미세 폴리싱 중...")
    import asyncio
    results = await asyncio.gather(*tasks)

    # Dictionary for O(1) glossary check preparation
    strategy = job.get("strategy", {})
    fixed_terms = strategy.get("fixed_terms", {})
    
    # 결과 취합 및 상태 업데이트 (Rollback Gate 적용)
    for res in results:
        if job.get("cancelled"):
            break
            
        if res["error"]:
            job["logs"].append(f"  ❌ [Pass 5] Batch {res['bi']+1} LLM 에러 (전체 롤백): {res['error']}")
            total_rollbacks += len(res['batch'])
            continue

        updates = {u["id"]: u for u in res["updates"]}
        batch_items = {b["id"]: b for b in res["batch"]}
        
        for item_id, original_item in batch_items.items():
            old_ko = original_item["old_ko"]
            max_chars = original_item["original_max_chars"]
            
            # --- Task C: Rollback Gate ---
            update_item = updates.get(item_id)
            
            # 3. 구조 훼손: JSON 파싱 실패 또는 ID 누락
            if not update_item or not update_item.get("ko"):
                total_rollbacks += 1
                continue
                
            new_ko = update_item["ko"].strip()
            
            # 1. 길이 초과
            if max_chars and max_chars > 0 and len(new_ko) > max_chars:
                total_rollbacks += 1
                continue
                
            # 2. 의미 훼손 방지(고유명사)
            glossary_dropped = False
            for term, term_data in fixed_terms.items():
                if isinstance(term_data, dict):
                    trans = term_data.get("translation", "")
                else:
                    trans = term_data
                    
                if trans and trans in old_ko and trans not in new_ko:
                    glossary_dropped = True
                    break
                    
            if glossary_dropped:
                total_rollbacks += 1
                continue

            # 여기까지 통과한 경우에만 실제 블록에 덮어쓰기
            if new_ko != old_ko:
                target_block = next((b for b in blocks if b.get("id") == item_id or b.get("index") == item_id), None)
                if target_block:
                    target_block["ko"] = new_ko
                    total_polished += 1

    job["progress"] = 97
    job["logs"].append(f"> [Pass 5] 마이크로 폴리싱 완료 (수정: {total_polished} / 롤백 방어: {total_rollbacks})")
    return blocks
