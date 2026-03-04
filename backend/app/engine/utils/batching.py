"""
Batching Utilities — 시맨틱 배칭 및 Hard Binding

역할:
- 타임코드 파싱 및 처리
- 시맨틱 배칭 (장면 전환 기준)
- Hard Binding (분절 자막 결합)
- 배치 무드 감지
"""

import re
import math
from typing import Optional, List, Dict, Any


def parse_timecode_to_seconds(tc: str) -> float:
    """
    SRT 타임코드 → 초 변환
    예: '00:01:23,456' → 83.456
    """
    if not tc:
        return 0.0
    normalized = tc.replace(",", ".")
    parts = normalized.split(":")
    if len(parts) != 3:
        return 0.0
    hours = int(parts[0]) if parts[0].isdigit() else 0
    minutes = int(parts[1]) if parts[1].isdigit() else 0
    try:
        seconds = float(parts[2])
    except ValueError:
        seconds = 0.0
    return hours * 3600 + minutes * 60 + seconds


def compute_block_duration(block: Dict[str, Any]) -> float:
    """블록의 재생 시간 계산 (초)"""
    start = parse_timecode_to_seconds(block.get("start", ""))
    end = parse_timecode_to_seconds(block.get("end", ""))
    return max(end - start, 0.5)


def compute_max_chars(duration_sec: float, cps_rate: int = 14) -> int:
    """재생 시간 기반 최대 글자 수 계산 (CPS 기준)"""
    return max(math.floor(duration_sec * cps_rate), 4)


def detect_batch_mood(blocks: List[Dict[str, Any]]) -> str:
    """
    배치의 전체 무드 감지 (영어 원문 기반)
    Returns: "tense" | "romantic" | "humorous" | "sad" | "formal" | "neutral"
    """
    if not blocks:
        return "neutral"

    all_text = " ".join(b.get("en", "") for b in blocks).lower()

    scores = {"tense": 0, "romantic": 0, "humorous": 0, "sad": 0, "formal": 0}
    tense_words = ["kill", "die", "dead", "gun", "shoot", "run", "hurry", "bomb",
                   "attack", "fight", "danger", "help", "stop", "now", "quick",
                   "fuck", "shit", "damn", "hell", "bastard"]
    romantic_words = ["love", "kiss", "heart", "beautiful", "darling", "honey", "miss",
                      "marry", "together", "forever", "feel", "dream"]
    humorous_words = ["funny", "laugh", "joke", "crazy", "stupid", "dude", "bro",
                      "awesome", "cool", "weird", "haha", "lol"]
    sad_words = ["cry", "tear", "sorry", "lost", "gone", "never", "alone",
                 "death", "funeral", "miss", "goodbye", "farewell"]
    formal_words = ["sir", "ma'am", "your honor", "court", "president", "senator",
                    "doctor", "protocol", "regulation", "report", "briefing"]

    for w in tense_words:
        if w in all_text: scores["tense"] += 1
    for w in romantic_words:
        if w in all_text: scores["romantic"] += 1
    for w in humorous_words:
        if w in all_text: scores["humorous"] += 1
    for w in sad_words:
        if w in all_text: scores["sad"] += 1
    for w in formal_words:
        if w in all_text: scores["formal"] += 1

    scores["tense"] += min(all_text.count("!"), 5)
    ellipsis_count = all_text.count("...")
    scores["sad"] += min(ellipsis_count, 3)
    scores["romantic"] += min(ellipsis_count, 2)

    max_score = 0
    mood = "neutral"
    for key, score in scores.items():
        if score > max_score:
            max_score = score
            mood = key
    return mood if max_score >= 2 else "neutral"


