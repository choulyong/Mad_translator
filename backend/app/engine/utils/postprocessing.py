"""
Postprocessing Utilities — 번역 후 텍스트 정리 및 보정

역할:
- 음악 표기 정리 (♪)
- 대사 대시 정리
- 문장부호 정규화
- CPS 기반 줄바꿈
- 소프트 중복 제거
"""

import re
import difflib
from typing import List, Dict, Any, Optional


_MUSIC_VERBS_RE = re.compile(r"(재생\s*중|연주됨|연주\s*중|흘러나옴|playing)", re.IGNORECASE)


def norm_for_dedup(s: str) -> str:
    """중복 판별용 정규화 (의미 보존이 아니라 비교 목적)"""
    if not s:
        return ""
    t = s.strip()
    t = t.replace("\u2026", "...")  # … ↔ ...
    t = re.sub(r"\s+", "", t)
    t = re.sub(r"[\"'""'']", "", t)
    t = re.sub(r"[!?.,~\-–—·:;()\[\]{}<>]", "", t)
    return t


def fix_music_notes(text: str) -> str:
    """
    ♪ 표기 정리:
    - 한쪽만 있는 경우 양쪽으로 맞춤
    - '재생 중/연주됨' 같은 설명형 제거 (가독성)
    """
    if not text:
        return text

    lines = text.split("\n")
    out = []
    for line in lines:
        l = line.strip()
        if "♪" not in l:
            out.append(line)
            continue

        # 설명형 제거
        l2 = _MUSIC_VERBS_RE.sub("", l).strip()

        # ♪ 갯수/위치 교정
        if l2.count("♪") == 1:
            # 앞에만 있거나 뒤에만 있거나 → 양쪽으로
            l2 = l2.replace("♪", "").strip()
            if l2:
                l2 = f"♪ {l2} ♪"
            else:
                l2 = "♪ ♪"
        else:
            # 여러 개면 외곽만 남기고 정리
            core = l2.replace("♪", "").strip()
            l2 = f"♪ {core} ♪" if core else "♪ ♪"

        out.append(l2)

    return "\n".join(out)


def normalize_dialogue_dashes(text: str) -> str:
    """
    대시 대화 정리:
    - '-대사' → '- 대사'
    - 한 줄에 '- A - B' 형태 → '- A\n- B' (보수적)
    """
    if not text:
        return text

    # 줄 단위로 처리
    lines = text.split("\n")
    new_lines = []
    for line in lines:
        l = line.rstrip()

        # "-대사" → "- 대사"
        l = re.sub(r"^\-\s*(\S)", r"- \1", l)

        # 보수적 분리: "- A - B" (중간에 " - "가 있고, 앞이 대시로 시작할 때)
        if l.startswith("- ") and " - " in l:
            parts = l.split(" - ")
            if len(parts) == 2:
                left = parts[0].strip()
                right = parts[1].strip()
                # right가 말처럼 보이면 대화 분리
                if right and not right.startswith("—"):
                    new_lines.append(left)
                    new_lines.append("- " + right)
                    continue

        new_lines.append(l)

    return "\n".join(new_lines).strip()


def normalize_punctuation(text: str) -> str:
    """
    문장부호 후보정 (의미 보존):
    - ... → …
    - !!, ??? 과다 축약
    - 불필요한 공백 정리
    """
    if not text:
        return text

    t = text

    # ... → …
    t = re.sub(r"\.{3,}", "\u2026", t)

    # 과다 느낌표/물음표 축약
    t = re.sub(r"!\s*!+", "!", t)
    t = re.sub(r"\?\s*\?+", "?", t)

    # "!?" / "?!"는 유지하되 중복 축약
    t = re.sub(r"(!\?){2,}", "!?", t)
    t = re.sub(r"(\?!){2,}", "?!", t)

    # 공백 정리
    t = re.sub(r"[ \t]+", " ", t)
    t = "\n".join(line.strip() for line in t.split("\n"))

    return t.strip()


