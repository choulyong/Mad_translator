"""
Pass 2: QC & Deduplication — 품질 검증 및 중복 제거

역할:
- 중복 자막 감지 및 재번역
- LLM-as-Judge QC (선택적)
- 번역투 제거
"""

import asyncio
import math
import re
from typing import Dict, Any, List

from app.engine.utils import detect_dedup, check_qc_needed

# [번역 실패: ...] 패턴 감지
_FAIL_PATTERN = re.compile(r'^\[번역\s*실패')
from app.api.subtitles import (
    translate_single_batch,
    _compute_block_duration,
    _compute_max_chars,
    _sanitize_subtitle_text,
    _detect_side_talk,
    _parse_translation_response,
    _remove_translationese,
    remove_periods,
    get_vertex_ai,
    get_v5_qc_prompt,
)


async def run_pass_2(
    job: Dict[str, Any],
    blocks: List[Dict[str, Any]],
    metadata: Dict[str, Any],
    strategy: Dict[str, Any],
    character_relations: Dict[str, str],
    confirmed_levels: Dict[str, Dict[str, Any]],
    include_qc: bool = True,
) -> List[Dict[str, Any]]:
    """
    Pass 2: QC & Deduplication 실행

    Args:
        job: 작업 저장소
        blocks: 자막 블록 리스트
        metadata: 메타데이터
        strategy: 번역 전략
        character_relations: 화자 관계
        confirmed_levels: 확정 말투 레벨
        include_qc: QC 포함 여부

    Returns:
        업데이트된 블록 리스트
    """
    job["current_pass"] = "Pass 2: QC 및 중복 제거"
    job["progress"] = 85
    job["logs"].append("> [Pass 2] QC 및 중복 제거 시작...")

    title = metadata.get("title", "Unknown")
    genre = metadata.get("genre", "Drama")
    if isinstance(genre, list):
        genre = ", ".join(genre)

    # ═══ [번역 실패] 블록 분류 처리 ═══
    fail_indices = [i for i, b in enumerate(blocks) if _FAIL_PATTERN.match(b.get("ko", ""))]
    if fail_indices:
        covered_indices = []
        retranslate_indices = []

        for i in fail_indices:
            # 앞 1~2개 블록 중 번역 완료된 블록 있으면 "커버됨" 판정
            prev_translated = any(
                blocks[prev_i].get("ko") and not _FAIL_PATTERN.match(blocks[prev_i].get("ko", ""))
                for prev_i in range(max(0, i - 2), i)
            )
            if prev_translated:
                covered_indices.append(i)
            else:
                retranslate_indices.append(i)

        # 커버됨 → 빈 문자열 (SRT에서 해당 타임슬롯 공백 처리)
        for i in covered_indices:
            blocks[i]["ko"] = ""

        job["logs"].append(
            f"  🔍 [Pass 2] 번역 실패 {len(fail_indices)}개 분류: "
            f"커버됨 {len(covered_indices)}개 → 제거, "
            f"진짜 실패 {len(retranslate_indices)}개 → 재번역"
        )

        # 진짜 실패 → 재번역
        if retranslate_indices and len(retranslate_indices) <= 100:
            async def retranslate_fail(idx: int):
                if job.get("cancelled"):
                    return
                block = blocks[idx]
                en_text = block.get("en", "")
                if not en_text:
                    blocks[idx]["ko"] = ""
                    return

                blocks[idx]["ko"] = ""  # 실패 텍스트 제거

                prev_context = [
                    {
                        "index": b.get("id"),
                        "original": b.get("en", ""),
                        "translated": b.get("ko", ""),
                    }
                    for b in blocks[max(0, idx - 3):idx]
                    if b.get("ko") and not _FAIL_PATTERN.match(b.get("ko", ""))
                ]

                duration = _compute_block_duration(block)
                api_block = {
                    "index": block.get("id"),
                    "start": block.get("start", ""),
                    "end": block.get("end", ""),
                    "text": _sanitize_subtitle_text(en_text),
                    "speaker": block.get("speaker"),
                    "addressee": block.get("addressee"),
                    "duration_sec": duration,
                    "max_chars": _compute_max_chars(duration),
                }

                context = {
                    "title": title,
                    "synopsis": metadata.get("detailed_plot", "")[:300],
                    "genre": genre,
                    "personas": strategy.get("character_personas", []),
                    "prev_context": prev_context,
                    "character_relations": character_relations,
                    "confirmed_speech_levels": confirmed_levels,
                }

                try:
                    results = await translate_single_batch([api_block], context)
                    if results and results[0].get("text"):
                        blocks[idx]["ko"] = results[0]["text"]
                except Exception:
                    pass

            await asyncio.gather(
                *(retranslate_fail(i) for i in retranslate_indices),
                return_exceptions=True,
            )
            success = sum(
                1 for i in retranslate_indices
                if blocks[i].get("ko") and not _FAIL_PATTERN.match(blocks[i].get("ko", ""))
            )
            job["logs"].append(f"  ✓ [Pass 2] 실패 재번역: {success}/{len(retranslate_indices)}개 성공")

    # ═══ 중복 감지 및 재번역 ═══
    dedup_indices = detect_dedup(blocks)
    if dedup_indices:
        job["logs"].append(f"  🔧 [Pass 2] 연속 중복 {len(dedup_indices)}개 감지 → 재번역")

        # 중복 블록 비우기
        for di in dedup_indices:
            blocks[di]["ko"] = ""

        # 재번역
        if len(dedup_indices) <= 50:
            async def retranslate_dedup(idx: int):
                if job.get("cancelled"):
                    return
                block = blocks[idx]
                en_text = block.get("en", "")
                prev_context = [
                    {
                        "index": b.get("id"),
                        "original": b.get("en", ""),
                        "translated": b.get("ko", "")
                    }
                    for b in blocks[max(0, idx - 3):idx]
                    if b.get("ko")
                ]
                next_context = [
                    {
                        "index": b.get("id"),
                        "original": b.get("en", ""),
                        "translated": b.get("ko", "")
                    }
                    for b in blocks[idx + 1:min(len(blocks), idx + 3)]
                    if b.get("ko")
                ]

                duration = _compute_block_duration(block)
                api_block = {
                    "index": block.get("id"),
                    "start": block.get("start", ""),
                    "end": block.get("end", ""),
                    "text": _sanitize_subtitle_text(en_text),
                    "speaker": block.get("speaker"),
                    "addressee": block.get("addressee"),
                    "duration_sec": duration,
                    "max_chars": _compute_max_chars(duration),
                }

                context = {
                    "title": title,
                    "synopsis": metadata.get("detailed_plot", "")[:300],
                    "genre": genre,
                    "personas": strategy.get("character_personas", []),
                    "prev_context": prev_context + next_context,
                    "character_relations": character_relations,
                    "confirmed_speech_levels": confirmed_levels,
                }

                try:
                    results = await translate_single_batch([api_block], context)
                    if results and results[0].get("text"):
                        blocks[idx]["ko"] = results[0]["text"]
                except Exception:
                    pass

            # 병렬 재번역
            await asyncio.gather(
                *(retranslate_dedup(di) for di in dedup_indices),
                return_exceptions=True
            )
            job["logs"].append(f"  ✓ [Pass 2] 중복 재번역 완료")

    job["progress"] = 90

    # ═══ LLM-as-Judge QC ═══
    if not job.get("cancelled") and include_qc:
        translated_blocks = [b for b in blocks if b.get("ko") and b["ko"].strip()]
        if translated_blocks:
            # QC 필요 여부 판단
            qc_needed, qc_reason = check_qc_needed(translated_blocks, confirmed_levels)
            if not qc_needed:
                job["logs"].append(f"  ℹ [QC] 스킵 — {qc_reason}")
                return blocks

            job["logs"].append(f"> [Pass 2] LLM-as-Judge QC — {len(translated_blocks)}개 블록 교정 중...")

            qc_batch_size = 30
            qc_total = math.ceil(len(blocks) / qc_batch_size)
            qc_applied = 0
            translator = get_vertex_ai()

            async def qc_batch(qi: int) -> int:
                if job.get("cancelled"):
                    return 0
                qc_start = qi * qc_batch_size
                qc_end = min(qc_start + qc_batch_size, len(blocks))
                qc_blocks = blocks[qc_start:qc_end]

                if not any(b.get("ko") and b["ko"].strip() for b in qc_blocks):
                    return 0

                try:
                    # QC 페이로드 구성
                    source_lines = []
                    for b in qc_blocks:
                        has_korean = b.get("ko") and any('\uac00' <= c <= '\ud7a3' for c in b.get("ko", ""))
                        text = b.get("ko") if has_korean else f"[번역실패: {b.get('en', '')[:20]}]"
                        source_lines.append(f"{b.get('id')}: {text}")
                    source_payload = "\n".join(source_lines)

                    # character_personas 주입 (캐릭터 말투 강제)
                    personas = strategy.get("character_personas", [])
                    user_prompt = f"Input:\n{source_payload}"
                    # character_relations Dict → 문자열 변환 후 QC 프롬프트에 주입
                    relations_str = (
                        "\n".join(f"{k}: {v}" for k, v in character_relations.items())
                        if isinstance(character_relations, dict) and character_relations
                        else str(character_relations) if character_relations
                        else ""
                    )
                    system_instruction = get_v5_qc_prompt(
                        title=title,
                        genre=genre,
                        character_relations=relations_str,
                        confirmed_speech_levels=confirmed_levels,
                    )

                    def make_qc_call(attempt=0, max_retries=3):
                        return translator.client.models.generate_content(
                            model=translator.model,
                            contents=user_prompt,
                            config={
                                "system_instruction": system_instruction,
                                "max_output_tokens": 32768,
                                "temperature": 0.3,
                            }
                        )

                    import asyncio as _asyncio
                    response, error = await _asyncio.to_thread(translator._retry_with_backoff, make_qc_call)
                    if error or not response:
                        return 0

                    parsed = _parse_translation_response(response.text, qc_blocks)

                    # 번역투 제거
                    for item in parsed:
                        if item.get("text"):
                            item["text"] = _remove_translationese(item["text"])
                            item["text"] = remove_periods(item["text"])

                    # 결과 적용
                    batch_fixed = 0
                    for corr in parsed:
                        bi = next((i for i, b in enumerate(blocks) if b.get("id") == corr["index"]), None)
                        if bi is not None and corr.get("text") and corr["text"].strip():
                            if corr["text"] != blocks[bi].get("ko"):
                                blocks[bi]["ko"] = corr["text"]
                                batch_fixed += 1

                    job["logs"].append(f"    ✓ [QC {qi + 1}/{qc_total}] {batch_fixed}개 교정됨" if batch_fixed > 0 else f"    ✓ [QC {qi + 1}/{qc_total}] 교정 없음")
                    return batch_fixed

                except Exception as e:
                    job["logs"].append(f"  ⚠ [QC {qi + 1}] 실패: {str(e)[:50]}")
                    return 0

            # QC 배치 병렬 처리
            CONCURRENCY = 7
            for gi in range(0, qc_total, CONCURRENCY):
                if job.get("cancelled"):
                    break
                group_end = min(gi + CONCURRENCY, qc_total)
                group_results = await asyncio.gather(
                    *(qc_batch(i) for i in range(gi, group_end)),
                    return_exceptions=True
                )
                for r in group_results:
                    if isinstance(r, int):
                        qc_applied += r
                job["progress"] = 90 + int(((group_end) / qc_total) * 5)

            job["logs"].append(f"  ✓ [Pass 2] QC 완료 — {qc_applied}개 교정됨")

    job["progress"] = 95
    job["logs"].append("> [Pass 2] 완료")

    return blocks
