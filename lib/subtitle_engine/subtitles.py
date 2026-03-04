import os
import re
import json
import traceback
import asyncio
import uuid
import time
import math
from datetime import datetime
from pathlib import Path
from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional, Any
from app.core.logic_gate import LogicGate
from app.core.diagnostic import DiagnosticEngine
from app.services.vertex_ai import VertexTranslator
from app.services.speaker_identifier import (
    SPEAKER_ID_SYSTEM_PROMPT,
    RELATIONSHIP_SYSTEM_PROMPT,
    build_speaker_id_prompt,
    build_relationship_prompt,
    parse_speaker_response,
    parse_relationship_response,
)
from app.core.translation_quality_checker import (
    check_translation_quality,
    auto_fix_subtitles,
    get_retranslation_targets,
    TranslationQualityChecker
)

# 번역 파일 저장 경로
STORAGE_PATH = Path(__file__).parent.parent.parent / "storage" / "translations"
STORAGE_PATH.mkdir(parents=True, exist_ok=True)


def _sanitize_json(json_str: str) -> str:
    """
    JSON 문자열 정제 - 아포스트로피 보존!
    """
    result = json_str

    # 제어 문자 처리: JSON 문자열 값 안의 이스케이프 안 된 제어 문자를 이스케이프
    # (Invalid control character 에러 방지)
    def _escape_control_chars_in_strings(s: str) -> str:
        """JSON 문자열 값 내부의 제어 문자를 이스케이프"""
        out = []
        in_string = False
        escape_next = False
        for ch in s:
            if escape_next:
                out.append(ch)
                escape_next = False
                continue
            if ch == '\\' and in_string:
                out.append(ch)
                escape_next = True
                continue
            if ch == '"':
                in_string = not in_string
                out.append(ch)
                continue
            if in_string and ord(ch) < 0x20:
                # 제어 문자를 적절히 이스케이프
                if ch == '\n':
                    out.append('\\n')
                elif ch == '\r':
                    out.append('\\r')
                elif ch == '\t':
                    out.append('\\t')
                else:
                    out.append(f'\\u{ord(ch):04x}')
                continue
            out.append(ch)
        return ''.join(out)

    result = _escape_control_chars_in_strings(result)

    # 후행 쉼표 제거
    result = re.sub(r',\s*}', '}', result)
    result = re.sub(r',\s*]', ']', result)

    # 인용되지 않은 키만 수정 (텍스트 값은 건드리지 않음)
    result = re.sub(r'([{\[,]\s*)(\w+)(\s*:)', r'\1"\2"\3', result)

    # 이중 따옴표 수정
    result = result.replace('""', '"')

    # 주의: .replace(/'/g, '"') 는 아포스트로피를 손상시키므로 사용하지 않음!

    return result


def _parse_translation_response(raw_content: str, original_blocks: list) -> list:
    """
    번역 응답 파싱 - 다중 폴백 전략
    Returns: list of {index: int, text: str}
    """
    if not raw_content:
        print("[WARN] Empty raw_content received")
        return []

    # 마크다운 정리
    content = raw_content.replace("```json", "").replace("```", "").strip()

    # JSON 배열 찾기
    json_start = content.find('[')
    json_end = content.rfind(']')

    if json_start == -1:
        print("[WARN] No JSON array found in response")
        return []

    # 잘림 처리
    if json_end == -1 or json_end < json_start:
        print("[WARN] JSON appears truncated, attempting recovery...")
        content = content[json_start:]

        # 마지막 완전한 객체 찾기
        last_complete = content.rfind('"}')
        if last_complete > 0:
            content = content[:last_complete + 2] + ']'
            print(f"[INFO] Recovered truncated JSON, length: {len(content)}")
        else:
            print("[ERROR] Could not recover truncated JSON")
            return []
    else:
        content = content[json_start:json_end + 1]

    # 파싱 시도 1: 직접 파싱
    try:
        translations = json.loads(content)
        print(f"[DEBUG] Direct JSON parse successful: {len(translations)} items")
    except json.JSONDecodeError as e:
        print(f"[WARN] Direct parse failed: {e}, trying sanitization...")

        # 파싱 시도 2: 정제 후 재시도 (제어 문자 이스케이프 포함)
        try:
            sanitized = _sanitize_json(content)
            translations = json.loads(sanitized)
            print(f"[DEBUG] Sanitized JSON parse successful: {len(translations)} items")
        except json.JSONDecodeError as e2:
            print(f"[WARN] Sanitized parse also failed: {e2}, trying strict=False...")

            # 파싱 시도 3: strict=False (제어 문자 허용)
            try:
                decoder = json.JSONDecoder(strict=False)
                translations, _ = decoder.raw_decode(content)
                if not isinstance(translations, list):
                    translations = [translations]
                print(f"[DEBUG] strict=False parse successful: {len(translations)} items")
            except (json.JSONDecodeError, ValueError) as e3:
                print(f"[WARN] strict=False parse failed: {e3}, trying truncation recovery...")

                # 파싱 시도 4: 잘림 복구
                try:
                    last_obj = content.rfind('"}')
                    if last_obj > 0:
                        recovered = content[:last_obj + 2] + ']'
                        sanitized_recovered = _sanitize_json(recovered)
                        translations = json.loads(sanitized_recovered)
                        print(f"[DEBUG] Recovery parse successful: {len(translations)} items")
                    else:
                        print("[ERROR] All JSON parsing attempts failed")
                        return []
                except json.JSONDecodeError:
                    # 최종 시도: strict=False + 잘림 복구
                    try:
                        if last_obj > 0:
                            recovered = content[:last_obj + 2] + ']'
                            decoder2 = json.JSONDecoder(strict=False)
                            translations, _ = decoder2.raw_decode(recovered)
                            if not isinstance(translations, list):
                                translations = [translations]
                            print(f"[DEBUG] Recovery+strict=False parse successful: {len(translations)} items")
                        else:
                            print("[ERROR] All JSON parsing attempts failed")
                            return []
                    except (json.JSONDecodeError, ValueError):
                        print("[ERROR] All JSON parsing attempts failed (including strict=False recovery)")
                        return []

    # 결과 정규화 — Gemini가 {index,text} 또는 {id,ko} 형식으로 응답
    result = []
    for trans in translations:
        if not isinstance(trans, dict):
            continue
        text_val = trans.get("text") or trans.get("ko") or trans.get("translated") or ""
        idx = trans.get("index") or trans.get("id")
        if text_val and idx is not None:
            # ID를 int로 통일 (Gemini가 문자열/정수 혼용)
            try:
                idx = int(idx)
            except (ValueError, TypeError):
                pass
            result.append({
                "index": idx,
                "text": text_val
            })

    return result

router = APIRouter()
logic_gate = LogicGate()
diagnostic = DiagnosticEngine()

# Vertex AI 클라이언트 (환경변수에서 자동 로드)
# 초기화 지연 - 실제 API 호출 시점에 생성
vertex_ai = None

def get_vertex_ai():
    global vertex_ai
    if vertex_ai is None:
        vertex_ai = VertexTranslator()
    return vertex_ai

# ═══════════════════════════════════════════════════════════════════════════════
# Job Store — 백엔드 오케스트레이션 (translate-all)
# ═══════════════════════════════════════════════════════════════════════════════

_jobs: dict[str, dict] = {}


class TranslateAllRequest(BaseModel):
    blocks: list                                    # [{id, start, end, en, speaker, addressee}]
    metadata: dict                                  # {title, genre, synopsis, ...}
    strategy: Optional[dict] = None                 # {character_personas, fixed_terms, translation_rules}
    character_relations: Optional[dict] = None
    confirmed_speech_levels: Optional[dict] = None
    options: Optional[dict] = None                  # {include_qc: bool}


# ═══════════════════════════════════════════════════════════════════════════════
# translate_single_batch() — HTTP 없이 직접 호출하는 번역 함수
# ═══════════════════════════════════════════════════════════════════════════════

async def translate_single_batch(blocks: list, context_info: dict) -> list:
    """
    단일 배치 번역 — HTTP 없이 직접 호출.
    기존 batch-translate 엔드포인트의 핵심 로직 추출.
    Returns: list of {index, text}
    """
    translator = get_vertex_ai()

    result = await translator.translate_batch(blocks, context_info)

    if not result.get("success"):
        print(f"[ERROR] translate_single_batch failed: {result.get('error')}")
        return []

    raw_content = result.get("data", "")
    parsed = _parse_translation_response(raw_content, blocks)

    # 슬래시 줄바꿈 변환
    for trans in parsed:
        if trans.get("text") and " / " in trans["text"]:
            trans["text"] = trans["text"].replace(" / ", "\n")

    return parsed


# ═══════════════════════════════════════════════════════════════════════════════
# 유틸 함수: 시맨틱 배칭, 톤 메모리, 중복 감지, 후처리
# ═══════════════════════════════════════════════════════════════════════════════

def _parse_timecode_to_seconds(tc: str) -> float:
    """SRT 타임코드 → 초 (예: '00:01:23,456' → 83.456)"""
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


def _compute_block_duration(block: dict) -> float:
    start = _parse_timecode_to_seconds(block.get("start", ""))
    end = _parse_timecode_to_seconds(block.get("end", ""))
    return max(end - start, 0.5)


def _compute_max_chars(duration_sec: float, cps_rate: int = 14) -> int:
    return max(math.floor(duration_sec * cps_rate), 4)


def _detect_batch_mood(blocks: list) -> str:
    """배치의 전체 무드 감지 (영어 원문 기반)"""
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


def _build_semantic_batches(blocks: list) -> list:
    """
    시맨틱 배칭 — 장면 전환 기준 20~40 블록 단위로 분할.
    Returns: list of {start_idx, end_idx, blocks, scene_break, batch_mood}
    """
    if not blocks:
        return []

    MIN_BATCH = 20
    MAX_BATCH = 40
    SCENE_GAP_SEC = 2.5

    batches = []
    current_batch = []
    batch_start = 0

    for i, block in enumerate(blocks):
        current_batch.append(block)

        should_split = False
        is_scene_break = False

        if i < len(blocks) - 1:
            current_end = _parse_timecode_to_seconds(block.get("end", ""))
            next_start = _parse_timecode_to_seconds(blocks[i + 1].get("start", ""))
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
                            "batch_mood": _detect_batch_mood(kept),
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
                "batch_mood": _detect_batch_mood(current_batch),
            })
            batch_start = batch_start + len(current_batch)
            current_batch = []

    # 남은 블록 처리
    if current_batch:
        if len(current_batch) < 4 and batches:
            prev = batches[-1]
            prev["blocks"].extend(current_batch)
            prev["end_idx"] = prev["start_idx"] + len(prev["blocks"]) - 1
            prev["batch_mood"] = _detect_batch_mood(prev["blocks"])
        else:
            batches.append({
                "start_idx": batch_start,
                "end_idx": batch_start + len(current_batch) - 1,
                "blocks": list(current_batch),
                "scene_break": False,
                "batch_mood": _detect_batch_mood(current_batch),
            })

    return batches


def _detect_tone_from_korean(text: str) -> Optional[str]:
    """한국어 텍스트에서 톤(존대/반말) 감지"""
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