def apply_hard_binding(blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Hard Binding (V2): ...나 접속사로 끝나는 분절 자막을 결합하여 문맥 유실 방지.
    결합된 블록은 _bound_ids에 원본 id 목록을 보존.

    Returns:
        결합된 새 blocks 리스트
    """
    # 접속사 패턴 (영어) — 문장 중간에서 끊기는 경우
    CONTINUATION_PATTERN = re.compile(
        r'(\.\.\.|…|—|–|,\s*$|'
        r'\b(and|but|or|nor|so|yet|because|although|while|if|when|as|since|however|therefore|meanwhile|then|so that|in order|except|unless|until|whether|though|even though|even if)\s*$)',
        re.IGNORECASE
    )

    bound = []
    i = 0
    while i < len(blocks):
        block = dict(blocks[i])  # 복사

        # 현재 블록의 영어 텍스트가 분절 패턴으로 끝나는지 확인
        en_text = block.get("en", "").strip()
        if (
            CONTINUATION_PATTERN.search(en_text)
            and i + 1 < len(blocks)
        ):
            # 다음 블록과 결합
            next_block = blocks[i + 1]
            next_en = next_block.get("en", "").strip()

            # 결합: 현재 텍스트 + 공백 + 다음 텍스트
            merged_en = f"{en_text} {next_en}".strip()

            # 타임코드: 현재 start ~ 다음 end
            merged = {
                **block,
                "en": merged_en,
                "end": next_block.get("end", block.get("end", "")),
                "_bound_ids": [block.get("id"), next_block.get("id")],
            }
            bound.append(merged)
            i += 2  # 두 블록을 소비
        else:
            bound.append(block)
            i += 1

    if len(bound) < len(blocks):
        print(f"[Hard Binding] {len(blocks)} → {len(bound)} blocks ({len(blocks) - len(bound)}개 결합됨)")
    return bound


def build_semantic_batches(blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    시맨틱 배칭 — 장면 전환 기준 15~50 블록 단위로 분할

    Returns:
        list of {start_idx, end_idx, blocks, scene_break, batch_mood}
    """
    if not blocks:
        return []

    # 배치 사이즈 (V5)
    MIN_BATCH = 15      # 15개 이상이면 배치
    MAX_BATCH = 50      # 50개 초과면 분할
    SCENE_GAP_SEC = 2.5  # 장면 전환 기준 (초)
    OVERLAP_LINES = 3   # 배치 간 3줄 오버랩 (문맥 절단 방지)

    batches = []
    current_batch = []
    batch_start = 0

    for i, block in enumerate(blocks):
        current_batch.append(block)

        should_split = False
        is_scene_break = False

        if i < len(blocks) - 1:
            current_end = parse_timecode_to_seconds(block.get("end", ""))
            next_start = parse_timecode_to_seconds(blocks[i + 1].get("start", ""))
            gap = next_start - current_end

            if gap > SCENE_GAP_SEC and len(current_batch) >= MIN_BATCH:
                should_split = True
                is_scene_break = True

            if len(current_batch) >= MAX_BATCH:
                lookback = min(5, len(current_batch) - MIN_BATCH)
                split_found = False
                for j in range(lookback):
                    check_idx = len(current_batch) - 1 - j
                    text = current_batch[check_idx].get("en", "")
                    if text and re.search(r'[.?!]$', text.strip()):
                        kept = current_batch[:check_idx + 1]
                        remainder = current_batch[check_idx + 1:]
                        batches.append({
                            "start_idx": batch_start,
                            "end_idx": batch_start + len(kept) - 1,
                            "blocks": list(kept),
                            "scene_break": False,
                            "batch_mood": detect_batch_mood(kept),
                        })
                        current_batch = list(remainder)
                        batch_start = batch_start + len(kept)
                        split_found = True
                        break
                if not split_found:
                    should_split = True

        if should_split and current_batch:
            batches.append({
                "start_idx": batch_start,
                "end_idx": batch_start + len(current_batch) - 1,
                "blocks": list(current_batch),
                "scene_break": is_scene_break,
                "batch_mood": detect_batch_mood(current_batch),
            })
            batch_start = batch_start + len(current_batch)
            current_batch = []

    # 남은 블록 처리 - MAX_BATCH를 초과하지 않도록 병합
    if current_batch and batches:
        prev = batches[-1]
        # 병합 후 MAX_BATCH를 초과하면 새 배치로 분리
        if len(prev["blocks"]) + len(current_batch) <= MAX_BATCH:
            prev["blocks"].extend(current_batch)
            prev["end_idx"] = prev["start_idx"] + len(prev["blocks"]) - 1
            prev["batch_mood"] = detect_batch_mood(prev["blocks"])
        else:
            # 새 배치 생성
            batches.append({
                "start_idx": batch_start,
                "end_idx": batch_start + len(current_batch) - 1,
                "blocks": list(current_batch),
                "scene_break": False,
                "batch_mood": detect_batch_mood(current_batch),
            })
    elif current_batch:
        # 첫 번째 배치인 경우 새 배치 생성
        batches.append({
            "start_idx": batch_start,
            "end_idx": batch_start + len(current_batch) - 1,
            "blocks": list(current_batch),
            "scene_break": False,
            "batch_mood": detect_batch_mood(current_batch),
        })

    # DEBUG: Print batch summary
    print(f"[DEBUG] Created {len(batches)} batches:")
    for i, b in enumerate(batches):
        print(f"  Batch {i+1}: indices {b['start_idx']}~{b['end_idx']} ({len(b['blocks'])} blocks)")

    return batches
