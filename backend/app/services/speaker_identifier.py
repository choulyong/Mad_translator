"""
Speaker Identifier Service - Gemini 기반 자막 화자 식별
"""

import json
import re
from typing import List, Optional

SPEAKER_ID_SYSTEM_PROMPT = """You are a dialogue structure analyzer.

Your job is to infer the speaker and the addressee for each subtitle line.

Use dialogue context and narrative clues to determine who is speaking to whom.

Rules:

1. If the speaker is explicitly known, keep it.
2. If the addressee is unclear, infer the most likely character.
3. Maintain conversation continuity.
4. Do not modify the subtitle text.

Output format (JSON array of objects):

[
 {
  "index": 1,
  "speaker": "...",
  "addressee": "...",
  "text": "original subtitle"
 }
]
"""

RELATIONSHIP_SYSTEM_PROMPT = """당신은 영화/드라마 캐릭터 관계 분석 전문가입니다.

[작업]
주어진 캐릭터 목록과 대사 샘플을 바탕으로, 캐릭터 간 관계와 말투를 분석하세요.

[분석 기준]
1. 사회적 위계 (상관-부하, 스승-제자, 부모-자녀)
2. 친밀도 (친구, 연인, 적대)
3. 대사에서 드러나는 존비어 사용 패턴
4. 호칭 패턴 (직함, 이름, 별명)

[출력 형식 - JSON 객체만]
{
  "Nick → Judy": "수평/친구 (반말)",
  "Judy → Chief Bogo": "수직상향/상관 (존댓말)",
  "Chief Bogo → Judy": "수직하향/부하 (반말)"
}

각 관계는 "A → B" 키로, 값은 "관계유형 (말투)" 형식으로 작성.
"""


def build_speaker_id_prompt(
    blocks: list,
    title: str = "",
    synopsis: str = "",
    genre: str = "",
    personas: str = "",
    prev_identified: Optional[list] = None,
) -> str:
    """화자 식별을 위한 user prompt 생성"""
    parts = []

    if title:
        parts.append(f"[작품: {title}]")
    if genre:
        parts.append(f"[장르: {genre}]")
    if synopsis:
        parts.append(f"\n[시놉시스]\n{synopsis[:1500]}")
    if personas:
        parts.append(f"\n[등장인물]\n{personas}")

    if prev_identified:
        prev_lines = []
        for p in prev_identified[-10:]:
            spk = p.get("speaker", p.get("speakers", "[UNKNOWN]"))
            if isinstance(spk, list):
                spk = " & ".join(spk)
            prev_lines.append(f"  #{p.get('index', '?')}: {spk}")
        parts.append(f"\n[이전 배치 화자 - 연속성 유지]\n" + "\n".join(prev_lines))

    block_lines = []
    for b in blocks:
        block_lines.append(f"{b['index']}: [{b.get('start', '')} → {b.get('end', '')}] {b['text']}")
    parts.append(f"\n다음 자막 블록의 화자를 식별하세요:\n\n" + "\n".join(block_lines))

    return "\n".join(parts)


def build_relationship_prompt(
    speakers: list,
    dialogue_samples: dict,
    title: str = "",
    synopsis: str = "",
    personas: str = "",
) -> str:
    """관계 매트릭스 생성을 위한 user prompt 생성"""
    parts = []

    if title:
        parts.append(f"[작품: {title}]")
    if synopsis:
        parts.append(f"\n[시놉시스]\n{synopsis[:1500]}")
    if personas:
        parts.append(f"\n[등장인물]\n{personas}")

    parts.append(f"\n[화자 목록]\n" + ", ".join(speakers))

    sample_lines = []
    for speaker, samples in dialogue_samples.items():
        sample_lines.append(f"\n  [{speaker}]")
        for s in samples[:5]:
            if isinstance(s, dict):
                sample_lines.append(f"    #{s.get('index', '?')}: \"{s.get('text', '')}\"")
            else:
                sample_lines.append(f"    \"{s}\"")
    parts.append(f"\n[대사 샘플]" + "\n".join(sample_lines))

    parts.append(f"\n위 정보를 바탕으로 캐릭터 간 관계와 적절한 말투(존댓말/반말)를 분석하세요.")

    return "\n".join(parts)


def parse_speaker_response(raw_content: str) -> list:
    """화자 식별 응답 파싱"""
    if not raw_content:
        return []

    content = raw_content.replace("```json", "").replace("```", "").strip()

    json_start = content.find('[')
    json_end = content.rfind(']')

    if json_start == -1 or json_end == -1 or json_end < json_start:
        return []

    try:
        return json.loads(content[json_start:json_end + 1])
    except json.JSONDecodeError:
        # 후행 쉼표 등 정제 시도
        cleaned = content[json_start:json_end + 1]
        cleaned = re.sub(r',\s*}', '}', cleaned)
        cleaned = re.sub(r',\s*]', ']', cleaned)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            return []


def parse_relationship_response(raw_content: str) -> dict:
    """관계 매트릭스 응답 파싱"""
    if not raw_content:
        return {}

    content = raw_content.replace("```json", "").replace("```", "").strip()

    json_start = content.find('{')
    json_end = content.rfind('}')

    if json_start == -1 or json_end == -1 or json_end < json_start:
        return {}

    try:
        return json.loads(content[json_start:json_end + 1])
    except json.JSONDecodeError:
        cleaned = content[json_start:json_end + 1]
        cleaned = re.sub(r',\s*}', '}', cleaned)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            return {}
