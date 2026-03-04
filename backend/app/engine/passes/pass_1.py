"""
Pass 1: Main Translation - 메인 번역 (시맨틱 배칭 + Staggered Parallel)

역할:
- 시맨틱 배칭으로 자막 분할
- Staggered Parallel (5 동시 + 순차 문맥 유지)
- 배치별 병렬 번역
- 실시간 결과 반영
"""

import asyncio
import math
from typing import Dict, Any, List, Optional, Tuple

from app.engine.utils import (
    apply_hard_binding,
    build_semantic_batches,
    postprocess_translations,
    extract_tone_from_batch,
    update_confirmed_speech_levels,
)
from app.api.subtitles import (
    translate_single_batch,
    _compute_block_duration,
    _compute_max_chars,
    _sanitize_subtitle_text,
    _detect_side_talk,
)


async def run_pass_1(
    job: Dict[str, Any],
    blocks: List[Dict[str, Any]],
    metadata: Dict[str, Any],
    strategy: Dict[str, Any],
    character_relations: Dict[str, str],
    confirmed_levels: Dict[str, Dict[str, Any]],
    translator,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """
    Pass 1: Main Translation 실행

    Args:
        job: 작업 저장소
        blocks: 자막 블록 리스트
        metadata: 메타데이터
        strategy: 번역 전략
        character_relations: 화자 관계
        confirmed_levels: 확정 말투 레벨
        translator: Vertex AI translator

    Returns:
        (updated_blocks, tone_memory, updated_confirmed_levels)
    """
    job["current_pass"] = "Pass 1: 메인 번역"
    job["progress"] = 20
    job["logs"].append("> [Pass 1] 시맨틱 배칭 시작...")

    # 메타데이터 준비
    title = metadata.get("title", "Unknown")
    genre = metadata.get("genre", "Drama")
    if isinstance(genre, list):
        genre = ", ".join(genre)
    synopsis = metadata.get("detailed_plot", "") or metadata.get("synopsis", "")

    # 페르소나 정보
    personas_list = strategy.get("character_personas", [])
    persona_names = [p.get("name", "") for p in personas_list if isinstance(p, dict)]
    fixed_terms = ", ".join(
        f"{t.get('original', '')} → {t.get('translation', '')}"
        for t in strategy.get("fixed_terms", [])
        if isinstance(t, dict)
    )
    translation_rules = strategy.get("translation_rules", "")

    # ═══ Hard Binding ═══
    blocks_before = len(blocks)
    blocks = apply_hard_binding(blocks)
    if len(blocks) < blocks_before:
        job["logs"].append(
            f"  [Hard Binding] {blocks_before} → {len(blocks)}개 "
            f"({blocks_before - len(blocks)}개 결합)"
        )

    # ═══ 시맨틱 배칭 ═══
    batches = build_semantic_batches(blocks)
    num_batches = len(batches)
    job["logs"].append(f"> [Pass 1] {len(blocks)}개 자막 → {num_batches}개 배치")

    # ═══ Staggered Parallel 처리 ═══
    tone_memory: List[Dict[str, Any]] = []
    total_applied = 0
    failed_batches: set = set()
    CONCURRENCY = 7      # 최대 동시 LLM 호출 수 (Semaphore만으로 제어 - Stagger 이벤트 제거)

    batch_events = [asyncio.Event() for _ in range(num_batches)]
    stagger_results: Dict[int, bool] = {}
    semaphore = asyncio.Semaphore(CONCURRENCY)

    async def process_batch(batch_idx: int) -> bool:
        """배치 단일 처리"""
        nonlocal total_applied, tone_memory, confirmed_levels

        if job.get("cancelled"):
            return False

        batch = batches[batch_idx]
        batch_blocks = batch["blocks"]

        # ═══ Cross-Batch Context Window ═══
        # 현재 배치 시작 이전 블록 중 이미 번역된 블록의 마지막 5개를 참고 컨텍스트로 주입
        first_block_id = batch_blocks[0].get("id") if batch_blocks else None
        prev_translated_tail = []
        if first_block_id is not None:
            prev_translated_tail = [
                {
                    "index": b.get("id"),
                    "original": b.get("en", ""),
                    "translated": b.get("ko", ""),
                    "speaker": b.get("speaker", ""),
                }
                for b in blocks
                if b.get("ko") and b.get("id") is not None and b["id"] < first_block_id
            ][-5:]

        # 컨텍스트 정보 구성
        context_info = {
            "title": title,
            "synopsis": synopsis[:1000],
            "genre": genre,
            "personas": "\n".join(
                f"{p.get('name', '')}: {p.get('description', '')}"
                for p in personas_list if isinstance(p, dict)
            ) or "General",
            "fixed_terms": fixed_terms,
            "translation_rules": translation_rules,
            "character_relations": character_relations,
            "confirmed_speech_levels": confirmed_levels,
            "tone_memory": tone_memory[-50:],
            "batch_mood": batch.get("batch_mood", ""),
            "prev_context": prev_translated_tail,
        }

        # API 블록 준비
        api_blocks = []
        for s in batch_blocks:
            duration = _compute_block_duration(s)
            api_blocks.append({
                "index": s.get("id"),
                "start": s.get("start", ""),
                "end": s.get("end", ""),
                "text": _sanitize_subtitle_text(s.get("en", "")),
                "speaker": s.get("speaker"),
                "addressee": s.get("addressee"),
                "duration_sec": duration,
                "max_chars": _compute_max_chars(duration),
            })

        job["logs"].append(
            f"> [{batch_idx + 1}/{num_batches}] "
            f"자막 {api_blocks[0]['index']}~{api_blocks[-1]['index']} ({len(api_blocks)}개) 번역 중..."
        )

        try:
            # 번역 실행
            translations = await translate_single_batch(api_blocks, context_info)

            if not translations:
                job["logs"].append(f"  ⚠ [{batch_idx + 1}] 번역 실패, 재시도...")
                await asyncio.sleep(1)
                translations = await translate_single_batch(api_blocks, context_info)

            # 결과 적용
            batch_count = 0
            valid_ids = set(s.get("id") for s in batch_blocks if s.get("id") is not None)

            for trans in translations:
                trans_idx = trans.get("index")
                if trans_idx is None or trans_idx not in valid_ids:
                    continue

                trans_text = trans.get("text") or trans.get("ko", "")
                if not trans_text:
                    continue

                # 블록에 번역 적용
                for block in blocks:
                    if block.get("id") == trans_idx:
                        block["ko"] = trans_text
                        total_applied += 1
                        batch_count += 1
                        break

            # 후처리
            postprocess_translations(translations, api_blocks)

            # 톤 메모리 업데이트
            tone_memory = extract_tone_from_batch(batch_blocks, tone_memory, confirmed_levels)

            # 확정 말투 레벨 업데이트
            prev_mood = batches[batch_idx - 1].get("batch_mood", "") if batch_idx > 0 else ""
            current_mood = batch.get("batch_mood", "")
            confirmed_levels = update_confirmed_speech_levels(
                batch_blocks, confirmed_levels,
                scene_break=batch.get("scene_break", False),
                prev_mood=prev_mood,
                current_mood=current_mood
            )

            # 중간 결과 업데이트 (폴링용) - speaker 포함
            job["partial_subtitles"] = [
                {
                    "id": b.get("id"),
                    "ko": b.get("ko", ""),
                    "speaker": b.get("speaker", ""),
                    "addressee": b.get("addressee", ""),
                }
                for b in blocks if b.get("ko") and b["ko"].strip()
            ]

            job["logs"].append(f"  ✓ [{batch_idx + 1}/{num_batches}] 완료 (+{batch_count}개)")

            return batch_count > 0

        except Exception as e:
            job["logs"].append(f"  ⚠ [{batch_idx + 1}] 오류: {str(e)[:100]}")
            failed_batches.add(batch_idx)
            return False

    async def staggered_worker(idx: int) -> bool:
        """Semaphore 기반 병렬 처리 (최대 CONCURRENCY개 동시 - Stagger 제거)"""
        async with semaphore:
            if job.get("cancelled"):
                batch_events[idx].set()
                return False

            result = await process_batch(idx)
            stagger_results[idx] = result

            # 진행률: 20% → 80%
            completed = len(stagger_results)
            progress = 20 + int((completed / num_batches) * 60)
            job["progress"] = min(progress, 80)

        batch_events[idx].set()
        return bool(result)

    # 모든 배치 워커 시작
    if num_batches > 0:
        job["logs"].append(f"  ⚡ [Parallel x{CONCURRENCY}] {num_batches}개 배치 병렬 시작...")

    all_tasks = [staggered_worker(i) for i in range(num_batches)]
    await asyncio.gather(*all_tasks, return_exceptions=True)

    if failed_batches:
        job["logs"].append(f"  ℹ {len(failed_batches)}개 실패 배치는 Pass 2에서 재처리")

    job["progress"] = 85
    job["logs"].append(f"> [Pass 1] 완료: {total_applied}개 블록 번역")

    return blocks, tone_memory, confirmed_levels
