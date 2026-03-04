"""
Pass 0.5: Dynamic Relationship Mapper - 관계 매트릭스 자동 추출

역할:
- 자막에서 화자 간 관계 자동 감지
- Vertex AI를 통한 관계 매핑
- 관계 정보 저장 및 반환
"""

import asyncio
from typing import Dict, Any, Optional

from app.services.speaker_identifier import build_relationship_prompt, parse_relationship_response, RELATIONSHIP_SYSTEM_PROMPT


async def run_pass_05(
    job: Dict[str, Any],
    blocks: list,
    metadata: Dict[str, Any],
    strategy: Dict[str, Any],
    character_relations: Dict[str, str],
    translator,
) -> Dict[str, str]:
    """
    Pass 0.5: Dynamic Relationship Mapper 실행

    Args:
        job: 작업 저장소
        blocks: 자막 블록 리스트
        metadata: 메타데이터
        strategy: 번역 전략
        character_relations: 기존 관계 정보 (없으면 추출)
        translator: Vertex AI translator

    Returns:
        {화자쌍: 관계설명} 형태의 관계 맵
    """
    job["current_pass"] = "Pass 0.5: 관계 매트릭스 추출"
    job["logs"].append("> [Pass 0.5] 관계 매트릭스 추출 중...")

    # 이미 관계 정보가 있으면 사용
    if character_relations:
        job["logs"].append(
            f"> [Pass 0.5] strategy에서 관계 정보 사용 ({len(character_relations)}개)"
        )
        return character_relations

    # 관계 추출 필요
    try:
        title = metadata.get("title", "Unknown")
        genre = metadata.get("genre", "Drama")
        if isinstance(genre, list):
            genre = ", ".join(genre)

        # 프롬프트 생성
        user_prompt = build_relationship_prompt(
            blocks=[{
                "id": b.get("id"),
                "start": b.get("start", ""),
                "end": b.get("end", ""),
                "speaker": b.get("speaker", ""),
                "text": b.get("en", "")
            } for b in blocks],
            title=title,
            genre=genre,
        )

        # Vertex AI 호출
        def make_relationship_call(attempt=0, max_retries=3):
            return translator.client.models.generate_content(
                model=translator.model,
                contents=user_prompt,
                config={
                    "system_instruction": RELATIONSHIP_SYSTEM_PROMPT,
                    "max_output_tokens": 8192,
                    "temperature": 0.1,
                }
            )

        response, error = translator._retry_with_backoff(make_relationship_call)

        if not error and response:
            extracted_relations = parse_relationship_response(response.text)
            job["logs"].append(
                f"> [Pass 0.5] {len(extracted_relations)}개 관계 추출 완료!"
            )
            return extracted_relations
        else:
            job["logs"].append("> [Pass 0.5] 관계 추출 실패, 기본값 사용")
            return {}

    except Exception as e:
        job["logs"].append(f"> [Pass 0.5] 오류: {str(e)[:100]}")
        return {}