def _extract_tone_from_batch(blocks: list, existing_memory: list, confirmed_levels: dict = None) -> list:
    """✅ PASS 2 강화: 톤 메모리 추출 + relationship_lock 포함"""
    entries = list(existing_memory)
    confirmed_levels = confirmed_levels or {}

    for block in blocks:
        ko = block.get("ko", "")
        speaker = block.get("speaker", "")
        if not ko or not speaker:
            continue
        tone = _detect_tone_from_korean(ko)
        if not tone:
            continue

        addressee = block.get("addressee", "unknown")
        pair_key = f"{speaker} → {addressee}"

        # ✅ relationship_lock 상태 포함
        lock_info = confirmed_levels.get(pair_key, {})
        relationship_lock = lock_info.get("locked", False)

        entry = {
            "speaker": speaker,
            "addressee": addressee,
            "tone": tone,
            "lastSeenAt": block.get("id", 0),
            "relationship_lock": relationship_lock,  # ✅ PASS 2: Lock 상태 추출
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
    return entries[-100:]


def _update_confirmed_speech_levels(
    blocks: list,
    existing: dict,
    scene_break: bool = False,
    prev_mood: str = "",
    current_mood: str = "",
) -> dict:
    """확정된 말투 업데이트 + 씬전환/무드변화 시 lock 해제"""
    levels = dict(existing)

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
        tone = _detect_tone_from_korean(ko)

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
        # ✅ PASS 2 강화: TONE MEMORY LOCK RULE
        # 70% 임계치로 lock 결정 (기존 95%/5% → 70%/30% 변경)
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


def _detect_dedup(blocks: list) -> list:
    """
    연속 중복 감지 — 5자 최소가드 + 원문 유사도 안전 필터.
    Returns: 중복으로 비워야 할 블록의 인덱스 리스트
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


def _apply_postprocess(blocks: list, confirmed_levels: dict = None, char_relations: dict = None) -> dict:
    """
    Pass 5.1 하드코딩 후처리 — 금기어 치환, 말줄임표 통일, 마침표 제거, 권위 톤 교정, 피압박자 격식체 교정.
    Returns: {period_count, expression_count, format_count, auth_drift_count, submissive_formal_count}
    """
    confirmed_levels = confirmed_levels or {}
    char_relations = char_relations or {}

    prohibited_replacements = [
        (re.compile(r'생일\s?소년'), "오늘의 주인공"),
        (re.compile(r'생일\s?소녀'), "오늘의 주인공"),
        (re.compile(r'생일\s?아이'), "오늘의 주인공"),
        (re.compile(r'코\s?분노'), "코뿔소 난동"),
        (re.compile(r'나쁜\s?남자'), "나쁜 놈"),
        (re.compile(r'나쁜\s?소년'), "나쁜 놈"),
        (re.compile(r'좋은\s?소녀'), "착한 아이"),
        (re.compile(r'좋은\s?소년'), "착한 아이"),
    ]
    formal_endings_re = re.compile(
        r'(?:습니다|세요|하세요|주세요|까요|나요|지요|입니다|됩니다|겠습니다|십시오|하시오)$'
    )

    # 권위 하향 관계 판별을 위한 키워드 (관계 설명에 포함 시 하향)
    _DOWNWARD_KEYWORDS = {"반말", "하대", "명령", "하향", "부하", "피의자", "용의자", "훈련병", "졸병"}
    _DOWNWARD_HONORIFICS = {"자네", "너", "이봐", "야,"}
    # 피압박자 판별 키워드 (관계 설명에 포함 시 상향 격식)
    _SUBMISSIVE_KEYWORDS = {"죄수", "포로", "피의자", "용의자", "인질", "훈련병", "졸병", "하급자", "부하", "학생", "격식", "하십시오"}

    def _is_downward_relation(speaker: str, addressee: str) -> bool:
        """confirmed_levels 또는 char_relations에서 하향 권위 관계 여부 판별"""
        pair_key = f"{speaker} → {addressee}"
        # 1) AUTHORITATIVE_LOCK 체크
        lvl = confirmed_levels.get(pair_key)
        if isinstance(lvl, dict) and lvl.get("level") == "authoritative_downward":
            return True
        # 2) char_relations 텍스트에서 하향 키워드 검색
        rel_text = str(char_relations.get(pair_key, ""))
        if any(kw in rel_text for kw in _DOWNWARD_KEYWORDS):
            return True
        # 3) banmal이 locked인 경우도 하향일 가능성
        if isinstance(lvl, dict) and lvl.get("locked") and lvl.get("level") == "banmal":
            return True
        return False

    def _is_submissive_relation(speaker: str, addressee: str) -> bool:
        """피압박자가 상위자에게 말하는 관계 여부 판별 (역방향 체크)"""
        pair_key = f"{speaker} → {addressee}"
        reverse_key = f"{addressee} → {speaker}"
        # 1) 역방향이 authoritative_downward이면 이쪽은 submissive
        rev_lvl = confirmed_levels.get(reverse_key)
        if isinstance(rev_lvl, dict) and rev_lvl.get("level") == "authoritative_downward":
            return True
        # 2) 이쪽 pair에 "submissive_formal" 잠금이 있으면
        my_lvl = confirmed_levels.get(pair_key)
        if isinstance(my_lvl, dict) and my_lvl.get("level") == "submissive_formal":
            return True
        # 3) char_relations에서 피압박 키워드 검색
        rel_text = str(char_relations.get(pair_key, ""))
        if any(kw in rel_text for kw in _SUBMISSIVE_KEYWORDS):
            return True
        return False

    # 피압박자 해요체→격식체 치환 패턴
    _SUBMISSIVE_FORMAL_PATTERNS = [
        (re.compile(r'([가-힣])에요\.'), r'\1입니다.'),
        (re.compile(r'이에요\.'), '입니다.'),
        (re.compile(r'([가-힣])에요$'), r'\1입니다'),
        (re.compile(r'이에요$'), '입니다'),
        (re.compile(r'해요\.'), '합니다.'),
        (re.compile(r'해요$'), '합니다'),
        (re.compile(r'([가-힣])았어요'), r'\1았습니다'),
        (re.compile(r'([가-힣])었어요'), r'\1었습니다'),
        (re.compile(r'할게요'), '하겠습니다'),
        (re.compile(r'거든요'), '것입니다'),
        (re.compile(r'잖아요'), '지 않습니까'),
        (re.compile(r'([가-힣])죠\?'), r'\1지요?'),
        (re.compile(r'인가요\?'), '입니까?'),
        (re.compile(r'에요\?'), '입니까?'),
        (re.compile(r'이에요\?'), '입니까?'),
        (re.compile(r'할까요\?'), '하겠습니까?'),
        (re.compile(r'나요\?'), '습니까?'),
    ]

    # 권위 톤 치환 패턴
    _AUTH_DRIFT_PATTERNS = [
        (re.compile(r'입니까\?'), '인가?'),
        (re.compile(r'습니까\?'), '나?'),
        (re.compile(r'인가요\?'), '인가?'),
        (re.compile(r'나요\?'), '나?'),
        (re.compile(r'([가-힣])어요\?'), r'\1었나?'),
        (re.compile(r'([가-힣])아요\?'), r'\1았나?'),
        (re.compile(r'해요\?'), '하나?'),
        (re.compile(r'죠\?'), '지?'),
        (re.compile(r'세요\?'), '나?'),
        (re.compile(r'할까요\?'), '할까?'),
    ]

    # 이름표 태그 패턴 (NAME:, [이름], -[이름], 이름:)
    _NAME_TAG_PATTERNS = [
        re.compile(r'^[A-Z][A-Za-z\s]+:\s*'),           # JOHN: , John Smith:
        re.compile(r'^\[[^\]]{1,30}\]\s*'),               # [John] , [존]
        re.compile(r'^-\s*\[[^\]]{1,30}\]\s*'),           # -[John]
        re.compile(r'^-\s*[A-Z][A-Za-z]+:\s*'),           # -JOHN:
        re.compile(r'^[가-힣]{1,10}:\s+'),                # 존: , 형사:
    ]
    # "당신" 치환 패턴 (부부싸움/적대 도발/가사 외)
    _DANGSHIN_PATTERNS = [
        (re.compile(r'당신이\s'), '네가 '),
        (re.compile(r'당신을\s'), '너를 '),
        (re.compile(r'당신의\s'), '네 '),
        (re.compile(r'당신에게\s'), '너에게 '),
        (re.compile(r'당신은\s'), ''),                    # 주어 생략
        (re.compile(r'당신도\s'), '너도 '),
    ]
    # 영문 지문 감지 (괄호 안 영어만 남은 경우)
    _ENGLISH_STAGE_DIR = re.compile(r'\(([A-Za-z\s,.\'-]{3,})\)')
    # 릴리즈/메타데이터 패턴 (자막 본문이 아닌 태그)
    _RELEASE_NOISE = re.compile(
        r'(?i)(yts\.|yify|opensubtitles|addic7ed|subscene|subtitle[sd]?\s*by'
        r'|translated\s*by|번역[:\s]|자막[:\s]|싱크[:\s]|sync[:\s]|encoded\s*by'
        r'|www\.|http|\.com|\.org|\.net|download|rip(?:ped)?\s*by'
        r'|bluray|brrip|webrip|hdtv|x264|x265|aac|srt)',
    )

    period_count = 0
    expression_count = 0
    format_count = 0
    auth_drift_count = 0
    submissive_formal_count = 0
    nametag_count = 0
    dangshin_count = 0

    for block in blocks:
        ko = block.get("ko", "")
        if not ko or not ko.strip():
            continue

        text = ko
        changed = False

        # 0-pre. 릴리즈/메타데이터 노이즈 삭제
        en_text = block.get("en", "")
        if _RELEASE_NOISE.search(en_text) or _RELEASE_NOISE.search(text):
            block["ko"] = ""
            nametag_count += 1
            continue

        # 0-a. 이름표 태그 삭제 (NAME:, [이름], -[이름])
        for line_idx_inner, raw_line in enumerate(text.split("\n")):
            for ntp in _NAME_TAG_PATTERNS:
                if ntp.match(raw_line):
                    cleaned = ntp.sub('', raw_line).strip()
                    if cleaned:
                        text = text.replace(raw_line, cleaned, 1)
                        nametag_count += 1
                        changed = True
                    break  # 한 줄에 패턴 하나만

        # 0-b. "당신" 치환 (2인칭 대명사 → 생략/호칭 변환)
        if "당신" in text:
            for pattern, replacement in _DANGSHIN_PATTERNS:
                if pattern.search(text):
                    text = pattern.sub(replacement, text)
                    dangshin_count += 1
                    changed = True

        # 0-c. 영문 지문 미번역 경고 로깅 (치환은 LLM 영역)
        eng_dirs = _ENGLISH_STAGE_DIR.findall(text)
        for ed in eng_dirs:
            # 순수 영어 단어만 있으면 미번역 지문
            if ed.strip() and not any('\uAC00' <= c <= '\uD7A3' for c in ed):
                import logging
                logging.warning(f"[Pass 5.1] 미번역 영문 지문 감지: ({ed})")

        # 1. 금기어 치환
        for pattern, replacement in prohibited_replacements:
            if pattern.search(text):
                text = pattern.sub(replacement, text)
                expression_count += 1
                changed = True

        # 2. 말줄임표 통일
        if "..." in text:
            text = re.sub(r'\.{3,}', '\u2026', text)
            format_count += 1
            changed = True

        # 3. 효과음 괄호 통일
        if any(c in text for c in "【〔［"):
            text = re.sub(r'[【〔［]', '(', text)
            text = re.sub(r'[】〕］]', ')', text)
            format_count += 1
            changed = True

        # 4. 마침표 전면 제거 (격식 어미 포함, 자막에서는 마침표 불필요)
        lines = text.split("\n")
        cleaned_lines = []
        for line in lines:
            trimmed = line.rstrip()
            if trimmed.endswith("\u2026") or trimmed.endswith("!") or trimmed.endswith("?"):
                cleaned_lines.append(line)
                continue
            if trimmed.endswith("."):
                period_count += 1
                changed = True
                cleaned_lines.append(re.sub(r'\.$', '', line))
            else:
                cleaned_lines.append(line)
        text = "\n".join(cleaned_lines)

        # 5. 권위적 하향 관계 톤 교정 (Drift Defense)
        speaker = (block.get("speaker") or "").strip()
        addressee = (block.get("addressee") or "").strip()
        if speaker and addressee and _is_downward_relation(speaker, addressee):
            # 호칭 동기화: 하대 호칭이 있으면 존댓말 어미 무조건 치환
            has_downward_honorific = any(h in text for h in _DOWNWARD_HONORIFICS)
            has_formal_question = any(p.search(text) for p, _ in _AUTH_DRIFT_PATTERNS)
            if has_downward_honorific or has_formal_question:
                for pattern, replacement in _AUTH_DRIFT_PATTERNS:
                    if pattern.search(text):
                        text = pattern.sub(replacement, text)
                        auth_drift_count += 1
                        changed = True

        # 6. 피압박자 격식체 강제 (Submissive Formal)
        elif speaker and addressee and _is_submissive_relation(speaker, addressee):
            # 해요체 → 하십시오체 치환
            for pattern, replacement in _SUBMISSIVE_FORMAL_PATTERNS:
                if pattern.search(text):
                    text = pattern.sub(replacement, text)
                    submissive_formal_count += 1
                    changed = True

        if changed:
            block["ko"] = text

    return {
        "period_count": period_count,
        "expression_count": expression_count,
        "format_count": format_count,
        "auth_drift_count": auth_drift_count,
        "submissive_formal_count": submissive_formal_count,
        "nametag_count": nametag_count,
        "dangshin_count": dangshin_count,
    }


def _sanitize_subtitle_text(text: str) -> str:
    """번역 전 자막 텍스트 정제"""
    if not text:
        return ""
    cleaned = re.sub(r'<[^>]+>', '', text)
    cleaned = re.sub(r'\{\\[^}]+\}', '', cleaned)
    cleaned = re.sub(r'[ \t]+', ' ', cleaned)
    cleaned = "\n".join(line.strip() for line in cleaned.split("\n") if line.strip())
    return cleaned.strip()


# ═══════════════════════════════════════════════════════════════════════════════
# _detect_side_talk() — 방백/대상 전환 감지 (Micro-Context Switching)
# ═══════════════════════════════════════════════════════════════════════════════

# 호칭 사전: vocative → 기본 말투 추론용
_VOCATIVE_DICT = {
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
_TRAILING_VOCATIVE_RE = re.compile(
    r",\s+(" + "|".join(re.escape(v) for v in _VOCATIVE_DICT) + r")[\s?!.]*$",
    re.IGNORECASE,
)
_LEADING_VOCATIVE_RE = re.compile(
    r"^(" + "|".join(re.escape(v) for v in _VOCATIVE_DICT) + r"),\s+",
    re.IGNORECASE,
)


def _detect_side_talk(
    api_blocks: list,
    character_relations: dict,
    persona_names: list,
) -> dict:
    """
    영어 원문에서 vocative(호칭격) 패턴을 감지하여
    한 블록 내에서 대상이 전환되는 방백(side-talk)을 찾는다.

    Returns: {block_index: {vocative, vocative_target, position, relation}}
    """
    result = {}

    # 캐릭터 이름 → 소문자 매핑
    name_lower_map = {}
    for name in persona_names:
        if name and name.strip():
            name_lower_map[name.strip().lower()] = name.strip()

    # 이름 기반 trailing/leading 패턴도 동적 생성
    all_vocatives = list(_VOCATIVE_DICT.keys())
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
        m = _TRAILING_VOCATIVE_RE.search(text)
        if m:
            vocative_word = m.group(1).lower()
            position = "trailing"

        # 2) 호칭 사전 매칭 (leading)
        if not vocative_word:
            m = _LEADING_VOCATIVE_RE.match(text)
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
        if not vocative_target and vocative_word in _VOCATIVE_DICT:
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
        if not relation and vocative_word in _VOCATIVE_DICT:
            relation = _VOCATIVE_DICT[vocative_word]

        result[idx] = {
            "vocative": vocative_word,
            "vocative_target": vocative_target,
            "position": position,
            "relation": relation,
        }

    return result


# ═══════════════════════════════════════════════════════════════════════════════
# _run_translation_job() — 백엔드 오케스트레이터 (Pass 1~5.1)
# ═══════════════════════════════════════════════════════════════════════════════

async def _run_translation_job(job_id: str, request: TranslateAllRequest):
    """Pass 1~5.1을 백엔드에서 자체 실행하는 오케스트레이터."""
    job = _jobs[job_id]
    blocks = list(request.blocks)  # [{id, start, end, en, speaker, addressee}]

    meta = request.metadata or {}
    strategy = request.strategy or {}
    char_relations = request.character_relations or {}
    confirmed_levels = request.confirmed_speech_levels or {}
    options = request.options or {}
    include_qc = options.get("include_qc", True)

    tone_memory: list = []
    total_applied = 0

    try:
        # ═══ 메타데이터 조립 ═══
        title = meta.get("title", "Unknown")
        genre_raw = meta.get("genre", "Drama")
        genre = ", ".join(genre_raw) if isinstance(genre_raw, list) else str(genre_raw or "Drama")
        synopsis_parts = [
            meta.get("detailed_plot", ""),
            meta.get("omdb_full_plot", ""),
            meta.get("wikipedia_plot", ""),
            meta.get("synopsis", ""),
            strategy.get("content_analysis", {}).get("summary", "") if isinstance(strategy.get("content_analysis"), dict) else "",
        ]
        full_synopsis = "\n\n".join(p for p in synopsis_parts if p)

        personas_list = strategy.get("character_personas", [])
        detailed_personas_lines = []
        for p in personas_list:
            if not isinstance(p, dict):
                continue
            line = p.get("name", "")
            if p.get("gender"):
                line += f" ({p['gender']})"
            if p.get("role"):
                line += f" [{p['role']}]"
            if p.get("tone_archetype"):
                line += f" <Type {p['tone_archetype']}>"
            line += f": {p.get('description', '')}"
            line += f" | 말투: {p.get('speech_style', '')}"
            if p.get("speech_level_default"):
                line += f" | 기본: {p['speech_level_default']}"
            if p.get("speech_pattern_markers"):
                line += f" | 특징: {p['speech_pattern_markers']}"
            detailed_personas_lines.append(line)
        detailed_personas = "\n".join(detailed_personas_lines) or "General"

        fixed_terms = ", ".join(
            f"{t.get('original', '')} → {t.get('translation', '')}"
            for t in strategy.get("fixed_terms", [])
            if isinstance(t, dict)
        )
        # translation_rules가 딕셔너리列表인 경우 문자열로 변환
        raw_rules = strategy.get("translation_rules", [])
        translation_rules_lines = []
        for r in raw_rules:
            if isinstance(r, dict):
                translation_rules_lines.append(f"{r.get('rule', '')}: {r.get('description', '')}")
            elif isinstance(r, str):
                translation_rules_lines.append(r)
        translation_rules = "\n".join(translation_rules_lines)

        content_rating = meta.get("rated", "")

        # ═══ Pass 1: 시맨틱 배치 번역 ═══
        job["current_pass"] = "Pass 1: 메인 번역"
        job["logs"].append(f"> [Pass 1] 시맨틱 배칭 시작...")

        batches = _build_semantic_batches(blocks)
        num_batches = len(batches)
        job["logs"].append(f"> [Pass 1] {len(blocks)}개 자막 → {num_batches}개 배치")

        failed_batches: set = set()
        context_size = 10

        # Side-Talk 감지용 페르소나 이름 목록
        persona_names = [p.get("name", "") for p in personas_list if isinstance(p, dict)]

        async def process_batch(batch_idx: int, is_retry: bool = False) -> bool:
            nonlocal total_applied, tone_memory, confirmed_levels
            if job.get("cancelled"):
                return False

            batch = batches[batch_idx]
            batch_blocks = batch["blocks"]
            retry_label = " (재시도)" if is_retry else ""

            # 블록 준비
            api_blocks = []
            for s in batch_blocks:
                duration = _compute_block_duration(s)
                max_chars = _compute_max_chars(duration)
                cps_warning = f"[{duration:.1f}초] {max_chars}자 이내 요약" if duration < 2.0 else None
                api_blocks.append({
                    "index": s.get("id"),
                    "start": s.get("start", ""),
                    "end": s.get("end", ""),
                    "text": _sanitize_subtitle_text(s.get("en", "")),
                    "speaker": s.get("speaker"),
                    "addressee": s.get("addressee"),
                    "duration_sec": duration,
                    "max_chars": max_chars,
                    "cps_warning": cps_warning,
                })

            # Side-Talk Detection (방백/대상 전환 감지)
            side_talk_map = _detect_side_talk(api_blocks, char_relations, persona_names)
            for api_block in api_blocks:
                st = side_talk_map.get(api_block["index"])
                if st:
                    api_block["side_talk"] = st

            # 이전 컨텍스트
            global_start = batch["start_idx"]
            prev_context = []
            if global_start > 0:
                for s in blocks[max(0, global_start - context_size):global_start]:
                    if s.get("ko"):
                        prev_context.append({
                            "index": s.get("id"),
                            "original": s.get("en", ""),
                            "translated": s.get("ko", ""),
                        })

            context_info = {
                "title": title,
                "synopsis": full_synopsis,
                "genre": genre,
                "personas": detailed_personas,
                "fixed_terms": fixed_terms,
                "translation_rules": translation_rules,
                "prev_context": prev_context,
                "character_relations": char_relations,
                "confirmed_speech_levels": confirmed_levels,
                "tone_memory": tone_memory[-50:],
                "batch_mood": batch.get("batch_mood", ""),
                "content_rating": content_rating,
            }

            job["logs"].append(
                f"> [{batch_idx + 1}/{num_batches}]{retry_label} "
                f"자막 {api_blocks[0]['index']}~{api_blocks[-1]['index']} ({len(api_blocks)}개) 번역 중..."
            )

            try:
                translations = await translate_single_batch(api_blocks, context_info)
            except Exception as e:
                job["logs"].append(f"  ⚠ [{batch_idx + 1}]{retry_label} 요청 실패: {e}")
                return False

            # 결과 적용 (ID 타입 통일: int로 비교)
            valid_ids = set()
            for s in batch_blocks:
                bid = s.get("id")
                if bid is not None:
                    valid_ids.add(int(bid))

            batch_count = 0
            for trans in translations:
                trans_idx = trans.get("index")
                if trans_idx is None:
                    continue
                trans_idx = int(trans_idx)
                if trans_idx not in valid_ids:
                    continue
                idx = next((i for i, b in enumerate(blocks) if int(b.get("id", -1)) == trans_idx), None)
                if idx is not None:
                    blocks[idx]["ko"] = trans["text"]
                    total_applied += 1
                    batch_count += 1

            job["logs"].append(
                f"  ✓ [{batch_idx + 1}/{num_batches}]{retry_label} 완료 (+{batch_count}개, 총 {total_applied}개)"
            )

            # 중간 결과 업데이트 (폴링 시 실시간 반영용)
            job["partial_subtitles"] = [
                {"id": b.get("id"), "ko": b.get("ko", "")}
                for b in blocks if b.get("ko") and b["ko"].strip()
            ]

            # 톤 메모리 업데이트 (✅ PASS 2: confirmed_levels 함께 전달)
            result_blocks = blocks[batch["start_idx"]:batch["start_idx"] + len(batch_blocks)]
            tone_memory = _extract_tone_from_batch(result_blocks, tone_memory, confirmed_levels)

            prev_mood = batches[batch_idx - 1].get("batch_mood", "") if batch_idx > 0 else ""
            confirmed_levels = _update_confirmed_speech_levels(
                result_blocks, confirmed_levels,
                scene_break=batch.get("scene_break", False),
                prev_mood=prev_mood,
                current_mood=batch.get("batch_mood", ""),
            )

            return batch_count > 0

        # 병렬 그룹 실행 (3개씩)
        CONCURRENCY = 3
        for group_start in range(0, num_batches, CONCURRENCY):
            if job.get("cancelled"):
                break
            group_end = min(group_start + CONCURRENCY, num_batches)
            group_indices = list(range(group_start, group_end))

            if len(group_indices) > 1:
                job["logs"].append(f"  ⚡ [병렬] 배치 {group_start + 1}~{group_end} 동시 처리 중...")

            tasks = [process_batch(idx) for idx in group_indices]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for i, result in enumerate(results):
                if isinstance(result, Exception) or not result:
                    failed_batches.add(group_indices[i])

            # 진행률: 12% → 80%
            progress = 12 + int((group_end / num_batches) * 68)
            job["progress"] = min(progress, 80)

        # ═══ Pass 2: 실패 재시도 ═══
        if failed_batches and not job.get("cancelled"):
            job["current_pass"] = "Pass 2: 실패 재시도"
            job["logs"].append(f"> [Pass 2] {len(failed_batches)}개 실패 배치 재시도 중...")
            retry_arr = sorted(failed_batches)
            for ri, batch_idx in enumerate(retry_arr):
                if job.get("cancelled"):
                    break
                await asyncio.sleep(3)
                success = await process_batch(batch_idx, is_retry=True)
                if success:
                    failed_batches.discard(batch_idx)
                job["progress"] = 80 + int(((ri + 1) / len(retry_arr)) * 5)

            if failed_batches:
                job["logs"].append(f"  ⚠ {len(failed_batches)}개 배치 최종 실패")

        job["progress"] = 85

        # ═══ Pass 3: 미번역 보충 ═══
        if not job.get("cancelled"):
            job["current_pass"] = "Pass 3: 미번역 보충"
            untranslated = [(i, b) for i, b in enumerate(blocks) if not b.get("ko") or not b["ko"].strip()]

            if untranslated and len(untranslated) <= len(blocks) * 0.5:
                job["logs"].append(f"> [Pass 3] 미번역 {len(untranslated)}개 보충 번역 시작...")
                fill_batch_size = 10

                async def fill_chunk(chunk):
                    if job.get("cancelled"):
                        return
                    nonlocal total_applied
                    first_idx = chunk[0][0]
                    api_blocks = []
                    for idx, s in chunk:
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

                    # Side-Talk Detection (Pass 3)
                    st_map = _detect_side_talk(api_blocks, char_relations, persona_names)
                    for ab in api_blocks:
                        st = st_map.get(ab["index"])
                        if st:
                            ab["side_talk"] = st

                    prev_ctx = []
                    for s in blocks[max(0, first_idx - 5):first_idx]:
                        if s.get("ko"):
                            prev_ctx.append({"index": s.get("id"), "original": s.get("en", ""), "translated": s.get("ko", "")})

                    ctx = {
                        "title": title, "synopsis": full_synopsis[:500], "genre": genre,
                        "personas": detailed_personas, "fixed_terms": fixed_terms,
                        "translation_rules": translation_rules, "prev_context": prev_ctx,
                        "character_relations": char_relations, "confirmed_speech_levels": confirmed_levels,
                    }
                    try:
                        results = await translate_single_batch(api_blocks, ctx)
                        for trans in results:
                            t_idx = int(trans["index"]) if trans.get("index") is not None else None
                            if t_idx is None:
                                continue
                            bi = next((i for i, b in enumerate(blocks) if int(b.get("id", -1)) == t_idx), None)
                            if bi is not None and (not blocks[bi].get("ko") or not blocks[bi]["ko"].strip()):
                                blocks[bi]["ko"] = trans["text"]
                                total_applied += 1
                    except Exception:
                        pass

                # 청크 분할 + 병렬
                chunks = []
                for ci in range(0, len(untranslated), fill_batch_size):
                    chunks.append(untranslated[ci:ci + fill_batch_size])

                for gi in range(0, len(chunks), CONCURRENCY):
                    if job.get("cancelled"):
                        break
                    group = chunks[gi:gi + CONCURRENCY]
                    await asyncio.gather(*(fill_chunk(c) for c in group), return_exceptions=True)

                still_missing = sum(1 for b in blocks if not b.get("ko") or not b["ko"].strip())
                if still_missing > 0:
                    job["logs"].append(f"  ⚠ 보충 후에도 {still_missing}개 미번역 남음")
                else:
                    job["logs"].append(f"  ✓ 보충 번역 완료! 미번역 0개")

        # ═══ Pass 3.5: 중복 감지 + 재번역 ═══
        if not job.get("cancelled"):
            job["current_pass"] = "Pass 3.5: 중복 제거"
            dedup_indices = _detect_dedup(blocks)
            if dedup_indices:
                job["logs"].append(f"  🔧 [Pass 3.5] 연속 중복 {len(dedup_indices)}개 감지 → 재번역")
                for di in dedup_indices:
                    blocks[di]["ko"] = ""

                # 재번역
                dedup_empty = [(i, blocks[i]) for i in dedup_indices if i < len(blocks)]
                if dedup_empty and len(dedup_empty) <= 50:

                    async def retranslate_single(idx, block):
                        if job.get("cancelled"):
                            return
                        nonlocal total_applied
                        prev_ctx = [{"index": b.get("id"), "original": b.get("en", ""), "translated": b.get("ko", "")}
                                    for b in blocks[max(0, idx - 3):idx] if b.get("ko")]
                        next_ctx = [{"index": b.get("id"), "original": b.get("en", ""), "translated": b.get("ko", "")}
                                    for b in blocks[idx + 1:min(len(blocks), idx + 3)] if b.get("ko")]
                        duration = _compute_block_duration(block)
                        api_block = {
                            "index": block.get("id"), "start": block.get("start", ""), "end": block.get("end", ""),
                            "text": _sanitize_subtitle_text(block.get("en", "")),
                            "speaker": block.get("speaker"), "addressee": block.get("addressee"),
                            "duration_sec": duration, "max_chars": _compute_max_chars(duration),
                        }
                        # Side-Talk Detection (Pass 3.5)
                        st_map = _detect_side_talk([api_block], char_relations, persona_names)
                        st = st_map.get(api_block["index"])
                        if st:
                            api_block["side_talk"] = st

                        ctx = {
                            "title": title, "synopsis": full_synopsis[:300], "genre": genre,
                            "personas": detailed_personas, "fixed_terms": fixed_terms,
                            "translation_rules": translation_rules,
                            "prev_context": prev_ctx + next_ctx,
                            "character_relations": char_relations,
                            "confirmed_speech_levels": confirmed_levels,
                        }
                        try:
                            results = await translate_single_batch([api_block], ctx)
                            if results and results[0].get("text"):
                                blocks[idx]["ko"] = results[0]["text"]
                                total_applied += 1
                        except Exception:
                            pass

                    for gi in range(0, len(dedup_empty), CONCURRENCY):
                        if job.get("cancelled"):
                            break
                        group = dedup_empty[gi:gi + CONCURRENCY]
                        await asyncio.gather(*(retranslate_single(i, b) for i, b in group), return_exceptions=True)

                    job["logs"].append(f"  ✓ [Pass 3.5] 중복 재번역 완료")

        job["progress"] = 90

        # ═══ Pass 4: QC 후처리 ═══
        if not job.get("cancelled") and include_qc:
            job["current_pass"] = "Pass 4: QC 교정"
            translated_blocks = [b for b in blocks if b.get("ko") and b["ko"].strip()]
            if translated_blocks:
                job["logs"].append(f"> [Pass 4] LLM-as-Judge QC — {len(translated_blocks)}개 블록 교정 중...")

                qc_batch_size = 40
                qc_total = math.ceil(len(blocks) / qc_batch_size)
                qc_applied = 0

                async def qc_batch(qi: int) -> int:
                    if job.get("cancelled"):
                        return 0
                    qc_start = qi * qc_batch_size
                    qc_end = min(qc_start + qc_batch_size, len(blocks))
                    qc_blocks = blocks[qc_start:qc_end]
                    if not any(b.get("ko") and b["ko"].strip() for b in qc_blocks):
                        return 0

                    qc_api_blocks = [{
                        "index": b.get("id"), "start": b.get("start", ""), "end": b.get("end", ""),
                        "en": b.get("en", ""), "ko": b.get("ko", ""),
                    } for b in qc_blocks]

                    try:
                        translator = get_vertex_ai()

                        # QC용 페이로드 구성
                        source_lines = []
                        for b in qc_api_blocks:
                            text = b["ko"] if b["ko"] and b["ko"].strip() else b["en"]
                            source_lines.append(f"{b['index']}: {text}")
                        source_payload = "\n".join(source_lines)

                        user_parts = [f"[작품: {title} / 장르: {genre}]"]
                        if detailed_personas and detailed_personas != "General":
                            user_parts.append(f"\n[등장인물 말투]\n{detailed_personas}")
                        user_parts.append(f"\n다음 번역된 자막을 QC 규칙에 따라 교정하세요:\n\n{source_payload}")
                        user_prompt = "\n".join(user_parts)

                        system_instruction = QC_SYSTEM_PROMPT
                        if translation_rules:
                            system_instruction += f"\n\n📌 [추가 번역 규칙 — 반드시 준수]\n{translation_rules}"

                        def make_qc_call(attempt=0, max_retries=3):
                            return translator.client.models.generate_content(
                                model=translator.model,
                                contents=user_prompt,
                                config={
                                    "system_instruction": system_instruction,
                                    "max_output_tokens": 32768,
                                    "temperature": 0.1,
                                    "thinking_config": {"thinking_budget": 1024},
                                }
                            )

                        response, error = translator._retry_with_backoff(make_qc_call)
                        if error:
                            return 0

                        raw_content = response.text
                        parsed = _parse_translation_response(raw_content, qc_api_blocks)

                        # 번역투 제거 + 마침표 제거
                        for item in parsed:
                            if item.get("text"):
                                cleaned = _remove_translationese(item["text"])
                                if cleaned != item["text"]:
                                    item["text"] = cleaned
                                cleaned2 = remove_periods(item["text"])
                                if cleaned2 != item["text"]:
                                    item["text"] = cleaned2

                        batch_fixed = 0
                        for corr in parsed:
                            bi = next((i for i, b in enumerate(blocks) if b.get("id") == corr["index"]), None)
                            if bi is not None and corr.get("text") and corr["text"].strip():
                                if corr["text"] == blocks[bi].get("en"):
                                    continue
                                if corr["text"] != blocks[bi].get("ko"):
                                    blocks[bi]["ko"] = corr["text"]
                                    batch_fixed += 1

                        job["logs"].append(f"    ✓ [QC {qi + 1}/{qc_total}] {batch_fixed}개 교정됨" if batch_fixed > 0 else f"    ✓ [QC {qi + 1}/{qc_total}] 교정 없음 (원본 유지)")
                        return batch_fixed
                    except Exception as e:
                        job["logs"].append(f"  ⚠ [QC {qi + 1}] 실패: {e}")
                        return 0

                for gi in range(0, qc_total, CONCURRENCY):
                    if job.get("cancelled"):
                        break
                    group_end = min(gi + CONCURRENCY, qc_total)
                    group_results = await asyncio.gather(*(qc_batch(i) for i in range(gi, group_end)), return_exceptions=True)
                    for r in group_results:
                        if isinstance(r, int):
                            qc_applied += r
                    job["progress"] = 90 + int(((group_end) / qc_total) * 10)

                job["logs"].append(f"  ✓ [Pass 4] QC 완료 — {qc_applied}개 교정됨")

        # ═══ Pass 5.1: 하드코딩 후처리 ═══
        if not job.get("cancelled"):
            job["current_pass"] = "Pass 5.1: 후처리"
            stats = _apply_postprocess(blocks, confirmed_levels, char_relations)
            total_clean = stats["period_count"] + stats["expression_count"] + stats["format_count"] + stats.get("auth_drift_count", 0) + stats.get("submissive_formal_count", 0) + stats.get("nametag_count", 0) + stats.get("dangshin_count", 0)
            if total_clean > 0:
                details = ", ".join(filter(None, [
                    f"마침표 {stats['period_count']}개" if stats["period_count"] else "",
                    f"금기어 {stats['expression_count']}개" if stats["expression_count"] else "",
                    f"서식 {stats['format_count']}개" if stats["format_count"] else "",
                    f"권위톤 교정 {stats['auth_drift_count']}개" if stats.get("auth_drift_count") else "",
                    f"격식체 교정 {stats['submissive_formal_count']}개" if stats.get("submissive_formal_count") else "",
                    f"이름표 삭제 {stats['nametag_count']}개" if stats.get("nametag_count") else "",
                    f"당신 치환 {stats['dangshin_count']}개" if stats.get("dangshin_count") else "",
                ]))
                job["logs"].append(f"  ✓ [Pass 5.1] 후처리 완료 — {details} 정리됨")

        # ═══ 완료 ═══
        job["progress"] = 100
        job["status"] = "complete"
        job["current_pass"] = "완료"

        # 번역된 결과를 {id, ko} 형태로 저장
        result_subtitles = []
        for b in blocks:
            result_subtitles.append({
                "id": b.get("id"),
                "ko": b.get("ko", ""),
            })

        translated_count = sum(1 for b in blocks if b.get("ko") and b["ko"].strip())
        job["result"] = {
            "subtitles": result_subtitles,
            "stats": {
                "total": len(blocks),
                "translated": translated_count,
                "failed_batches": len(failed_batches),
            }
        }
        job["logs"].append(f"[OK] 번역 완료! {translated_count}/{len(blocks)}개 적용됨")

    except Exception as e:
        job["status"] = "failed"
        job["error"] = str(e)
        job["logs"].append(f"[ERROR] {type(e).__name__}: {e}")
        print(f"[JOB {job_id}] Fatal error: {e}")
        traceback.print_exc()


class SubtitleBlock(BaseModel):
    index: int
    start: str
    end: str
    text: str
    # V3: 화자 식별 + CPS
    speaker: Optional[str] = None
    addressee: Optional[str] = None
    duration_sec: Optional[float] = None
    max_chars: Optional[int] = None
    cps_warning: Optional[str] = None

class PrevContextItem(BaseModel):
    index: int
    original: str
    translated: str

class TranslationRequest(BaseModel):
    blocks: List[SubtitleBlock]
    # 영화 정보
    title: Optional[str] = ""
    synopsis: Optional[str] = ""
    genre: str
    # 캐릭터 및 번역 컨텍스트
    personas: str
    fixed_terms: Optional[str] = ""  # 고정 용어 (원어 → 번역)
    translation_rules: Optional[str] = ""  # 번역 규칙
    target_lang: str = "ko"
    prev_context: Optional[List[PrevContextItem]] = None  # 이전 배치 컨텍스트
    # 화자 식별 기반 말투 일관성 데이터
    character_relations: Optional[dict] = None
    confirmed_speech_levels: Optional[dict] = None
    # V3: 톤 메모리 + 배치 무드 + 연령 등급
    tone_memory: Optional[List[dict]] = None
    batch_mood: Optional[str] = None
    content_rating: Optional[str] = None

@router.post("/diagnostic")
async def run_diagnostic(file: UploadFile = File(...)):
    try:
        content = await file.read()
        srt_text = content.decode("utf-8")
        report_text = diagnostic.generate_engineering_report(srt_text)
        
        # 상세 데이터 추출 루틴
        blocks = logic_gate.bit_level_mirroring(srt_text)
        
        return {
            "status": "success",
            "report": report_text,
            "blocks": blocks,
            "stats": {
                "total_count": len(blocks),
                "complexity": diagnostic.linguistic_profiling(srt_text)["complexity_score"]
            }
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Diagnostic failed: {str(e)}")

@router.post("/batch-translate")
async def translate_subtitles(request: TranslationRequest):
    """
    📽️ Core Execution: 배치 번역 (프론트엔드에서 배치 단위로 호출)

    Returns structured response with error handling and parsed translations.
    """
    print(f"[Backend] Translating {len(request.blocks)} blocks for '{request.title}'")

    context_info = {
        # 영화 정보
        "title": request.title,
        "synopsis": request.synopsis,
        "genre": request.genre,
        # 캐릭터 및 번역 컨텍스트
        "personas": request.personas,
        "fixed_terms": request.fixed_terms,
        "translation_rules": request.translation_rules,
        # 이전 번역 컨텍스트
        "prev_context": [p.dict() for p in request.prev_context] if request.prev_context else [],
        # 화자 식별 기반 말투 일관성
        "character_relations": request.character_relations or {},
        "confirmed_speech_levels": request.confirmed_speech_levels or {},
        # V3: 톤 메모리 + 배치 무드 + 연령 등급
        "tone_memory": request.tone_memory or [],
        "batch_mood": request.batch_mood or "",
        "content_rating": request.content_rating or "",
    }

    # Pydantic 모델을 dict 리스트로 변환
    batch_dicts = [b.dict() for b in request.blocks]

    try:
        # Vertex AI 호출 (재시도 로직 포함)
        result = await get_vertex_ai().translate_batch(batch_dicts, context_info)

        # 에러 체크
        if not result.get("success"):
            print(f"[ERROR] Translation failed: {result.get('error')}")
            return {
                "status": "error",
                "error": result.get("error", "Unknown error"),
                "total_batches": 1,
                "data": []
            }

        # 원시 응답에서 파싱
        raw_content = result.get("data", "")
        parsed_translations = _parse_translation_response(raw_content, batch_dicts)

        # 🔧 자동 후처리: 슬래시 줄바꿈 변환
        slash_fixed_count = 0
        for trans in parsed_translations:
            if trans.get("text") and " / " in trans["text"]:
                trans["text"] = trans["text"].replace(" / ", "\n")
                slash_fixed_count += 1

        print(f"[Backend] Parsed {len(parsed_translations)} translations (slash fixed: {slash_fixed_count})")

        # 품질 검증 (non-fatal)
        quality_summary = None
        try:
            quality_subs = []
            for block in batch_dicts:
                trans_text = ""
                for t in parsed_translations:
                    if t.get("index") == block["index"]:
                        trans_text = t.get("text", "")
                        break
                quality_subs.append({"id": block["index"], "en": block["text"], "ko": trans_text})

            checker = TranslationQualityChecker()
            report = checker.check_quality(quality_subs)

            # 슬래시 오류 자동 수정
            if report.slash_errors:
                fixed_subs, fix_count = checker.auto_fix_slash_errors(quality_subs)
                for fs in fixed_subs:
                    for t in parsed_translations:
                        if t.get("index") == fs["id"] and fs["ko"] != t.get("text"):
                            t["text"] = fs["ko"]

            quality_summary = {
                "untranslated_count": len(report.untranslated_lines),
                "untranslated_indices": [i.line_number for i in report.untranslated_lines],
                "translation_smell_count": len(report.translation_smell),
            }
        except Exception as qe:
            print(f"[WARN] Quality check failed (non-fatal): {qe}")
            quality_summary = {"error": str(qe)}

        return {
            "status": "complete",
            "total_batches": 1,
            "truncated": result.get("truncated", False),
            "expected_count": len(batch_dicts),
            "received_count": len(parsed_translations),
            "quality": quality_summary,
            "data": [{
                "batch_index": 0,
                "content": parsed_translations,  # 파싱된 배열 반환
                "raw_content": raw_content  # 디버깅용 원시 데이터
            }]
        }

    except Exception as e:
        print(f"[ERROR] Batch translation exception: {type(e).__name__}: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Translation failed: {str(e)}")


# ═══════════════════════════════════════════════════════════════════════════════
# 번역 오케스트레이션 API — translate-all (Pass 1~5.1 백엔드 일괄 실행)
# ═══════════════════════════════════════════════════════════════════════════════

@router.post("/translate-all")
async def translate_all(request: TranslateAllRequest):
    """
    🚀 번역 전체 오케스트레이션 시작.
    Pass 1~5.1을 백엔드에서 자체 루프로 실행.
    프론트는 job_id로 폴링만 수행.
    """
    job_id = uuid.uuid4().hex[:12]
    _jobs[job_id] = {
        "status": "running",
        "progress": 0,
        "current_pass": "초기화",
        "logs": [],
        "result": None,
        "cancelled": False,
        "created_at": time.time(),
        "error": None,
    }
    asyncio.create_task(_run_translation_job(job_id, request))
    print(f"[JOB {job_id}] Translation job started ({len(request.blocks)} blocks)")
    return {"job_id": job_id}


@router.get("/translate-status/{job_id}")
async def get_translate_status(job_id: str):
    """
    📊 번역 작업 진행 상태 조회.
    완료/실패 시 결과를 반환하고 job을 정리.
    """
    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    all_logs = job["logs"]
    resp: dict[str, Any] = {
        "status": job["status"],
        "progress": job["progress"],
        "current_pass": job["current_pass"],
        "logs": all_logs[-30:],
        "total_log_count": len(all_logs),
    }

    # 진행 중일 때 중간 결과 포함 (실시간 UI 업데이트용)
    if job["status"] == "running" and job.get("partial_subtitles"):
        resp["partial_subtitles"] = job["partial_subtitles"]

    if job["status"] == "complete":
        resp["result"] = job["result"]
        del _jobs[job_id]
    elif job["status"] == "failed":
        resp["error"] = job["error"]
        del _jobs[job_id]

    return resp


@router.delete("/translate-cancel/{job_id}")
async def cancel_translate_job(job_id: str):
    """
    ❌ 진행 중인 번역 작업 취소.
    """
    if job_id in _jobs:
        _jobs[job_id]["cancelled"] = True
        _jobs[job_id]["logs"].append("[INFO] 번역 취소 요청됨")
        return {"cancelled": True}
    raise HTTPException(status_code=404, detail="Job not found")


# ═══════════════════════════════════════════════════════════════════════════════
# 화자 식별 API
# ═══════════════════════════════════════════════════════════════════════════════

class SpeakerIdBlock(BaseModel):
    index: int
    start: str
    end: str
    text: str

class SpeakerIdRequest(BaseModel):
    blocks: List[SpeakerIdBlock]
    title: str = ""
    synopsis: str = ""
    genre: str = ""
    personas: str = ""
    prev_identified: Optional[List[dict]] = None
    generate_relationships: bool = False
    all_speakers: Optional[List[str]] = None
    dialogue_samples: Optional[dict] = None


@router.post("/identify-speakers")
async def identify_speakers(request: SpeakerIdRequest):
    """
    🎭 화자 식별 — 자막 블록별 화자를 Gemini로 식별
    선택적으로 관계 매트릭스도 함께 생성
    """
    print(f"[Speaker-ID] Identifying speakers for {len(request.blocks)} blocks (title: '{request.title}')")

    # ✅ FIX: relationship-only mode (blocks=[]이면 관계맵만 생성)
    if len(request.blocks) == 0:
        relationships = {}
        if request.generate_relationships and request.all_speakers and len(request.all_speakers) >= 2:
            rel_prompt = build_relationship_prompt(
                speakers=request.all_speakers,
                dialogue_samples=request.dialogue_samples or {},
                title=request.title,
                synopsis=request.synopsis,
                personas=request.personas,
            )

            def make_rel_call(attempt=0, max_retries=3):
                return translator.client.models.generate_content(
                    model=translator.model,
                    contents=rel_prompt,
                    config={
                        "system_instruction": RELATIONSHIP_SYSTEM_PROMPT,
                        "max_output_tokens": 8192,
                        "temperature": 0.1,
                        "thinking_config": {"thinking_budget": 1024},
                    }
                )

            translator = get_vertex_ai()
            rel_response, rel_error = translator._retry_with_backoff(make_rel_call)
            if not rel_error and rel_response:
                relationships = parse_relationship_response(rel_response.text)

        return {"status": "complete", "speakers": [], "relationships": relationships}

    user_prompt = build_speaker_id_prompt(
        blocks=[b.dict() for b in request.blocks],
        title=request.title,
        synopsis=request.synopsis,
        genre=request.genre,
        personas=request.personas,
        prev_identified=request.prev_identified,
    )

    try:
        translator = get_vertex_ai()

        def make_speaker_call(attempt=0, max_retries=3):
            return translator.client.models.generate_content(
                model=translator.model,
                contents=user_prompt,
                config={
                    "system_instruction": SPEAKER_ID_SYSTEM_PROMPT,
                    "max_output_tokens": 16384,
                    "temperature": 0.1,
                    "thinking_config": {"thinking_budget": 1024},
                }
            )

        response, error = translator._retry_with_backoff(make_speaker_call)

        if error:
            print(f"[Speaker-ID ERROR] API call failed: {error}")
            return {"status": "error", "error": error, "speakers": [], "relationships": {}}

        raw_content = response.text
        speakers = parse_speaker_response(raw_content)

        print(f"[Speaker-ID] Identified {len(speakers)} blocks")

        # 관계 매트릭스 생성 (요청 시)
        relationships = {}
        if request.generate_relationships and request.all_speakers and len(request.all_speakers) >= 2:
            rel_prompt = build_relationship_prompt(
                speakers=request.all_speakers,
                dialogue_samples=request.dialogue_samples or {},
                title=request.title,
                synopsis=request.synopsis,
                personas=request.personas,
            )

            def make_rel_call(attempt=0, max_retries=3):
                return translator.client.models.generate_content(
                    model=translator.model,
                    contents=rel_prompt,
                    config={
                        "system_instruction": RELATIONSHIP_SYSTEM_PROMPT,
                        "max_output_tokens": 8192,
                        "temperature": 0.1,
                        "thinking_config": {"thinking_budget": 1024},
                    }
                )

            rel_response, rel_error = translator._retry_with_backoff(make_rel_call)

            if not rel_error and rel_response:
                relationships = parse_relationship_response(rel_response.text)
                print(f"[Speaker-ID] Generated {len(relationships)} relationship pairs")
            else:
                print(f"[Speaker-ID WARN] Relationship generation failed: {rel_error}")

        return {
            "status": "complete",
            "speakers": speakers,
            "relationships": relationships,
        }

    except Exception as e:
        print(f"[Speaker-ID ERROR] Exception: {type(e).__name__}: {e}")
        traceback.print_exc()
        return {"status": "error", "error": str(e), "speakers": [], "relationships": {}}


class TranslatedSubtitle(BaseModel):
    id: int
    start: str
    end: str
    en: str
    ko: str

class SaveTranslationRequest(BaseModel):
    original_filename: str
    title: Optional[str] = ""
    subtitles: List[TranslatedSubtitle]

@router.post("/save-translation")
async def save_translation(request: SaveTranslationRequest):
    """
    번역 완료된 SRT를 서버에 저장
    """
    try:
        # 파일명 생성: 원본파일명_translated_날짜시간.srt
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        base_name = Path(request.original_filename).stem
        safe_name = re.sub(r'[<>:"/\\|?*]', '_', base_name)  # 안전한 파일명
        filename = f"{safe_name}_ko_{timestamp}.srt"
        filepath = STORAGE_PATH / filename

        # SRT 형식으로 저장
        srt_content = []
        for sub in request.subtitles:
            text = sub.ko if sub.ko and sub.ko.strip() else sub.en
            srt_content.append(f"{sub.id}\n{sub.start} --> {sub.end}\n{text}\n")

        with open(filepath, "w", encoding="utf-8") as f:
            f.write("\n".join(srt_content))

        print(f"[OK] Translation saved: {filepath}")

        return {
            "status": "saved",
            "filename": filename,
            "path": str(filepath),
            "subtitle_count": len(request.subtitles),
            "translated_count": len([s for s in request.subtitles if s.ko and s.ko.strip()])
        }
    except Exception as e:
        print(f"[ERROR] Save translation failed: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/translations")
async def list_translations():
    """
    저장된 번역 파일 목록
    """
    try:
        files = []
        for f in STORAGE_PATH.glob("*.srt"):
            stat = f.stat()
            files.append({
                "filename": f.name,
                "size": stat.st_size,
                "created": datetime.fromtimestamp(stat.st_ctime).isoformat(),
                "modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
            })
        # 최신순 정렬
        files.sort(key=lambda x: x["modified"], reverse=True)
        return {"translations": files, "count": len(files)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/translations/{filename}")
async def download_translation(filename: str):
    """
    저장된 번역 파일 다운로드
    """
    filepath = STORAGE_PATH / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="File not found")
    if not filepath.is_file():
        raise HTTPException(status_code=400, detail="Invalid file")
    # 경로 탈출 방지
    if not str(filepath.resolve()).startswith(str(STORAGE_PATH.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")

    return FileResponse(
        path=filepath,
        filename=filename,
        media_type="text/plain; charset=utf-8"
    )

@router.delete("/translations/{filename}")
async def delete_translation(filename: str):
    """
    저장된 번역 파일 삭제
    """
    filepath = STORAGE_PATH / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="File not found")
    # 경로 탈출 방지
    if not str(filepath.resolve()).startswith(str(STORAGE_PATH.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")

    try:
        filepath.unlink()
        return {"status": "deleted", "filename": filename}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/save")
async def save_srt(file_path: str, blocks: List[SubtitleBlock]):
    """Legacy save endpoint - deprecated"""
    try:
        final_content = logic_gate.finalize_srt([b.dict() for b in blocks])
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(final_content)
        return {"status": "saved", "path": file_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# 품질 검사 API
# ═══════════════════════════════════════════════════════════════════════════════

class QualityCheckRequest(BaseModel):
    """품질 검사 요청"""
    subtitles: List[dict]  # [{"id": 1, "en": "...", "ko": "..."}, ...]


class AutoFixRequest(BaseModel):
    """자동 수정 요청"""
    subtitles: List[dict]
    fix_slash_errors: bool = True
    preserve_music_slash: bool = True


@router.post("/quality-check")
async def quality_check(request: QualityCheckRequest):
    """
    🔍 번역 품질 검사

    검사 항목:
    - 미번역 감지 (영어 잔존)
    - 슬래시 줄바꿈 오류
    - 번역투 패턴
    - 말투 일관성
    """
    try:
        report = check_translation_quality(request.subtitles)
        return {
            "status": "complete",
            "report": report
        }
    except Exception as e:
        print(f"[ERROR] Quality check failed: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/auto-fix")
async def auto_fix(request: AutoFixRequest):
    """
    🔧 자동 수정 적용

    수정 항목:
    - 슬래시 줄바꿈 오류 → 실제 줄바꿈으로 변환
    """
    try:
        result = auto_fix_subtitles(
            request.subtitles,
            fix_options={
                "slash_errors": request.fix_slash_errors,
                "preserve_music_slash": request.preserve_music_slash
            }
        )
        return {
            "status": "complete",
            "fixed_subtitles": result["fixed_subtitles"],
            "fixes_applied": result["fixes_applied"]
        }
    except Exception as e:
        print(f"[ERROR] Auto fix failed: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/get-retranslation-targets")
async def get_retranslation(request: QualityCheckRequest):
    """
    🎯 재번역이 필요한 자막 블록 추출

    반환: 미번역된 자막 블록 리스트 (바로 batch-translate에 전달 가능)
    """
    try:
        targets = get_retranslation_targets(request.subtitles)
        return {
            "status": "complete",
            "count": len(targets),
            "targets": targets
        }
    except Exception as e:
        print(f"[ERROR] Get retranslation targets failed: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ═══════════════════════════════════════════════════════════════════════════════
# 실시간 배치 검증 포함 번역 (향상된 버전)
# ═══════════════════════════════════════════════════════════════════════════════

class BatchTranslateWithValidationRequest(BaseModel):
    """실시간 검증 포함 배치 번역 요청"""
    blocks: List[SubtitleBlock]
    title: str = ""
    synopsis: str = ""
    genre: str = "Drama"
    personas: str = ""
    fixed_terms: str = ""
    translation_rules: str = ""
    target_lang: str = "ko"
    prev_context: Optional[List[dict]] = []
    # 검증 옵션
    auto_retry_untranslated: bool = True  # 미번역 자동 재시도
    auto_fix_slash: bool = True  # 슬래시 오류 자동 수정
    max_retries: int = 3  # 최대 재시도 횟수


@router.post("/batch-translate-validated")
async def batch_translate_with_validation(request: BatchTranslateWithValidationRequest):
    """
    🚀 실시간 검증 포함 배치 번역

    프로세스:
    1. 배치 번역 실행
    2. 번역 결과 품질 검사
    3. 미번역 있으면 자동 재시도
    4. 슬래시 오류 자동 수정
    5. 검증 완료된 결과 반환
    """
    print(f"[Backend] Validated translation: {len(request.blocks)} blocks for '{request.title}'")

    context_info = {
        "title": request.title,
        "synopsis": request.synopsis,
        "genre": request.genre,
        "personas": request.personas,
        "fixed_terms": request.fixed_terms,
        "translation_rules": request.translation_rules,
        "prev_context": request.prev_context or []
    }

    batch_dicts = [b.dict() for b in request.blocks]
    checker = TranslationQualityChecker()

    try:
        # 1차 번역
        result = await get_vertex_ai().translate_batch(batch_dicts, context_info)

        if not result.get("success"):
            return {
                "status": "error",
                "error": result.get("error", "Translation failed"),
                "data": []
            }

        # 응답 파싱
        raw_content = result.get("data", "")
        parsed_translations = _parse_translation_response(raw_content, batch_dicts)

        # 번역 결과를 자막 형식으로 변환
        translated_subs = []
        for block in batch_dicts:
            trans = next((t for t in parsed_translations if t["index"] == block["index"]), None)
            translated_subs.append({
                "id": block["index"],
                "en": block["text"],
                "ko": trans["text"] if trans else "",
                "start": block.get("start", ""),
                "end": block.get("end", "")
            })

        # 2. 품질 검사
        untranslated_indices = checker.get_untranslated_indices(translated_subs)
        retry_count = 0

        # 3. 미번역 자동 재시도
        while untranslated_indices and request.auto_retry_untranslated and retry_count < request.max_retries:
            retry_count += 1
            print(f"[Backend] Retrying {len(untranslated_indices)} untranslated blocks (attempt {retry_count})")

            # 미번역 블록만 추출
            retry_blocks = [b for b in batch_dicts if b["index"] in untranslated_indices]

            if retry_blocks:
                retry_result = await get_vertex_ai().translate_batch(retry_blocks, context_info)

                if retry_result.get("success"):
                    retry_parsed = _parse_translation_response(retry_result.get("data", ""), retry_blocks)

                    # 결과 병합
                    for trans in retry_parsed:
                        for sub in translated_subs:
                            if sub["id"] == trans["index"] and trans.get("text"):
                                sub["ko"] = trans["text"]

            # 다시 체크
            untranslated_indices = checker.get_untranslated_indices(translated_subs)

        # 4. 슬래시 오류 자동 수정
        slash_fixed = 0
        if request.auto_fix_slash:
            fixed_subs, slash_fixed = checker.auto_fix_slash_errors(translated_subs)
            translated_subs = fixed_subs

        # 5. 최종 품질 리포트
        final_report = checker.check_quality(translated_subs)

        # 파싱된 형식으로 변환
        final_translations = [{"index": s["id"], "text": s["ko"]} for s in translated_subs]

        print(f"[Backend] Validated: {len(final_translations)} translations, "
              f"retries={retry_count}, slash_fixed={slash_fixed}, "
              f"remaining_untranslated={len(final_report.untranslated_lines)}")

        return {
            "status": "complete",
            "total_batches": 1,
            "truncated": result.get("truncated", False),
            "expected_count": len(batch_dicts),
            "received_count": len(final_translations),
            "validation": {
                "retries_performed": retry_count,
                "slash_errors_fixed": slash_fixed,
                "remaining_untranslated": len(final_report.untranslated_lines),
                "translation_smell_count": len(final_report.translation_smell)
            },
            "data": [{
                "batch_index": 0,
                "content": final_translations,
                "raw_content": raw_content
            }]
        }

    except Exception as e:
        print(f"[ERROR] Validated batch translation exception: {type(e).__name__}: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Translation failed: {str(e)}")


# ═══════════════════════════════════════════════════════════════════════════════
# QC 후처리 API — 번역 완료 후 품질 교정
# ═══════════════════════════════════════════════════════════════════════════════

class QCPostProcessBlock(BaseModel):
    index: int
    start: str
    end: str
    en: str
    ko: str

class QCPostProcessRequest(BaseModel):
    blocks: List[QCPostProcessBlock]
    genre: str = "Drama"
    title: str = ""
    synopsis: Optional[str] = ""
    personas: Optional[str] = ""
    translation_rules: Optional[str] = ""
    prev_context: Optional[List[dict]] = None


def _remove_translationese(text: str) -> str:
    """
    ✅ PASS 3 강화: HUMANIZATION POST FIX
    규칙 기반 번역투 제거 — LLM이 놓친 번역투 대명사를 잡는 안전망.
    '그녀가/그녀는/그녀의' 등 영어 직역투 대명사를 제거하거나 자연스럽게 교체.
    """
    if not text:
        return text

    # 효과음/음악 태그는 건드리지 않음
    if '♪' in text or '♫' in text:
        return text

    lines = text.split('\n')
    result = []

    # ✅ PASS 3: 번역투 패턴 치환
    TRANSLATIONESE_PATTERNS = [
        (re.compile(r'그러나,'), '하지만'),
        (re.compile(r'게다가,'), '그리고'),
        (re.compile(r'나는\s*~라고\s*생각'), '난 ~같아'),
        (re.compile(r'그것은'), '그건'),
        (re.compile(r'이해한다'), '알아'),
        (re.compile(r'두렵다'), '무서워'),
        (re.compile(r'분노한다'), '화났어'),
    ]

    for line in lines:
        stripped = line.strip()
        if not stripped:
            result.append(line)
            continue

        # ✅ PASS 3: 번역투 패턴 치환 적용
        for pattern, replacement in TRANSLATIONESE_PATTERNS:
            stripped = pattern.sub(replacement, stripped)

        # 1) "그녀가/그녀는" 문장 시작 → 제거 (주어 생략)
        stripped = re.sub(r'^그녀[가는]\s+', '', stripped)

        # 2) "그녀의" → 삭제하거나 문맥 유지 (소유격 번역투)
        #    "그녀의 눈" → "눈", "그녀의 말" → "그 말"
        stripped = re.sub(r'그녀의\s+', '', stripped)

        # 3) "그녀를/그녀에게" → 제거
        stripped = re.sub(r'그녀[를에]\s*', '', stripped)
        stripped = re.sub(r'그녀에게\s*', '', stripped)

        # 4) "그들은/그들이/그들의" → 제거
        stripped = re.sub(r'그들[은이의을에]\s*', '', stripped)

        # 5) "그것은/그것이/그것을" → 제거 또는 "그건/그게/그걸"로 축약
        stripped = re.sub(r'그것은\s*', '그건 ', stripped)
        stripped = re.sub(r'그것이\s*', '그게 ', stripped)
        stripped = re.sub(r'그것을\s*', '그걸 ', stripped)

        # 6) "나는/나는" → "난" (구어체)
        stripped = re.sub(r'^나는\s+(?!아니다|모른다)', '난 ', stripped)
        stripped = re.sub(r'\s나는\s', ' 난 ', stripped)

        # 7) "너는" → "넌" (구어체)
        stripped = re.sub(r'^너는\s+', '넌 ', stripped)
        stripped = re.sub(r'\s너는\s', ' 넌 ', stripped)

        # 8) "우리는" → "우린" (구어체)
        stripped = re.sub(r'^우리는\s+', '우린 ', stripped)
        stripped = re.sub(r'\s우리는\s', ' 우린 ', stripped)

        # 9) "당신은" → "당신" 또는 제거
        stripped = re.sub(r'^당신은\s+', '당신 ', stripped)

        # 빈 줄이 되면 원본 유지
        if not stripped.strip():
            result.append(line)
        else:
            result.append(stripped)

    return '\n'.join(result)


def _remove_casual_periods(text: str) -> str:
    """
    규칙 기반 마침표 제거 — LLM이 놓친 마침표를 100% 잡는 안전망.
    반말(구어체) 대사에서 마침표를 제거하고, 존댓말은 유지한다.
    """
    if not text:
        return text

    # 존댓말 종결어미 (마침표 유지 대상)
    FORMAL_ENDINGS = (
        '습니다', '합니다', '입니다', '됩니다', '있습니다', '없습니다',
        '겠습니다', '였습니다', '셨습니다',
        '하십시오', '주십시오', '십시오',
        '세요', '으세요', '하세요', '주세요', '드세요',
        '까요', '나요', '가요', '지요',
    )

    lines = text.split('\n')
    result = []

    for line in lines:
        stripped = line.strip()
        if not stripped:
            result.append(line)
            continue

        # 말줄임표 보존 ("그게...", "뭐...")
        if stripped.endswith('...') or stripped.endswith('..'):
            result.append(line)
            continue

        # 존댓말 끝 마침표는 유지
        no_period = stripped.rstrip('.')
        is_formal = any(no_period.endswith(f) for f in FORMAL_ENDINGS)
        if is_formal:
            result.append(line)
            continue

        # 1) 문장 끝 마침표 제거: "멋졌어." → "멋졌어"
        if stripped.endswith('.') and not stripped.endswith('..'):
            stripped = stripped[:-1]

        # 2) 문장 중간 마침표 → 쉼표: "좋아. 더 가까이" → "좋아, 더 가까이"
        #    패턴: 한글 + . + 공백 + 한글 (존댓말 아닌 경우만)
        def _fix_mid_period(m):
            before = m.group(1)
            after = m.group(2)
            # 중간 마침표 앞이 존댓말이면 유지
            if any(before.endswith(f) for f in FORMAL_ENDINGS):
                return m.group(0)
            return f'{before}, {after}'

        stripped = re.sub(r'([가-힣])\.\s+([가-힣])', _fix_mid_period, stripped)

        result.append(stripped)

    return '\n'.join(result)


QC_SYSTEM_PROMPT = """당신은 10년 경력의 넷플릭스/디즈니+ OTT 자막 검수자(QC Senior Editor)입니다.
1차 번역을 최소한으로 교정하여 "방영 가능 품질(Broadcast-Ready)"로 올리는 것이 목표입니다.

🔴 최우선 원칙: 과교정 금지 (Over-Correction Prohibition)
  • 이미 자연스러운 번역은 원본 그대로 출력하십시오.
  • 의미가 동일한데 표현만 바꾸는 것은 교정이 아니라 취향 차이입니다.
  • "바꿀 이유가 명확하지 않으면 바꾸지 마라"가 이 검수의 철칙입니다.

📌 [QC 규칙 1] 말투 마침표 정리
  • 반말/구어체 대사 끝 마침표(.) 제거. 존댓말(~습니다/~세요)은 유지.
  • 느낌표(!), 물음표(?), 말줄임표(...)는 절대 건드리지 마십시오.

📌 [QC 규칙 2] 번역투 전면 제거
  • 자가 검증: "이 표현이 한국에서 제작된 영화/드라마 자막에 그대로 등장할 수 있는가?" — 아니면 교정.
  • 영어 직역투 대명사, 합성어 직역, 관용구 직역, 소유격 남용, 불필요한 관사적 표현 모두 교정 대상.
  • 단, 자연스러운 한국어 지시어(그건/그게/그걸 등)는 그대로 두십시오.

📌 [QC 규칙 3] 줄바꿈 최적화
  • 한 줄 18자 초과 시 의미 단위로 줄바꿈(\\n). 1블록 최대 2줄.
  • 다중 화자 하이픈(-) 줄바꿈은 반드시 유지.

📌 [QC 규칙 4] 화자별 말투 일관성
  • [등장인물 말투]와 [이전 배치] 컨텍스트가 주어지면, 각 화자의 존대/반말을 유지.
  • 같은 화자가 같은 상대에게 말투를 갑자기 바꾸면 수정. 단, 감정 고조에 의한 의도적 전환은 허용.

📌 [QC 규칙 5] 한 블록 내 존대/반말 혼용 금지
  • 한 블록 안에서 존댓말+반말 혼용 시, 더 높은 격식으로 통일.

📌 [QC 규칙 6] "당신" 사용 금지
  • "당신"이 2인칭 대명사로 사용된 경우, 이름/직책/너/선생님/그쪽 등으로 교체하거나 생략.
  • 예외: 부부 갈등, 적대적 도발("당신이 뭔데"), 노래 가사 등 의도적 사용은 유지.

📌 [QC 규칙 7] 영어식 주어·번역투 잔존 검출
  • "그는/그녀는/그들은" 등 영어식 3인칭 대명사가 주어로 남아 있으면 교정 (생략 또는 이름 치환).
  • "~것입니다/~하게 될 것이다/~네요" 남발 → 캐릭터 관계에 맞는 구어체 어미로 교정.
  • "여정/초석/파트너십/관찰" 같은 문어체 명사 → 구어체 대체 (길/기반/함께하기/지켜보기).

📌 [QC 규칙 8] 거리감·문장유형 톤 일관성 검증
  • 감정 토로/농담이 해요체로 되어 있으면 → 반말로 교정 (관계 맵 우선).
  • 공식 발표/보고가 반말로 되어 있으면 → 합니다체로 교정.
  • 한 블록 내에서 존대/반말 톤이 뒤섞여 있으면 → 하나로 통일.

📌 [QC 규칙 9] [오역의심] 태그 처리
  • 입력에 "[오역의심]" 태그가 붙은 블록은 특별히 주의하여 재검토.
  • 원문(영어)과 번역(한국어)의 의미가 괴리되면 교정.
  • 교정 후에도 자연스러운 번역이 불가하면 "[오역의심]" 태그를 유지하여 출력.
  • 정상 교정된 경우 태그를 제거하고 교정문만 출력.

✅ [QC 규칙 10 - PASS 4 강화] SPEECH DRIFT QC
다음 조건이면 수정 필요:

1) 직전 블록들과 말투 불일치
   → 연속 대사의 말투突变 확인

