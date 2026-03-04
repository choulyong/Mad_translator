"""
Pass 4.5: Semantic Integrity Validator (의미 무결성 검증기)

역할:
- 문맥 단절, 번역투의 잔재, 지나친 직역으로 인한 가독성 저하를 스캔
- SIV-1 ~ SIV-4 기준에 따라 어색한 문장을 네이티브 수준으로 교정
"""

import math
from typing import Dict, Any, List

from app.api.subtitles import get_vertex_ai
from app.core.k_cinematic_prompt import get_v6_2_siv_prompt


def _parse_siv_response(response_text: str, blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    SIV LLM 응답 파싱.

    Args:
        response_text: LLM 응답 텍스트
        blocks: 원본 블록 리스트

    Returns:
        [{index, text}, ...] 리스트
    """
    import json

    results = []
    try:
        # JSON 추출
        if "```json" in response_text:
            json_str = response_text.split("```json")[1].split("```")[0].strip()
        elif "```" in response_text:
            json_str = response_text.split("```")[1].split("```")[0].strip()
        else:
            start = response_text.find('{')
            end = response_text.rfind('}') + 1
            if start == -1:
                start = response_text.find('[')
                end = response_text.rfind(']') + 1
            if start == -1:
                return results
            json_str = response_text[start:end]

        data = json.loads(json_str)
        # V6.2 output is a direct array
        siv_results = data if isinstance(data, list) else data.get("siv_results", [])
        for item in siv_results:
            if isinstance(item, dict) and item.get("index") is not None:
                results.append({
                    "index": item["index"],
                    "text": item.get("text", ""),
                })
    except Exception as e:
        print(f"[Pass 4.5] Parse ERROR: {e}")
        pass
    return results


async def run_pass_4_5(
    job: Dict[str, Any],
    blocks: List[Dict[str, Any]],
    metadata: Dict[str, Any] = None,
) -> List[Dict[str, Any]]:
    """
    Pass 4.5: Semantic Integrity Validator 실행

    Args:
        job: 작업 저장소
        blocks: 자막 블록 리스트
        metadata: 메타데이터

    Returns:
        업데이트된 블록 리스트
    """
    job["current_pass"] = "Pass 4.5: 의미 무결성 검증"
    job["progress"] = 99
    job["logs"].append("> [Pass 4.5] 의미 무결성 검증 시작 (SIV-1 ~ SIV-4)...")

    metadata = metadata or {}
    title = metadata.get("title", "Unknown")
    genre = metadata.get("genre", "Drama")
    if isinstance(genre, list):
        genre = ", ".join(genre)

    lore_json = job.get("lore")
    system_prompt = get_v6_2_siv_prompt(title=title, genre=genre, lore_json=lore_json)
    translator = get_vertex_ai()

    # Pass 4.5은 문맥의 흐름이 중요하므로 전체 블록을 순서대로 스캔함.
    # 단, 번역된 텍스트가 있는 경우에만 처리대상
    valid_indices = [i for i, b in enumerate(blocks) if b.get("ko") and b["ko"].strip()]

    if not valid_indices:
        job["logs"].append("  ℹ [Pass 4.5] 스캔 대상 블록 없음")
        return blocks

    SIV_BATCH_SIZE = 30
    siv_total_fixed = 0
    num_batches = math.ceil(len(valid_indices) / SIV_BATCH_SIZE)

    for bi in range(num_batches):
        if job.get("cancelled"):
            break

        batch_idxs = valid_indices[bi * SIV_BATCH_SIZE:(bi + 1) * SIV_BATCH_SIZE]
        batch_blocks = [blocks[i] for i in batch_idxs]

        # 앞뒤 컨텍스트 포함하여 SIV에게 제공
        context_ids: set = set()
        for idx in batch_idxs:
            for ci in range(max(0, idx - 2), min(len(blocks), idx + 2)):
                if ci not in batch_idxs and blocks[ci].get("ko"):
                    context_ids.add(ci)

        lines = []
        if context_ids:
            lines.append("[CONTEXT - 참고용, 수정하지 말 것]")
            for ci in sorted(context_ids):
                cb = blocks[ci]
                c_en = cb.get("en", "").replace("\n", " ")
                c_ko = cb.get("ko", "").replace("\n", " ")
                lines.append(f"(ctx){cb.get('id')}: [EN] {c_en} | [KO] {c_ko}")
            lines.append("\n[TARGET - 아래 블록들의 어색한 번역을 교정하세요]")

        for b in batch_blocks:
            en = b.get("en", "").replace("\n", " ")
            ko = b.get("ko", "").replace("\n", " ")
            lines.append(f"{b.get('id')}: [EN] {en} | [KO] {ko}")
        
        user_content = "Input:\n" + "\n".join(lines)

        try:
            def make_siv_call(attempt=0, max_retries=3):
                return translator.client.models.generate_content(
                    model=translator.model,
                    contents=user_content,
                    config={
                        "system_instruction": system_prompt,
                        "max_output_tokens": 8192,
                        "temperature": 0.2, # 낮은 temperature로 톤 유지
                    }
                )

            import asyncio as _asyncio
            response, error = await _asyncio.to_thread(translator._retry_with_backoff, make_siv_call)
            
            if error or not response:
                job["logs"].append(f"  ⚠ [Pass 4.5 배치 {bi + 1}] LLM 호출 실패")
                continue

            parsed = _parse_siv_response(response.text, batch_blocks)
            batch_fixed = 0

            for item in parsed:
                if not item.get("text"):
                    continue
                target_id = item["index"]
                for block in blocks:
                    if block.get("id") == target_id:
                        old_ko = block.get("ko", "")
                        new_ko = item["text"].strip()
                        if new_ko and new_ko != old_ko:
                            block["ko"] = new_ko
                            batch_fixed += 1
                        break

            siv_total_fixed += batch_fixed
            if batch_fixed > 0:
                job["logs"].append(
                    f"  ✓ [Pass 4.5 배치 {bi + 1}/{num_batches}] {batch_fixed}개 SIV 교정됨"
                )

        except Exception as e:
            job["logs"].append(f"  ⚠ [Pass 4.5 배치 {bi + 1}] 오류: {str(e)[:80]}")

    if siv_total_fixed > 0:
        job["logs"].append(f"  ✅ [Pass 4.5] 총 {siv_total_fixed}개 문장 의미 무결성 교정 완료")
    else:
        job["logs"].append(f"  ℹ [Pass 4.5] 전체 구조 스캔 완료, 교정 필요 없음 (무결성 통과)")

    return blocks