def smart_linebreak(text: str, max_chars: int) -> str:
    """
    CPS 기반 줄바꿈 (의미 불변):
    - 너무 긴 한 줄을 공백 기준으로 2줄로 나눔
    - 한국어에 공백이 거의 없으면 무리해서 자르지 않음
    """
    if not text:
        return text

    # 이미 2줄 이상이면 재분배만 약하게
    lines = text.split("\n")
    if len(lines) >= 2:
        # 한 줄이 지나치게 길면 재분배 시도
        longest = max(len(l) for l in lines)
        if longest <= max_chars:
            return text
        merged = " ".join(l.strip() for l in lines if l.strip())
        text = merged

    if len(text) <= max_chars:
        return text

    # 공백이 거의 없으면 포기 (의미 훼손 방지)
    if text.count(" ") < 1:
        return text

    # 목표 분할 지점: 대략 절반
    target = max(4, min(len(text) - 4, max_chars // 2 + 2))
    # target 주변에서 가장 가까운 공백 찾기
    left_space = text.rfind(" ", 0, target)
    right_space = text.find(" ", target)

    # 후보 선택
    if left_space == -1 and right_space == -1:
        return text
    if left_space == -1:
        cut = right_space
    elif right_space == -1:
        cut = left_space
    else:
        cut = left_space if (target - left_space) <= (right_space - target) else right_space

    a = text[:cut].strip()
    b = text[cut:].strip()
    if not a or not b:
        return text

    return a + "\n" + b


def postprocess_translations(
    parsed_translations: List[Dict[str, Any]],
    batch_dicts: List[Dict[str, Any]],
    cps_rate: int = 14
) -> Dict[str, int]:
    """
    번역 후처리 - 의미 보존 후보정만 수행

    Args:
        parsed_translations: [{"index": int, "text": str}, ...]
        batch_dicts: 블록 정보 (index, start, end 포함)
        cps_rate: 문자당 시간 비율 (기본 14)

    Returns:
        처리 통계
    """
    # index → block 매핑
    block_map = {b.get("index"): b for b in batch_dicts if b.get("index") is not None}

    stats = {
        "music_fixed": 0,
        "dash_fixed": 0,
        "punct_fixed": 0,
        "linebreak_fixed": 0,
        "soft_dedup_blank": 0,
    }

    # 번역 텍스트 정규화/정리
    for t in parsed_translations:
        idx = t.get("index")
        text = (t.get("text") or "").strip()
        if not text:
            continue

        original = text

        # 1) ♪ 정리
        text2 = fix_music_notes(text)
        if text2 != text:
            stats["music_fixed"] += 1
        text = text2

        # 2) 대시 대화 정리
        text2 = normalize_dialogue_dashes(text)
        if text2 != text:
            stats["dash_fixed"] += 1
        text = text2

        # 3) 문장부호 정리
        text2 = normalize_punctuation(text)
        if text2 != text:
            stats["punct_fixed"] += 1
        text = text2

        # 4) CPS 기반 줄바꿈 (start/end가 있는 경우에만)
        b = block_map.get(idx, {})
        if b.get("start") and b.get("end"):
            from .batching import compute_block_duration, compute_max_chars
            dur = compute_block_duration({"start": b.get("start"), "end": b.get("end")})
            max_chars = compute_max_chars(dur, cps_rate=cps_rate)
            text2 = smart_linebreak(text, max_chars=max_chars)
            if text2 != text:
                stats["linebreak_fixed"] += 1
            text = text2

        if text != original:
            t["text"] = text

    # 5) 소프트 중복 제거
    idx_order = [b.get("index") for b in batch_dicts if b.get("index") is not None]
    idx_to_trans = {t.get("index"): t for t in parsed_translations if t.get("index") is not None}

    prev_idx = None
    for idx in idx_order:
        curr = idx_to_trans.get(idx)
        if not curr:
            continue
        curr_ko = (curr.get("text") or "").strip()
        if not curr_ko:
            prev_idx = idx
            continue

        if prev_idx is None:
            prev_idx = idx
            continue

        prev = idx_to_trans.get(prev_idx)
        if not prev:
            prev_idx = idx
            continue

        prev_ko = (prev.get("text") or "").strip()
        if not prev_ko:
            prev_idx = idx
            continue

        nk = norm_for_dedup(curr_ko)
        pk = norm_for_dedup(prev_ko)

        if nk and pk and nk == pk and len(nk) >= 5:
            # 영어 비교
            curr_en = (block_map.get(idx, {}).get("text") or "")
            prev_en = (block_map.get(prev_idx, {}).get("text") or "")
            en_ratio = difflib.SequenceMatcher(None, curr_en.lower(), prev_en.lower()).ratio()

            # EN이 꽤 다르면 중복 가능성↑ → blank 처리
            if en_ratio < 0.60:
                curr["text"] = ""
                stats["soft_dedup_blank"] += 1

        prev_idx = idx

    return stats


def sanitize_subtitle_text(text: str) -> str:
    """번역 전 자막 텍스트 정제"""
    if not text:
        return ""
    cleaned = re.sub(r'<[^>]+>', '', text)
    cleaned = re.sub(r'\{\\[^}]+\}', '', cleaned)
    cleaned = re.sub(r'[ \t]+', ' ', cleaned)
    cleaned = "\n".join(line.strip() for line in cleaned.split("\n") if line.strip())
    return cleaned.strip()
