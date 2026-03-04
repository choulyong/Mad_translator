"""
Translation Engine Orchestrator — Pass 0~4 조율 및 병렬 실행

역할:
- 각 Pass의 순차/병렬 실행 조율
- 상태 업데이트 및 로깅
- 부분 결과 폴링 지원
- 작업 취소 및 에러 처리
"""

import asyncio
from typing import List, Dict, Any, Optional, Tuple

from app.engine.utils import (
    # Parsing
    parse_translation_response,
    # Batching
    apply_hard_binding,
    build_semantic_batches,
    # Postprocessing
    postprocess_translations,
    # Tone Memory
    extract_tone_from_batch,
    update_confirmed_speech_levels,
    detect_dedup,
    # Character
    detect_side_talk,
)

# NOTE: Pass 구현은 각 pass_*.py에서 정의
# from app.engine.passes import run_pass_0, run_pass_05, run_pass_1, run_pass_2, run_pass_3, run_pass_4


class TranslationOrchestrator:
    """
    번역 작업 조율자

    6개 Pass를 순차적으로 실행:
    - Pass 0: 화자 식별
    - Pass 0.5: 관계 매트릭스 추출
    - Pass 1: 메인 번역 (시맨틱 배칭)
    - Pass 2: QC & 중복 제거
    - Pass 3: 하드 후처리
    - Pass 4: 워드플레이 로컬라이제이션
    """

    def __init__(self, job_store: Dict[str, Dict[str, Any]]):
        """
        Args:
            job_store: 작업 저장소 (_jobs dict)
        """
        self.job_store = job_store

    async def run_translation_job(
        self,
        job_id: str,
        blocks: List[Dict[str, Any]],
        metadata: Dict[str, Any],
        strategy: Dict[str, Any],
        character_relations: Dict[str, str],
        confirmed_speech_levels: Dict[str, Dict[str, Any]],
        options: Dict[str, Any],
    ) -> None:
        """
        전체 번역 파이프라인 실행

        Args:
            job_id: 작업 ID
            blocks: 자막 블록 리스트
            metadata: 메타데이터 (제목, 장르, 시놉시스 등)
            strategy: 번역 전략 (페르소나, 고정용어, 규칙 등)
            character_relations: 화자 관계 맵
            confirmed_speech_levels: 확정 말투 레벨
            options: 옵션 (include_qc 등)
        """
        job = self.job_store.get(job_id)
        if not job:
            return

        blocks = list(blocks)
        tone_memory: List[Dict[str, Any]] = []
        total_applied = 0
        include_qc = options.get("include_qc", True)

        try:
            # 메타데이터 조립
            title = metadata.get("title", "Unknown")
            genre = metadata.get("genre", "Drama")
            if isinstance(genre, list):
                genre = ", ".join(genre)

            job["current_pass"] = "Pass 0: 화자 식별"
            job["progress"] = 5
            job["logs"].append("> [Pass 0] 화자 식별 시작...")

            # ═══ Pass 0: Speaker Identification ═══
            # TODO: 실제 구현은 app.engine.passes.pass_0에서
            # 현재는 존재하는 화자 정보 사용
            blocks_without_speakers = [
                b for b in blocks
                if not b.get("speaker") or not b.get("addressee")
            ]
            if blocks_without_speakers:
                job["logs"].append(
                    f"> [Pass 0] {len(blocks_without_speakers)}개 블록의 화자 정보 미설정"
                )

            if job.get("cancelled"):
                job["logs"].append("> 작업 취소됨")
                return

            # ═══ Pass 0.5: Dynamic Relationship Mapper ═══
            from app.engine.passes.pass_05 import run_pass_05
            from app.services.vertex_ai import VertexTranslator
            translator = VertexTranslator()
            character_relations = await run_pass_05(
                job, blocks, metadata, strategy, character_relations, translator
            )

            if job.get("cancelled"):
                return

            # ═══ Pass 1: Main Translation (시맨틱 배칭) ═══
            from app.engine.passes.pass_1 import run_pass_1
            from app.services.vertex_ai import VertexTranslator
            translator = VertexTranslator()
            blocks, tone_memory, confirmed_speech_levels = await run_pass_1(
                job, blocks, metadata, strategy, character_relations,
                confirmed_speech_levels, translator
            )

            if job.get("cancelled"):
                return

            # ═══ Pass 2: QC & Deduplication ═══
            from app.engine.passes.pass_2_qc import run_pass_2
            blocks = await run_pass_2(
                job, blocks, metadata, strategy, character_relations,
                confirmed_speech_levels, include_qc=include_qc
            )

            if job.get("cancelled"):
                return

            # ═══ Pass 3: Hard Postprocessing ═══
            from app.engine.passes.pass_3_fix import run_pass_3
            blocks = await run_pass_3(job, blocks, confirmed_speech_levels, character_relations, strategy)

            if job.get("cancelled"):
                return

            # ═══ Pass 4: Wordplay Localization ═══
            from app.engine.passes.pass_4_wp import run_pass_4
            blocks = await run_pass_4(job, blocks, metadata)

            # ═══ 작업 완료 ═══
            job["current_pass"] = "완료"
            job["progress"] = 100
            job["logs"].append(f"> 번역 완료: 총 {total_applied}개 블록 처리")
            job["logs"].append("> 톤 메모리: " + ", ".join(
                f"{e['speaker']}→{e['addressee']}: {e['tone']}"
                for e in tone_memory[-5:]
            ) if tone_memory else "없음")

        except Exception as e:
            job["logs"].append(f"> 오류 발생: {str(e)[:200]}")
            job["error"] = str(e)
            raise

    def cancel_job(self, job_id: str) -> None:
        """작업 취소"""
        job = self.job_store.get(job_id)
        if job:
            job["cancelled"] = True
            job["logs"].append("> 작업 취소 중...")
