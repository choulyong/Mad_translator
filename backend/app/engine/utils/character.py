"""
Character Utilities — 화자 관계 및 호칭 감지

역할:
- 호칭(vocative) 패턴 감지
- 방백(side-talk) 감지
- 화자 간 관계 맵핑
"""

import re
from typing import List, Dict, Any, Optional


# 호칭 사전: vocative → 기본 말투 추론용
VOCATIVE_DICT = {
    # 연인/배우자 → 반말
    "honey": "반말", "darling": "반말", "sweetheart": "반말",
    "baby": "반말", "babe": "반말", "dear": "반말",
    # 친구/동료 → 반말
    "buddy": "반말", "bro": "반말", "dude": "반말",
    "pal": "반말", "mate": "반말", "man": "반말",
    # 자녀 → 반말
    "son": "반말", "daughter": "반말", "kid": "반말", "kiddo": "반말",
    # 부모/웃어른 → 존대
    "dad": "존대", "mom": "존대", "father": "존대", "mother": "존대",
    "papa": "존대", "mama": "존대",
    # 공적 호칭 → 존대
    "sir": "존대", "ma'am": "존대", "madam": "존대",
    "officer": "존대", "detective": "존대", "doctor": "존대",
    "professor": "존대", "judge": "존대",
    # 기타
    "partner": "반말",
}

# 호칭 패턴 (trailing / leading)
TRAILING_VOCATIVE_RE = re.compile(
    r",\s+(" + "|".join(re.escape(v) for v in VOCATIVE_DICT) + r")[\s?!.]*$",
    re.IGNORECASE,
)
LEADING_VOCATIVE_RE = re.compile(
    r"^(" + "|".join(re.escape(v) for v in VOCATIVE_DICT) + r"),\s+",
    re.IGNORECASE,
)


def detect_side_talk(
    api_blocks: List[Dict[str, Any]],
    character_relations: Dict[str, str],
    persona_names: List[str],
) -> Dict[int, Dict[str, Any]]:
    """
    영어 원문에서 vocative(호칭격) 패턴을 감지하여
    한 블록 내에서 대상이 전환되는 방백(side-talk)을 찾는다.

    Args:
        api_blocks: 블록 리스트 [{index, text, speaker, addressee, ...}]
        character_relations: 화자 관계 맵 {"Speaker → Addressee": "relation"}
        persona_names: 캐릭터 이름 목록

    Returns:
        {block_index: {vocative, vocative_target, position, relation}}
    """
    result = {}

    # 캐릭터 이름 → 소문자 매핑
    name_lower_map = {}
    for name in persona_names:
        if name and name.strip():
            name_lower_map[name.strip().lower()] = name.strip()

    # 이름 기반 trailing/leading 패턴도 동적 생성
    all_vocatives = list(VOCATIVE_DICT.keys())
    name_vocatives = list(name_lower_map.keys())

    for block in api_blocks:
        text = block.get("text", "")
        if not text:
            continue

        idx = block.get("index")
        speaker = (block.get("speaker") or "").strip()
        addressee = (block.get("addressee") or "").strip()

        vocative_word = None
        position = None

        # 1) 호칭 사전 매칭 (trailing)
        m = TRAILING_VOCATIVE_RE.search(text)
        if m:
            vocative_word = m.group(1).lower()
            position = "trailing"

        # 2) 호칭 사전 매칭 (leading)
        if not vocative_word:
            m = LEADING_VOCATIVE_RE.match(text)
            if m:
                vocative_word = m.group(1).lower()
                position = "leading"

        # 3) 캐릭터 이름 매칭 (trailing: "..., Nick?")
        if not vocative_word:
            for name_l, name_orig in name_lower_map.items():
                trailing_name_re = re.compile(
                    r",\s+" + re.escape(name_l) + r"[\s?!.]*$", re.IGNORECASE
                )
                if trailing_name_re.search(text):
                    vocative_word = name_l
                    position = "trailing"
                    break

        # 4) 캐릭터 이름 매칭 (leading: "Nick, listen")
        if not vocative_word:
            for name_l, name_orig in name_lower_map.items():
                leading_name_re = re.compile(
                    r"^" + re.escape(name_l) + r",\s+", re.IGNORECASE
                )
                if leading_name_re.match(text):
                    vocative_word = name_l
                    position = "leading"
                    break

        if not vocative_word or not position:
            continue

        # vocative_target 결정
        vocative_target = name_lower_map.get(vocative_word, "")

        # 필터: vocative 대상이 메인 addressee와 같으면 방백이 아님
        if vocative_target and vocative_target.lower() == addressee.lower():
            continue
        # 호칭 사전 단어인데 target 미확인이면 방백 가능
        if not vocative_target and vocative_word in VOCATIVE_DICT:
            vocative_target = ""  # 이름 미확인, 호칭만으로 판단

        # 관계 조회: speaker → vocative_target
        relation = ""
        if vocative_target and speaker:
            pair_key = f"{speaker} → {vocative_target}"
            relation = character_relations.get(pair_key, "")
            if not relation:
                # 역방향 검색
                for k, v in character_relations.items():
                    if speaker.lower() in k.lower() and vocative_target.lower() in k.lower():
                        relation = v
                        break

        # 호칭 기반 말투 폴백
        if not relation and vocative_word in VOCATIVE_DICT:
            relation = VOCATIVE_DICT[vocative_word]

        result[idx] = {
            "vocative": vocative_word,
            "vocative_target": vocative_target,
            "position": position,
            "relation": relation,
        }

    return result
