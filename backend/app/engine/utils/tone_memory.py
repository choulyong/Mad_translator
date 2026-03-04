"""
Tone Memory Utilities - 톤(존대/반말) 메모리 및 일관성 관리

역할:
- 한국어 톤 감지 (존대/반말)
- QC 필요 여부 판단
- 톤 메모리 추출 및 관리
- 확정 말투 레벨 업데이트 (70% 임계치)
"""

import re
from typing import List, Dict, Any, Optional, Tuple


def detect_tone_from_korean(text: str) -> Optional[str]:
    """
    한국어 텍스트에서 톤(존대/반말) 감지

    Returns:
        "formal" (존댓말) | "informal" (반말) | None
    """
    if not text or len(text.strip()) < 2:
        return None
    stripped = re.sub(r'[.!?\s]+$', '', text)
    formal_endings = ["습니다", "합니다", "입니다", "됩니다", "겠습니다",
                      "세요", "하세요", "주세요", "까요", "나요", "지요"]
    informal_endings = ["해", "야", "지", "어", "네", "걸", "잖아", "거든",
                        "구나", "군", "다", "래", "거야"]
    for ending in formal_endings:
        if stripped.endswith(ending):
            return "formal"
    for ending in informal_endings:
        if stripped.endswith(ending):
            return "informal"
    return None


def check_qc_needed(
    qc_blocks: List[Dict[str, Any]],
    confirmed_levels: Dict[str, Any],
    tone_threshold: float = 0.80
) -> Tuple[bool, str]:
    """
    QC 필요 여부 판단 (Targeting QC V2+V3)

    조건:
    - 영어 잔존 블록 있음 → 항상 QC 필요
    - 확정 말투와 실제 번역 어미 일치율 < 80% → QC 필요
    - 80% 이상 + 영어 없음 → QC 스킵 (비용 절감)

    Returns:
        (qc_needed: bool, reason: str)
    """
    EN_PATTERN = re.compile(r'[a-zA-Z]{3,}')  # 3자 이상 영어 잔존 감지

    # 1. 영어 잔존 체크
    for b in qc_blocks:
        ko = b.get("ko", "")
        if ko and EN_PATTERN.search(ko):
            return True, f"영어 잔존 감지: {ko[:40]}"

    # 2. 확정 말투 vs 실제 어미 일치율 체크
    if not confirmed_levels:
        return True, "confirmed_levels 없음 - QC 실행"

    mismatch_count = 0
    total_locked = 0

    for b in qc_blocks:
        speaker = b.get("speaker", "")
        addressee = b.get("addressee", "")
        ko = b.get("ko", "")
        if not speaker or not ko:
            continue

        # 확정 말투 조회
        pair_key = f"{speaker}->{addressee}" if addressee else f"{speaker}->?"
        level_info = confirmed_levels.get(pair_key) or confirmed_levels.get(f"{speaker}->?")
        if not level_info or not level_info.get("locked"):
            continue

        expected_tone = level_info.get("level", "undetermined")
        if expected_tone == "undetermined":
            continue

        actual_tone = detect_tone_from_korean(ko)
        if actual_tone is None:
            continue

        total_locked += 1
        if expected_tone == "honorific" and actual_tone != "formal":
            mismatch_count += 1
        elif expected_tone == "banmal" and actual_tone != "informal":
            mismatch_count += 1

    if total_locked >= 5:
        match_ratio = 1.0 - (mismatch_count / total_locked)
        if match_ratio < tone_threshold:
            return True, f"톤 불일치 {mismatch_count}/{total_locked} ({match_ratio:.0%} < {tone_threshold:.0%})"
        else:
            # 톤 일치율 높아도 QC는 항상 수행 (의미오류/번역투 검수 필요)
            return True, f"톤 일치율 {match_ratio:.0%} - QC 수행(번역투/의미 검수)"

    return True, "샘플 부족 - QC 실행"


def extract_tone_from_batch(
    blocks: List[Dict[str, Any]],
    existing_memory: List[Dict[str, Any]],
    confirmed_levels: Dict[str, Any] = None
) -> List[Dict[str, Any]]:
    """
    톤 메모리 추출 (PASS 2 강화)

    각 블록에서 화자와 톤을 추출하여 메모리에 추가/업데이트.
    최근 100개 엔트리만 보존.

    Args:
        blocks: 번역된 블록 리스트
        existing_memory: 기존 톤 메모리
        confirmed_levels: 확정 말투 레벨 (lock 상태 포함)

    Returns:
        업데이트된 톤 메모리 (최대 100개)
    """
    entries = list(existing_memory)
    confirmed_levels = confirmed_levels or {}

    for block in blocks:
        ko = block.get("ko", "")
        speaker = block.get("speaker", "")
        if not ko or not speaker:
            continue
        tone = detect_tone_from_korean(ko)
        if not tone:
            continue

        addressee = block.get("addressee", "unknown")
        pair_key = f"{speaker} → {addressee}"

        # relationship_lock 상태 포함
        lock_info = confirmed_levels.get(pair_key, {})
        relationship_lock = lock_info.get("locked", False)

        entry = {
            "speaker": speaker,
            "addressee": addressee,
            "tone": tone,
            "lastSeenAt": block.get("id", 0),
            "relationship_lock": relationship_lock,
        }
        existing_idx = next(
            (i for i, e in enumerate(entries)
             if e.get("speaker") == entry["speaker"] and e.get("addressee") == entry["addressee"]),
            None
        )
        if existing_idx is not None:
            entries[existing_idx] = entry
        else:
            entries.append(entry)
    return entries[-100:]  # 최근 100개만 보존