2) lock 관계인데 어미 변경
   → locked=true인 관계에서 말투 변심 확인

3) 블록 내부 혼용
   →同一 블록 내 존대/반말 혼합 확인

4) 친밀 관계에서 존대 등장
   → 친한 사이에서 갑작스러운 존댓말 확인

5) 존대 관계에서 반말 등장
   → 상하 관계에서 갑작스러운 반말 확인

수정 시: 의미 유지 + 말투만 교정 (번역 내용 변경禁止)

[출력 형식] 오직 JSON 배열만 출력하세요:
[{"index": 1, "text": "교정된 자막"}, {"index": 2, "text": "교정된 자막"}]

⚠️ 입력된 블록 수만큼 정확히 출력하십시오. 누락/합치기/분할 금지!
⚠️ 교정할 것이 없으면 원본 텍스트를 그대로 출력하십시오."""


@router.post("/qc-postprocess")
async def qc_postprocess(request: QCPostProcessRequest):
    """
    🔍 QC 후처리 — 번역 완료 후 마침표/번역투/줄바꿈 교정

    번역된 자막을 LLM에 보내 3가지 QC 규칙으로 교정 후 반환.
    """
    print(f"[QC] Post-processing {len(request.blocks)} blocks for '{request.title}'")

    # 번역된 자막을 입력 페이로드로 구성
    source_lines = []
    for b in request.blocks:
        if b.ko and b.ko.strip():
            source_lines.append(f"{b.index}: {b.ko}")
        else:
            source_lines.append(f"{b.index}: {b.en}")

    source_payload = "\n".join(source_lines)

    # --- user_prompt: 컨텍스트 포함 구성 ---
    user_parts = [f"[작품: {request.title} / 장르: {request.genre}]"]

    if request.synopsis:
        user_parts.append(f"\n[시놉시스]\n{request.synopsis[:2000]}")

    if request.personas:
        user_parts.append(f"\n[등장인물 말투]\n{request.personas}")

    # 이전 배치 컨텍스트 — 말투 연속성 유지용
    if request.prev_context:
        last_blocks = request.prev_context[-15:]
        ctx_lines = []
        for pc in last_blocks:
            ko_text = pc.get("ko", "") or ""
            # 존대/반말 태그 자동 부착
            tag = "[존대]" if any(ko_text.rstrip('.!?').endswith(e) for e in (
                '습니다', '합니다', '입니다', '됩니다', '겠습니다',
                '하십시오', '주십시오', '세요', '하세요', '주세요',
                '까요', '나요', '가요', '지요',
            )) else "[반말]"
            ctx_lines.append(f"  {tag} {ko_text}")
        user_parts.append(f"\n[이전 배치 — 말투 반드시 이어갈 것]\n" + "\n".join(ctx_lines))

    user_parts.append(f"\n다음 번역된 자막을 QC 규칙에 따라 교정하세요:\n\n{source_payload}")
    user_prompt = "\n".join(user_parts)

    # --- system_instruction: translation_rules 추가 ---
    system_instruction = QC_SYSTEM_PROMPT
    if request.translation_rules:
        system_instruction += f"\n\n📌 [추가 번역 규칙 — 반드시 준수]\n{request.translation_rules}"

    try:
        translator = get_vertex_ai()

        def make_qc_call(attempt=0, max_retries=3):
            return translator.client.models.generate_content(
                model=translator.model,
                contents=user_prompt,
                config={
                    "system_instruction": system_instruction,
                    "max_output_tokens": 32768,
                    "temperature": 0.1,
                    "thinking_config": {"thinking_budget": 1024},
                }
            )

        response, error = translator._retry_with_backoff(make_qc_call)

        if error:
            print(f"[QC-ERROR] API call failed: {error}")
            return {
                "status": "error",
                "error": error,
                "data": []
            }

        raw_content = response.text
        parsed = _parse_translation_response(raw_content, [b.dict() for b in request.blocks])

        # 규칙 기반 번역투 제거 — LLM이 놓친 "그녀가/그녀의" 등 100% 보정
        translationese_fixed = 0
        for item in parsed:
            if item.get("text"):
                cleaned = _remove_translationese(item["text"])
                if cleaned != item["text"]:
                    item["text"] = cleaned
                    translationese_fixed += 1

        # 규칙 기반 마침표 제거 — LLM이 놓친 것 100% 보정 (새로운 remove_periods 함수 사용)
        period_fixed = 0
        for item in parsed:
            if item.get("text"):
                cleaned = remove_periods(item["text"])
                if cleaned != item["text"]:
                    item["text"] = cleaned
                    period_fixed += 1

        # 말투 급변 교정 — 연속 블록에서 존대↔반말 급변 감지 및 통일
        speech_flip_fixed = 0
        if parsed and request.prev_context:
            # parsed를 block 형태로 변환
            blocks_for_fix = [{"index": item.get("index"), "ko": item.get("text")} for item in parsed]
            fixed_blocks = fix_speech_flip(blocks_for_fix, request.prev_context)
            # 결과를 다시 parsed에 반영
            for i, fb in enumerate(fixed_blocks):
                if fb.get("ko") != parsed[i].get("text"):
                    parsed[i]["text"] = fb.get("ko")
                    speech_flip_fixed += 1

        print(f"[QC] Processed {len(parsed)} blocks (translationese-fix: {translationese_fixed}, period-fix: {period_fixed}, speech-flip-fix: {speech_flip_fixed})")

        return {
            "status": "complete",
            "expected_count": len(request.blocks),
            "received_count": len(parsed),
            "period_fixed": period_fixed,
            "translationese_fixed": translationese_fixed,
            "speech_flip_fixed": speech_flip_fixed,
            "data": [{
                "batch_index": 0,
                "content": parsed
            }]
        }

    except Exception as e:
        print(f"[QC-ERROR] Post-processing failed: {type(e).__name__}: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"QC post-processing failed: {str(e)}")


# ═══════════════════════════════════════════════════════════════════════════════
# 말투 교정 함수 (QC 후처리에서 사용)
# ═══════════════════════════════════════════════════════════════════════════════

def remove_periods(text: str) -> str:
    """
    자막 끝 마침표 제거 (반말만) - 존댓말/물음표/느낌표는 유지

    반말 끝 어미: 해/야/지/다/어/네/걸/잖아/인거야/한거야/된거야/할거야/간다/온다/한다/된다
    존댓말 끝 어미: 합니다/습니다/예요/에요/죠/지요/나요/까요/셔요/ullo/입니다/됩니다
    """
    if not text:
        return text

    # 물음표/느낌표로 끝나는 경우 유지
    if text.rstrip().endswith('?') or text.rstrip().endswith('!'):
        return text

    # 말줄임표 보존
    if text.rstrip().endswith('...') or text.rstrip().endswith('..'):
        return text

    # 반말 종결어미 목록
    banmal_endings = [
        '해', '야', '지', '다', '어', '네', '걸', '잖아',
        '인거야', '한거야', '된거야', '할거야',
        '간다', '온다', '한다', '된다',
        '야말야', '는거야', '잖는지', '는지', '은지',
        '구나', '군', '야', '야말야', '잖아',
    ]

    # 존댓말 종결어미 목록 (마침표 유지)
    formal_endings = [
        '합니다', '습니다', '예요', '에요', '죠', '지요', '나요', '까요',
        '셔요', 'ullo', '입니다', '됩니다', '있습니다', '없습니다',
        '겠습니다', '였습니다', '셨습니다', '하시습니다', '주ISCO',
        '하세요', '주세요', '드세요', '으세요', '십니다',
        '지요', '인가요', '인가', '죠', '구요',
    ]

    # 줄 단위로 처리
    lines = text.split('\n')
    result = []

    for line in lines:
        stripped = line.rstrip()
        if not stripped:
            result.append(line)
            continue

        # 마침표가 없는 경우 통과
        if not stripped.endswith('.'):
            result.append(line)
            continue

        # 물음표/느낌표로 끝나면 통과
        if stripped.endswith('?') or stripped.endswith('!'):
            result.append(line)
            continue

        # 마침표 제거한 텍스트
        no_period = stripped[:-1]  # 마지막 . 제거

        # 존댓말 끝인지 확인
        is_formal = any(no_period.endswith(f) for f in formal_endings)
        if is_formal:
            result.append(line)
            continue

        # 반말 끝인지 확인
        is_banmal = any(no_period.endswith(e) for e in banmal_endings)
        if is_banmal:
            result.append(no_period)  # 마침표 제거
            continue

        # 알 수 없는 끝이면 일단 유지 (안전하게)
        result.append(line)

    return '\n'.join(result)


def detect_speech_level(text: str) -> str:
    """
    텍스트의 말투 레벨 감지 (존대/반말/중립)
    """
    if not text:
        return "unknown"

    # 반말 종결어미
    banmal_endings = [
        '해', '야', '지', '다', '어', '네', '걸', '잖아',
        '인거야', '한거야', '된거야', '할거야',
        '간다', '온다', '한다', '된다',
        '구나', '군', '야', '잖아',
    ]

    # 존댓말 종결어미
    formal_endings = [
        '합니다', '습니다', '예요', '에요', '죠', '지요', '나요', '까요',
        '셔요', 'ullo', '입니다', '됩니다', '있습니다', '없습니다',
        '겠습니다', '였습니다', '셨습니다', '하시습니다', '주ISCO',
        '하세요', '주세요', '드세요', '으세요', '십니다',
    ]

    text = text.rstrip('.!?')

    # 존댓말 감지
    for ending in formal_endings:
        if text.endswith(ending):
            return "honorific"

    # 반말 감지
    for ending in banmal_endings:
        if text.endswith(ending):
            return "banmal"

    return "unknown"


def fix_speech_flip(blocks: list, prev_context: list) -> list:
    """
    연속 블록에서 말투 급변 감지 및 교정

    - 이전 블록 말투로統一
    - 화자가 바뀐 경우는 예외 (다른 인물은 다른 말투 가능)
    - 화자 변경은 "—" 또는 "-" 또는 ":" 로 감지
    """
    if not blocks or len(blocks) < 2:
        return blocks

    # prev_context에서 마지막 말투 레벨 가져오기
    last_speech_level = "unknown"
    last_speaker = None

    if prev_context and len(prev_context) > 0:
        last_ctx = prev_context[-1]
        last_text = last_ctx.get("ko", "") or last_ctx.get("translated", "")
        last_speech_level = detect_speech_level(last_text)
        last_speaker = last_ctx.get("speaker") or last_ctx.get("original", "").split(":")[0] if ":" in (last_ctx.get("original", "") or "") else None

    # 현재 배치 첫 번째 블록의 말투
    first_text = blocks[0].get("ko", "") if isinstance(blocks[0], dict) else blocks[0].get("text", "")
    first_speech_level = detect_speech_level(first_text)

    # 말투 급변 감지 및 교정
    fixed_count = 0
    result = []

    # 첫 번째 블록 처리 (이전 컨텍스트와 비교)
    if last_speech_level != "unknown" and first_speech_level != "unknown" and last_speech_level != first_speech_level:
        # 말투 급변 감지 -> 이전 말투로统一
        corrected = convert_speech_level(first_text, last_speech_level)
        if corrected != first_text:
            if isinstance(blocks[0], dict):
                blocks[0] = {**blocks[0], "ko": corrected}
            else:
                blocks[0]["text"] = corrected
            fixed_count += 1

    # 연속 블록 간 말투 일관성 유지
    prev_text = blocks[0].get("ko", "") if isinstance(blocks[0], dict) else blocks[0].get("text", "")
    prev_level = detect_speech_level(prev_text)
    prev_speaker = None

    for i, block in enumerate(blocks):
        text = block.get("ko", "") if isinstance(block, dict) else block.get("text", "")

        # 화자 변경 감지 (자막에서 화자 구분 패턴)
        # 패턴: "화자: 대사" 또는 "화자 — 대사" 또는 "- 화자"等形式
        speaker = None
        speaker_patterns = [
            r'^([^:]+):\s*',  # "화자: 대사"
            r'^([^—]+)—\s*',  # "화자 — 대사"
            r'^-\s*([^:]+):\s*',  # "- 화자: 대사"
        ]

        for pattern in speaker_patterns:
            match = re.match(pattern, text)
            if match:
                speaker = match.group(1).strip()
                break

        # 화자가 변경되면 말투도 변경 가능 (다른 인물이므로)
        if speaker and prev_speaker and speaker != prev_speaker:
            prev_level = detect_speech_level(text)  # 새로운 화자의 말투로 업데이트
            prev_speaker = speaker
            result.append(block)
            continue

        # 화자가 동일하면 말투 일관성 유지
        current_level = detect_speech_level(text)
        if current_level != "unknown" and prev_level != "unknown" and current_level != prev_level:
            # 말투 급변 -> 이전 말투로统一
            corrected = convert_speech_level(text, prev_level)
            if corrected != text:
                if isinstance(block, dict):
                    block = {**block, "ko": corrected}
                else:
                    block["text"] = corrected
                fixed_count += 1

        prev_text = text
        prev_level = detect_speech_level(text)
        prev_speaker = speaker
        result.append(block)

    if fixed_count > 0:
        print(f"[QC] Speech flip fixed: {fixed_count} blocks")

    return result


def convert_speech_level(text: str, target_level: str) -> str:
    """
    텍스트의 말투를 목표 레벨로 변환
    """
    if not text or target_level == "unknown":
        return text

    text = text.rstrip()

    # 반말 -> 존댓말 변환 (기본 해요체)
    if target_level == "honorific":
        # 이미 존댓말이면 통과
        if detect_speech_level(text) == "honorific":
            return text

        # 반말 -> 해요체/입니다체 변환
        conversions = [
            # 반말 어미 -> 존댓말 어미
            ('해요', '합니다'),
            ('해', '합니다'),
            ('했어', '했습니다'),
            ('했어요', '했습니다'),
            ('야', '예요'),
            ('야.', '예요.'),
            ('어', '습니다'),
            ('다', '습니다'),
            ('지', '는지'),
            ('네', '네요'),
            ('걸', '거예요'),
            ('잖아', '잖아요'),
            ('잖아.', '잖아요.'),
            ('구나', '군요'),
            ('군', '군요'),
            ('는거야', '는거예요'),
            ('한거야', '한거예요'),
            ('된거야', '된거예요'),
            ('할거야', '할거예요'),
            ('인거야', '인거예요'),
            ('이다', '입니다'),
            ('야말야', '입니다'),
        ]

        for banmal, formal in conversions:
            if text.endswith(banmal):
                text = text[:-len(banmal)] + formal
                break

        # 마침표 추가 (없는 경우)
        if not text.endswith('.'):
            text += '.'

    # 존댓말 -> 반말 변환
    elif target_level == "banmal":
        # 이미 반말이면 통과
        if detect_speech_level(text) == "banmal":
            return text

        # 존댓말 -> 반말 변환
        conversions = [
            # 존댓말 어미 -> 반말 어미
            ('합니다', '해'),
            ('했습니다', '했어'),
            ('입니다', '야'),
            ('예요', '야'),
            ('에요', '야'),
            ('네요', '네'),
            ('습니다', '어'),
            ('것입니다', '거야'),
            ('거예요', '거야'),
            ('거예요.', '야.'),
            ('습니다.', '어.'),
            ('합니다.', '해.'),
            ('입니다.', '야.'),
            ('죠', '지'),
            ('지요', '지'),
            ('나요', '나'),
            ('까요', '까'),
            ('셔요', '해'),
            ('주ISCO', '줘'),
            ('됩니다', '돼'),
            ('있습니다', '있어'),
            ('없습니다', '없어'),
            ('하겠습니다', '할게'),
            ('해주세요', '해줘'),
            ('하세요', '해'),
            ('해주세요.', '해줘.'),
            ('하세요.', '해.'),
        ]

        for formal, banmal in conversions:
            if text.endswith(formal):
                text = text[:-len(formal)] + banmal
                break
            # 마침표 있는 경우
            if text.endswith(formal + '.'):
                text = text[:-len(formal) - 1] + banmal
                break

    return text
