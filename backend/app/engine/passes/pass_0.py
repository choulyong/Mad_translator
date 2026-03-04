"""
Pass 0: Speaker Identification

화자를 자동으로 식별하는 모듈.
각 자막 블록에 speaker와 addressee를 할당합니다.
"""

from app.services.speaker_identifier import (
    SPEAKER_ID_SYSTEM_PROMPT,
    build_speaker_id_prompt,
    parse_speaker_response,
)
from app.services.vertex_ai import VertexTranslator


async def run_pass_0(
    blocks: list,
    title: str,
    synopsis: str,
    genre: str,
    detailed_personas: str,
    job: dict,
    translator: VertexTranslator,
) -> bool:
    """
    Pass 0: 화자 식별

    Args:
        blocks: 자막 블록 리스트
        title: 영화 제목
        synopsis: 영화 줄거리
        genre: 장르
        detailed_personas: 캐릭터 정보
        job: 백그라운드 작업 메타데이터
        translator: Vertex AI 트랜슬레이터

    Returns:
        bool: 성공 여부
    """
    # speaker/addressee가 없는 블록만 식별
    blocks_without_speakers = [b for b in blocks if not b.get("speaker") or not b.get("addressee")]

    if not blocks_without_speakers:
        job["logs"].append(f"> [Pass 0] 모든 블록에 화자 정보 있음, 스킵")
        return True

    job["current_pass"] = "Pass 0: 화자 식별"
    job["logs"].append(f"> [Pass 0] {len(blocks_without_speakers)}개 블록의 화자 식별 중...")

    try:
        # 프롬프트 생성
        user_prompt = build_speaker_id_prompt(
            blocks=[{
                "id": b.get("id"),
                "start": b.get("start", ""),
                "end": b.get("end", ""),
                "text": b.get("en", "")
            } for b in blocks_without_speakers],
            title=title,
            synopsis=synopsis[:1000],  # 처음 1000자만
            genre=genre,
            personas=detailed_personas,
            prev_identified=None,
        )

        # Vertex AI 호출
        def make_speaker_call(*args, **kwargs):
            return translator.client.models.generate_content(
                model=translator.model,
                contents=user_prompt,
                config={
                    "system_instruction": SPEAKER_ID_SYSTEM_PROMPT,
                    "max_output_tokens": 16384,
                    "temperature": 0.1,
                }
            )

        response, error = translator._retry_with_backoff(make_speaker_call)

        if error:
            job["logs"].append(f"> [Pass 0] API 호출 실패: {str(error)[:100]}")
            return False

        if not response:
            job["logs"].append(f"> [Pass 0] 응답이 없음")
            return False

        # 응답 파싱
        speakers = parse_speaker_response(response.text)

        # 원본 blocks에 speaker/addressee 추가
        for speaker_info in speakers:
            block_id = speaker_info.get("index")
            for block in blocks:
                if block.get("id") == block_id:
                    block["speaker"] = speaker_info.get("speaker")
                    block["addressee"] = speaker_info.get("addressee")

        job["logs"].append(f"> [Pass 0] {len(speakers)}개 블록 화자 식별 완료!")
        return True

    except Exception as e:
        job["logs"].append(f"> [Pass 0] 예외: {str(e)[:100]}")
        return False