def update_confirmed_speech_levels(
    blocks: List[Dict[str, Any]],
    existing: Dict[str, Dict[str, Any]],
    scene_break: bool = False,
    prev_mood: str = "",
    current_mood: str = "",
) -> Dict[str, Dict[str, Any]]:
    """
    확정된 말투 업데이트 + 씬전환/무드변화 시 lock 해제

    TONE MEMORY LOCK RULE (PASS 2 강화):
    - 70% 임계치로 lock 결정 (기존 95%/5% → 70%/30% 변경)
    - 존댓말 >= 70% → "honorific" lock
    - 반말 >= 70% → "banmal" lock
    - 씬전환 또는 무드 변화 시 기존 lock 해제

    Args:
        blocks: 번역된 블록 리스트
        existing: 기존 확정 말투 레벨
        scene_break: 장면 전환 여부
        prev_mood: 이전 배치 무드
        current_mood: 현재 배치 무드

    Returns:
        업데이트된 확정 말투 레벨
    """
    levels = dict(existing)

    # 씬전환 또는 무드변화 시 기존 lock 해제
    if scene_break or (prev_mood and current_mood and prev_mood != current_mood):
        for key in list(levels.keys()):
            if isinstance(levels[key], dict) and levels[key].get("locked"):
                levels[key] = {**levels[key], "locked": False}

    for block in blocks:
        ko = block.get("ko", "")
        speaker = block.get("speaker", "")
        if not ko or not speaker:
            continue
        pair_key = f"{speaker} → {block.get('addressee', 'general')}"
        tone = detect_tone_from_korean(ko)

        if pair_key not in levels:
            levels[pair_key] = {
                "level": "undetermined",
                "confirmedAt": block.get("id", 0),
                "honorificCount": 0,
                "banmalCount": 0,
                "locked": False,
            }

        if tone == "formal":
            levels[pair_key]["honorificCount"] = levels[pair_key].get("honorificCount", 0) + 1
        elif tone == "informal":
            levels[pair_key]["banmalCount"] = levels[pair_key].get("banmalCount", 0) + 1

        total = levels[pair_key].get("honorificCount", 0) + levels[pair_key].get("banmalCount", 0)
        # TONE MEMORY LOCK RULE: 70% 임계치
        if total >= 5 and not levels[pair_key].get("locked"):
            ratio = levels[pair_key].get("honorificCount", 0) / total
            if ratio >= 0.70:
                levels[pair_key]["level"] = "honorific"
                levels[pair_key]["locked"] = True
                levels[pair_key]["confirmedAt"] = block.get("id", 0)
            elif ratio <= 0.30:
                levels[pair_key]["level"] = "banmal"
                levels[pair_key]["locked"] = True
                levels[pair_key]["confirmedAt"] = block.get("id", 0)

    return levels


def detect_dedup(blocks: List[Dict[str, Any]]) -> List[int]:
    """
    연속 중복 감지 - 5자 최소가드 + 원문 유사도 안전 필터

    Returns:
        중복으로 비워야 할 블록의 인덱스 리스트
    """
    dedup_indices = []
    for i in range(1, len(blocks)):
        curr = blocks[i]
        prev = blocks[i - 1]
        curr_ko = (curr.get("ko") or "").strip()
        prev_ko = (prev.get("ko") or "").strip()
        curr_en = (curr.get("en") or "").strip()
        prev_en = (prev.get("en") or "").strip()

        if (curr_ko and prev_ko
                and curr_ko == prev_ko
                and len(curr_ko) > 5
                and curr_en != prev_en):
            en_a = prev_en.lower()
            en_b = curr_en.lower()
            shorter = min(len(en_a), len(en_b))
            longer = max(len(en_a), len(en_b))
            len_ratio = shorter / (longer or 1)
            if len_ratio > 0.7 and en_a[:5] == en_b[:5]:
                continue
            dedup_indices.append(i)
    return dedup_indices
