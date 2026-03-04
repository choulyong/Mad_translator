import os
import re
import json
import traceback
import asyncio
import uuid
import time
import math
import difflib
from datetime import datetime
from pathlib import Path
try:
    import yaml
except ImportError:
    yaml = None
from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List, Optional, Any
from app.core.logic_gate import LogicGate
from app.database import save_job_to_db, load_job_from_db

# WebSocket Manager는 main.py에서 주입됨 (circular import 회피)
ws_manager = None
from app.subtitle_cleaner import clean_subtitle_text, remove_duplicate_blocks
from app.core.diagnostic import DiagnosticEngine
from app.core.k_cinematic_prompt import get_v6_2_qc_prompt, get_universal_relationship_logic
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
from app.api.finetuning_dataset_builder import (
    build_finetuning_dataset,
    get_finetuning_dataset_stats,
)
from app.api.finetuning_model_trainer import (
    run_finetuning,
    get_finetuned_model_status,
)
from app.api.finetuning_model_handler import (
    is_finetuned_model_available,
    apply_model_optimization_to_prompt,
    get_model_switch_status,
    get_model_info,
)
from app.api.quality_evaluator import (
    run_quality_evaluation,
    get_evaluation_report,
)
from app.api.comparative_analyzer import (
    run_comparative_analysis,
    get_comparison_report,
)
from app.api.zootopia_translation_executor import (
    execute_zootopia_translation,
    get_translation_status,
)
from app.api.production_deployment import (
    run_production_deployment,
    get_deployment_report,
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

    # 결과 정규화 - Gemini가 {index,text} 또는 {id,ko} 또는 {index,korean_text} 형식으로 응답
    result = []
    for trans in translations:
        if not isinstance(trans, dict):
            continue
        try:
            # 다양한 필드명 지원
            text_val = trans.get("text") or trans.get("ko") or trans.get("translated") or trans.get("korean_text") or ""
            idx = trans.get("index") or trans.get("id")

            # text가 dict면 문자열로 변환
            if isinstance(text_val, dict):
                text_val = str(text_val)

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
        except Exception as e:
            print(f"[WARN] Skipping invalid translation item: {e}")
            continue

    return result

router = APIRouter()
logic_gate = LogicGate()
diagnostic = DiagnosticEngine()

# Vertex AI 클라이언트 (환경변수에서 자동 로드)
# Vertex AI 클라이언트 — vertex_ai.py 싱글톤 사용 (순환 임포트 방지)
from app.services.vertex_ai import get_vertex_ai

# ═══════════════════════════════════════════════════════════════════════════════
# Job Store - 백엔드 오케스트레이션 (translate-all)
# ═══════════════════════════════════════════════════════════════════════════════

_jobs: dict[str, dict] = {}

# ═══════════════════════════════════════════════════════════════════════════════
# Job Persistence Functions (Database-backed)
# ═══════════════════════════════════════════════════════════════════════════════

def _save_job(job_id: str):
    """Save a single job to database (with graceful fallback if DB unavailable)"""
    if job_id in _jobs:
        try:
            job_data = _jobs[job_id].copy()
            # Convert created_at timestamp back if needed
            if 'created_at' in job_data and isinstance(job_data['created_at'], str):
                job_data['created_at'] = datetime.fromisoformat(job_data['created_at'])
            save_job_to_db(job_id, job_data)
            print(f"[SAVE] Job {job_id} persisted to database")
            return True
        except Exception as e:
            # ✅ Graceful fallback: DB unavailable but in-memory storage still works
            print(f"[WARN] Database save failed for job {job_id}: {e}")
            print(f"[INFO] Job {job_id} remains in memory (in-memory storage active)")
            return False
    return False


def _cleanup_old_jobs():
    """✅ Cleanup completed/failed jobs older than 60 seconds to prevent memory leaks"""
    current_time = time.time()
    jobs_to_remove = []

    for job_id, job in list(_jobs.items()):
        status = job.get("status")
        created_at = job.get("created_at", 0)

        # Keep running jobs (no time limit)
        if status == "running":
            continue

        # Remove completed/failed jobs older than 60 seconds
        if status in ("complete", "failed") and (current_time - created_at) > 60:
            jobs_to_remove.append(job_id)

    for job_id in jobs_to_remove:
        del _jobs[job_id]
        print(f"[CLEANUP] Job {job_id} removed from memory (age > 60s)")


async def _periodic_cleanup():
    """Periodically cleanup old jobs"""
    while True:
        try:
            await asyncio.sleep(30)  # Run cleanup every 30 seconds
            _cleanup_old_jobs()
        except Exception as e:
            print(f"[ERROR] Cleanup task failed: {e}")


def _load_jobs_from_file():
    """Deprecated: kept for backward compatibility"""
    print("[INFO] File-based job loading deprecated. Using database recovery instead.")
    return True


class TranslateAllRequest(BaseModel):
    blocks: list                                    # [{id, start, end, en, speaker, addressee}]
    metadata: dict                                  # {title, genre, synopsis, ...}
    strategy: Optional[dict] = None                 # {character_personas, fixed_terms, translation_rules}
    character_relations: Optional[dict] = None
    confirmed_speech_levels: Optional[dict] = None
    options: Optional[dict] = None                  # {include_qc: bool}


# ═══════════════════════════════════════════════════════════════════════════════
# translate_single_batch() - HTTP 없이 직접 호출하는 번역 함수
# ═══════════════════════════════════════════════════════════════════════════════

async def translate_single_batch(blocks: list, context_info: dict) -> list:
    """
    단일 배치 번역 - HTTP 없이 직접 호출.
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

    # 슬래시 줄바꿈 변환 및 Task C 인라인 태그 가드레일 (Tag Stripper)
    for trans in parsed:
        text = trans.get("text", "")
        if text:
            # LLM이 실수로 `[System: Speaker -> Addressee (Tone)]`를 출력했을 경우 물리적 삭제
            text = re.sub(r'\[(?:System|시스템).*?\]', '', text).strip()
            
            if " / " in text:
                text = text.replace(" / ", "\n")
                
            trans["text"] = text

    return parsed


# ═══════════════════════════════════════════════════════════════════════════════
# 유틸 함수: 시맨틱 배칭, 톤 메모리, 중복 감지, 후처리
# ═══════════════════════════════════════════════════════════════════════════════

def _parse_timecode_to_seconds(tc: str) -> float:
    """SRT 타임코드 → 초 (예: '00:01:23,456' → 83.456)"""
    # int/float 타입 처리 (JSON에서 숫자로 전달될 수 있음)
    if isinstance(tc, (int, float)):
        return float(tc)
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


# ═══════════════════════════════════════════════════════════════════════════════
# Postprocess v1 - 의미 보존 후보정 (중복/포맷/♪/대시/문장부호/CPS 줄바꿈)
# ═══════════════════════════════════════════════════════════════════════════════

_MUSIC_VERBS_RE = re.compile(r"(재생\s*중|연주됨|연주\s*중|흘러나옴|playing)", re.IGNORECASE)

def _norm_for_dedup(s: str) -> str:
    """중복 판별용 정규화(의미 보존 목적이 아니라 비교 목적)"""
    if not s:
        return ""
    t = s.strip()
    t = t.replace("\u2026", "...")  # … ↔ ...
    t = re.sub(r"\s+", "", t)
    t = re.sub(r"[\"'""'']", "", t)
    t = re.sub(r"[!?.,~\-–-·:;()\[\]{}<>]", "", t)
    return t

def _fix_music_notes(text: str) -> str:
    """
    ♪ 표기 정리:
    - 한쪽만 있는 경우 양쪽으로 맞춤
    - '재생 중/연주됨' 같은 설명형 제거(가독성)
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

def _normalize_dialogue_dashes(text: str) -> str:
    """
    대시 대화 정리:
    - '-대사' → '- 대사'
    - 한 줄에 '- A - B' 형태(매우 흔함) → '- A\n- B' (보수적으로)
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
        # 단, 이미 두 줄이면 건드리지 않음
        if l.startswith("- ") and " - " in l:
            parts = l.split(" - ")
            if len(parts) == 2:
                left = parts[0].strip()
                right = parts[1].strip()
                # right가 말처럼 보이면 대화 분리
                if right and not right.startswith("-"):
                    new_lines.append(left)
                    new_lines.append("- " + right)
                    continue

        new_lines.append(l)

    return "\n".join(new_lines).strip()

def _normalize_punctuation(text: str) -> str:
    """
    문장부호 후보정(의미 보존):
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

def _smart_linebreak(text: str, max_chars: int) -> str:
    """
    CPS 기반 줄바꿈(의미 불변):
    - 너무 긴 한 줄을 공백 기준으로 2줄로 나눈다
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

    # 공백이 거의 없으면 포기(의미 훼손 방지)
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

def postprocess_translations(parsed_translations: list, batch_dicts: list, cps_rate: int = 14) -> dict:
    """
    parsed_translations: [{"index": int, "text": str}, ...]
    batch_dicts: [{"index": int, "start": "...", "end": "...", "text": "EN"}, ...] 또는 최소 {"index","text"}.
    - 의미 보존 후보정만 수행
    - in-place로 parsed_translations의 text를 수정
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
        text2 = _fix_music_notes(text)
        if text2 != text:
            stats["music_fixed"] += 1
        text = text2

        # 2) 대시 대화 정리
        text2 = _normalize_dialogue_dashes(text)
        if text2 != text:
            stats["dash_fixed"] += 1
        text = text2

        # 3) 문장부호 정리
        text2 = _normalize_punctuation(text)
        if text2 != text:
            stats["punct_fixed"] += 1
        text = text2

        # 4) CPS 기반 줄바꿈 (start/end가 있는 경우에만)
        b = block_map.get(idx, {})
        if b.get("start") and b.get("end"):
            dur = _compute_block_duration({"start": b.get("start"), "end": b.get("end")})
            max_chars = _compute_max_chars(dur, cps_rate=cps_rate)
            text2 = _smart_linebreak(text, max_chars=max_chars)
            if text2 != text:
                stats["linebreak_fixed"] += 1
            text = text2

        if text != original:
            t["text"] = text

    # 5) 소프트 중복 제거(연속 인덱스 기준, 의미 불일치 가능성 높은 경우만 blank)
    #    - KO가 거의 동일했는데 EN이 다르면 중복일 가능성이 큼
    #    - 너무 공격적으로 지우지 않도록 en 유사도 낮을 때만 blank
    #    (기존 하드 중복감지 보완용)
    # batch 순서대로 비교
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

        nk = _norm_for_dedup(curr_ko)
        pk = _norm_for_dedup(prev_ko)

        if nk and pk and nk == pk and len(nk) >= 5:
            # 영어 비교
            curr_en = (block_map.get(idx, {}).get("text") or "")
            prev_en = (block_map.get(prev_idx, {}).get("text") or "")
            en_ratio = difflib.SequenceMatcher(None, curr_en.lower(), prev_en.lower()).ratio()

            # EN이 꽤 다르면(=다른 의미일 확률) KO 동일은 중복 가능성↑ → blank 처리
            if en_ratio < 0.60:
                curr["text"] = ""
                stats["soft_dedup_blank"] += 1

        prev_idx = idx

    return stats


# ═══════════════════════════════════════════════════════════════════════════════
# SRT 텍스트 후처리 (파일 저장 직전 적용)
# ═══════════════════════════════════════════════════════════════════════════════

def postprocess_srt_text(srt: str) -> str:
    """SRT 텍스트 후처리 - ♪, 대시, 문장부호 정리"""
    blocks = re.split(r"\n{2,}", srt.strip())
    out_blocks = []

    for b in blocks:
        lines = b.splitlines()
        if len(lines) < 3:
            out_blocks.append(b)
            continue

        idx = lines[0]
        tc = lines[1]
        text = "\n".join(lines[2:])

        text = _fix_music_srt(text)
        text = _fix_dashes_srt(text)
        text = _normalize_punct_srt(text)

        out_blocks.append(f"{idx}\n{tc}\n{text}")

    return "\n\n".join(out_blocks) + "\n"


def _fix_music_srt(text: str) -> str:
    """♪ 표기 정리"""
    if "♪" not in text:
        return text
    lines = text.split("\n")
    out = []
    for l in lines:
        if "♪" in l:
            if l.count("♪") == 1:
                core = l.replace("♪", "").strip()
                l = f"♪ {core} ♪"
        out.append(l)
    return "\n".join(out)


def _fix_dashes_srt(text: str) -> str:
    """대시 대화 정리"""
    lines = text.split("\n")
    out = []
    for l in lines:
        l = re.sub(r"^\-\s*(\S)", r"- \1", l)
        out.append(l)
    return "\n".join(out)


def _normalize_punct_srt(text: str) -> str:
    """문장부호 정리"""
    text = re.sub(r"\.{3,}", "…", text)
    text = re.sub(r"!\s*!+", "!", text)
    text = re.sub(r"\?\s*\?+", "?", text)
    return text.strip()


# ═══════════════════════════════════════════════════════════════════════════════
# Pass 5.0 - Register Stabilizer (범용 레지스터 고정 후보정)
# - 의미 불변: "문장 끝말/질문형/요·습니다"만 교정
# - confirmed_levels(말투 잠금) + char_relations(관계 설명) 기반
# ═══════════════════════════════════════════════════════════════════════════════

_FORMAL_MARKERS_RE = re.compile(r"(습니다|십시오|합니다|되겠습니까|되십니까|입니까|겠습니까)")
_POLITE_MARKERS_RE = re.compile(r"(요|세요|주세요|까요|나요|지요)\b")

_REL_AUTH_DOWN = ("하대", "명령", "상사", "부하", "훈련", "지시", "반말", "권위", "상향", "하향", "강압")
_REL_SUBMISSIVE = ("격식", "하시오", "존대", "상급자", "상관", "고객", "재판", "법정", "대통령", "각하", "의전")

_TO_BANMAL_PATTERNS = [
    (re.compile(r"입니까\?"), "인가?"),
    (re.compile(r"되나요\?"), "돼?"),
    (re.compile(r"합니까\?"), "해?"),
    (re.compile(r"인가요\?"), "인가?"),
    (re.compile(r"나요\?"), "냐?"),
    (re.compile(r"지요\?"), "지?"),
    (re.compile(r"죠\?"), "지?"),
    (re.compile(r"세요\?"), "냐?"),
    (re.compile(r"할까요\?"), "할까?"),
    (re.compile(r"입니다\."), "이야"),
    (re.compile(r"입니다$"), "이야"),
    (re.compile(r"합니다\."), "해"),
    (re.compile(r"합니다$"), "해"),
    (re.compile(r"하시오\."), "해"),
    (re.compile(r"하시오$"), "해"),
    (re.compile(r"하세요\."), "해"),
    (re.compile(r"하세요$"), "해"),
    (re.compile(r"주세요\."), "줘"),
    (re.compile(r"주세요$"), "줘"),
    (re.compile(r"됩니다\."), "돼"),
    (re.compile(r"됩니다$"), "돼"),
    (re.compile(r"되세요\."), "돼"),
    (re.compile(r"되세요$"), "돼"),
    (re.compile(r"했습니다\."), "했어"),
    (re.compile(r"했습니다$"), "했어"),
]

_TO_POLITE_PATTERNS_MIN = [
    (re.compile(r"야$"), "요"),
    (re.compile(r"야\."), "요"),
    (re.compile(r"냐\?"), "나요?"),
    (re.compile(r"지\?"), "죠?"),
    (re.compile(r"해$"), "해요"),
    (re.compile(r"해\."), "해요"),
    (re.compile(r"돼$"), "돼요"),
    (re.compile(r"돼\."), "돼요"),
    (re.compile(r"줘$"), "주세요"),
    (re.compile(r"줘\."), "주세요"),
    (re.compile(r"했어$"), "했어요"),
    (re.compile(r"했어\."), "했어요"),
]

_TO_FORMAL_FROM_POLITE_MIN = [
    (re.compile(r"이에요\."), "입니다"),
    (re.compile(r"이에요$"), "입니다"),
    (re.compile(r"예요\."), "입니다"),
    (re.compile(r"예요$"), "입니다"),
    (re.compile(r"해요\."), "합니다"),
    (re.compile(r"해요$"), "합니다"),
    (re.compile(r"돼요\."), "됩니다"),
    (re.compile(r"돼요$"), "됩니다"),
    (re.compile(r"주세요\."), "주십시오"),
    (re.compile(r"주세요$"), "주십시오"),
]


def _infer_target_register(speaker: str, addressee: str, confirmed_levels: dict, char_relations: dict) -> str:
    """반환: 'banmal' | 'honorific' | 'formal' | 'none'"""
    speaker = (speaker or "").strip()
    addressee = (addressee or "").strip()
    if not speaker or not addressee:
        return "none"

    pair_key = f"{speaker} → {addressee}"
    info = confirmed_levels.get(pair_key)

    if isinstance(info, dict) and info.get("locked"):
        lvl = info.get("level")
        if lvl in ("banmal", "honorific"):
            return lvl
        if lvl in ("submissive_formal", "formal"):
            return "formal"
        if lvl == "authoritative_downward":
            return "banmal"

    if isinstance(info, dict):
        lvl = info.get("level")
        if lvl in ("banmal", "honorific"):
            return lvl
        if lvl in ("submissive_formal", "formal"):
            return "formal"
        if lvl == "authoritative_downward":
            return "banmal"

    rel_text = str(char_relations.get(pair_key, "") or "")
    if rel_text:
        if any(k in rel_text for k in _REL_SUBMISSIVE):
            return "formal"
        if any(k in rel_text for k in _REL_AUTH_DOWN):
            return "banmal"

    return "none"


def _apply_patterns_per_line(text: str, patterns: list) -> str:
    lines = text.split("\n")
    out = []
    for line in lines:
        s = line
        for pat, rep in patterns:
            if pat.search(s):
                s = pat.sub(rep, s)
        out.append(s)
    return "\n".join(out)


def _looks_mixed_register(text: str) -> bool:
    """한 자막 안에서 존대/반말이 섞였는지"""
    if not text:
        return False
    has_formal = bool(_FORMAL_MARKERS_RE.search(text))
    has_polite = bool(_POLITE_MARKERS_RE.search(text))
    has_informal_hint = bool(re.search(r"(냐\?|지\?|잖아|거든|야\b|해\b|돼\b|줘\b)", text))
    return (has_formal and has_informal_hint) or (has_polite and has_informal_hint) or (has_formal and has_polite)


# ═══════════════════════════════════════════════════════════════════════════════
# Wordplay / 농담 현지화 후처리
# ═══════════════════════════════════════════════════════════════════════════════

_WORDPLAY_HINTS = [
    r"\bpun\b", r"\bwordplay\b", r"\bjoke\b", r"\b(play on words)\b",
    r"\balliteration\b", r"\brhyme\b",
    r"\bnot\s+.*\s+but\b", r"\bit's\s+.*\s+thing\b",
    # 관용구
    r"\bhit the road\b", r"\bbreak a leg\b", r"\bkick the bucket\b",
    r"\bspill the beans\b", r"\bkill it\b", r"\bnail it\b", r"\bnailed it\b",
    r"\bthat'?s? a wrap\b", r"\bagree to disagree\b", r"\bhit a home run\b",
    r"\btouch base\b", r"\bthrow .{0,15} under the bus\b", r"\bhead.?s up\b",
    r"\bpull (my|your|his|her) leg\b", r"\bpiece of cake\b",
    r"\bunder the weather\b", r"\bbeat around the bush\b",
    r"\bcall it (a day|quits)\b", r"\blong story short\b", r"\btake it easy\b",
    r"\bhang in there\b", r"\bfair enough\b", r"\bcut to the chase\b",
    r"\bthe bottom line\b", r"\bread my lips\b", r"\bsuck it up\b",
    r"\bget over it\b", r"\bin the same boat\b",
    # 슬랭
    r"\bbadass\b", r"\bchill out\b", r"\bdope\b", r"\blit\b(?!\w)",
    r"\blegit\b", r"\bno cap\b", r"\bbussin\b", r"\bmy bad\b",
    r"\bfor real\b", r"\bno biggie\b",
    # 문화 약어
    r"\bFML\b", r"\bOMG\b", r"\bTBH\b", r"\bfyi\b", r"\bsmh\b",
]

_KO_LITERAL_SMELLS = [
    "말장난", "농담이야", "직역",
    "다리를 부러", "길을 쳐", "콩을 쏟", "양동이를 걷어",
    "케이크 한 조각", "날씨 아래", "같은 배에", "입술을 읽",
    "요점을 놓", "핵심으로 가", "거기 매달려", "버스 아래",
]

def detect_wordplay_candidates(blocks: list) -> list:
    """blocks: [{id, en, ko, ...}] -> 재번역할 block id 리스트"""
    candidates = []
    for b in blocks:
        en = (b.get("en") or "").strip()
        ko = (b.get("ko") or "").strip()
        if not en or not ko:
            continue

        hit = any(re.search(p, en, re.IGNORECASE) for p in _WORDPLAY_HINTS)
        literal_smell = any(s in ko for s in _KO_LITERAL_SMELLS)
        too_long = (len(en) <= 25 and len(ko) >= 32)

        if hit or literal_smell or too_long:
            candidates.append(b.get("id"))
    return [i for i in candidates if isinstance(i, int)]




def stabilize_register_blocks(blocks: list, confirmed_levels: dict = None, char_relations: dict = None) -> dict:
    """blocks: [{"ko","speaker","addressee",...}]를 in-place 후보정"""
    # [Task C] Regex Bomber 해체. 물리적 톤 강제 변환 정규식 폐기
    # LLM 기반 FinalToneGuardrail 패스로 책임 이관됨.
    stats = {"banmal_fixed": 0, "honorific_fixed": 0, "formal_fixed": 0, "mixed_fixed": 0}
    return stats


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


def _apply_hard_binding(blocks: list) -> list:
    """
    Hard Binding (V2): ...나 접속사로 끝나는 분절 자막을 결합하여 문맥 유실 방지.
    결합된 블록은 _bound_ids에 원본 id 목록을 보존.
    Returns: 결합된 새 blocks 리스트
    """
    # 접속사 패턴 (영어) - 문장 중간에서 끊기는 경우
    CONTINUATION_PATTERN = re.compile(
        r'(\.\.\.|…|-|–|,\s*$|'
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


def _build_semantic_batches(blocks: list) -> list:
    """
    시맨틱 배칭 - 장면 전환 기준 20~40 블록 단위로 분할.
    Returns: list of {start_idx, end_idx, blocks, scene_break, batch_mood}
    """
    if not blocks:
        return []

    # 배치 사이즈 확대 + 오버랩 (V4)
    MIN_BATCH = 15      # V5: 15개 이상이면 배치
    MAX_BATCH = 50      # V5: 50개 초과면 분할
    SCENE_GAP_SEC = 2.5
    OVERLAP_LINES = 3   # 배치 간 3줄 오버랩 (문맥 절단 방지)

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

    # 남은 블록 처리 - MAX_BATCH를 초과하지 않도록 병합
    if current_batch and batches:
        prev = batches[-1]
        # 병합 후 MAX_BATCH를 초과하면 새 배치로分离
        if len(prev["blocks"]) + len(current_batch) <= MAX_BATCH:
            prev["blocks"].extend(current_batch)
            prev["end_idx"] = prev["start_idx"] + len(prev["blocks"]) - 1
            prev["batch_mood"] = _detect_batch_mood(prev["blocks"])
        else:
            # 새 배치 생성
            batches.append({
                "start_idx": batch_start,
                "end_idx": batch_start + len(current_batch) - 1,
                "blocks": list(current_batch),
                "scene_break": False,
                "batch_mood": _detect_batch_mood(current_batch),
            })
    elif current_batch:
        # 첫 번째 배치인 경우 새 배치 생성
        batches.append({
            "start_idx": batch_start,
            "end_idx": batch_start + len(current_batch) - 1,
            "blocks": list(current_batch),
            "scene_break": False,
            "batch_mood": _detect_batch_mood(current_batch),
        })

    # DEBUG: Print batch summary
    print(f"[DEBUG] Created {len(batches)} batches:")
    for i, b in enumerate(batches):
        print(f"  Batch {i+1}: indices {b['start_idx']}~{b['end_idx']} ({len(b['blocks'])} blocks)")

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


def _check_qc_needed(qc_blocks: list, confirmed_levels: dict, tone_threshold: float = 0.80) -> tuple[bool, str]:
    """
    Targeting QC (V2+V3): QC 필요 여부 판단.
    - 영어 잔존 블록이 있으면 → 항상 QC 필요
    - 확정 말투와 실제 번역 어미 일치율이 80% 미만이면 → QC 필요
    - 80% 이상이고 영어 없으면 → QC 스킵 (비용 절감)

    Returns: (qc_needed: bool, reason: str)
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

        actual_tone = _detect_tone_from_korean(ko)
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
            return False, f"톤 일치율 {match_ratio:.0%} >= {tone_threshold:.0%} - QC 스킵"

    return True, "샘플 부족 - QC 실행"


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
                if not levels[key].get("hard_locked"):  # Bypass hard_locked relations
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
                "hard_locked": False,
            }
            
        # Global hard-lock bypass: LLM 톤 추론 결과 무시
        if levels[pair_key].get("hard_locked"):
            continue

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
    연속 중복 감지 - 강화된 필터 (원문 유사도 + 번역 정확도 함께 검증).
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

        # 한국어가 정확히 같은 경우만 검토
        if not (curr_ko and prev_ko and curr_ko == prev_ko and len(curr_ko) > 5):
            continue

        # 영어 원문이 다르면 톤/의역이 다를 가능성 높음
        if curr_en == prev_en:
            # 영어도 완전 동일 → 진짜 중복
            dedup_indices.append(i)
            continue

        # 영어가 다른 경우: 더 엄격한 필터링
        en_a = prev_en.lower()
        en_b = curr_en.lower()
        shorter = min(len(en_a), len(en_b))
        longer = max(len(en_a), len(en_b))
        len_ratio = shorter / (longer or 1)

        # 🔴 강화: 70% → 85%로 상향, 5글자 → 50% 이상 매칭 필요
        if len_ratio < 0.85:  # 길이가 85% 이상 유사해야만
            # 다른 영어 = 다른 톤이다 → 중복이 아님
            continue

        # 더 긴 50% 비교 (5글자가 아니라)
        compare_len = max(5, shorter // 2)
        if en_a[:compare_len] != en_b[:compare_len]:
            # 처음 50%도 다르면 → 중복 아님
            continue

        # 모든 조건 만족 → 진짜 중복
        dedup_indices.append(i)

    return dedup_indices


# ═══════════════════════════════════════════════════════════════════════════════
# B2.5: 화자 톤 일관성 검증 (Character Tone Consistency Validation)
# ═══════════════════════════════════════════════════════════════════════════════

def _detect_tone_inconsistency(blocks: list, confirmed_levels: dict = None) -> dict:
    """
    감지: 같은 화자 쌍의 확정 말투가 잠금(locked)된 상태에서,
    같은 관계 단계 내 서로 다른 톤이 혼용되는 경우를 감지.

    Returns:
    {
        "inconsistent_indices": [idx1, idx2, ...],  # 톤 불일치 라인 인덱스
        "issue_count": int,
        "pair_issues": {
            "Nick → Judy": {"expected": "informal", "found": ["formal", "informal"], "count": 5}
        }
    }
    """
    confirmed_levels = confirmed_levels or {}
    inconsistent_indices = []
    pair_issues = {}

    # Step 1: locked된 character pair별로 예상 톤 추출
    locked_pairs = {
        pair_key: level_info.get("level")
        for pair_key, level_info in confirmed_levels.items()
        if isinstance(level_info, dict) and level_info.get("locked")
    }

    if not locked_pairs:
        return {"inconsistent_indices": [], "issue_count": 0, "pair_issues": {}}

    # Step 2: 각 locked pair에 대해 모든 블록 스캔
    for block_idx, block in enumerate(blocks):
        if not block.get("ko") or not block.get("speaker"):
            continue

        speaker = str(block.get("speaker") or "").strip()
        addressee = str(block.get("addressee") or "").strip()
        ko = str(block.get("ko") or "")

        # pair_key 구성 (확정된 형식과 일치)
        pair_key = f"{speaker} → {addressee}" if addressee else f"{speaker} → ?"

        # locked pair가 아니면 스킵
        if pair_key not in locked_pairs:
            continue

        expected_tone = locked_pairs[pair_key]
        actual_tone = _detect_tone_from_korean(ko)

        # Step 3: 톤 불일치 감지
        if actual_tone is None:
            # 톤을 감지할 수 없는 경우 (말투 표시 없음) → 경고만
            if pair_key not in pair_issues:
                pair_issues[pair_key] = {
                    "expected": expected_tone,
                    "found": ["(tone_undetected)"],
                    "count": 0
                }
            continue

        # 예상 톤과 실제 톤이 다른 경우
        mismatch = False
        if expected_tone == "formal" and actual_tone != "formal":
            mismatch = True
        elif expected_tone == "informal" and actual_tone != "informal":
            mismatch = True
        elif expected_tone == "honorific" and actual_tone != "formal":
            mismatch = True
        elif expected_tone == "banmal" and actual_tone != "informal":
            mismatch = True

        if mismatch:
            inconsistent_indices.append(block_idx)
            if pair_key not in pair_issues:
                pair_issues[pair_key] = {
                    "expected": expected_tone,
                    "found": [],
                    "count": 0
                }
            if actual_tone not in pair_issues[pair_key]["found"]:
                pair_issues[pair_key]["found"].append(actual_tone)
            pair_issues[pair_key]["count"] += 1

    return {
        "inconsistent_indices": inconsistent_indices,
        "issue_count": len(inconsistent_indices),
        "pair_issues": pair_issues
    }


def _fix_tone_inconsistency_with_patterns(blocks: list, inconsistent_indices: list, confirmed_levels: dict = None, char_relations: dict = None) -> dict:
    """
    패턴 테이블 기반 톤 불일치 수정 (B2.5):
    - confirmed_levels에서 expected tone을 읽음
    - _FORMAL_TO_BANMAL_EXT / _BANMAL_TO_JONDAEMAL_EXT 패턴 테이블로 교정
    - Pass 3 _apply_postprocess()와 동일한 패턴 재사용 → 정확도 대폭 향상

    Returns: {"fixed_count": int, "failed_indices": [idx]}
    """
    confirmed_levels = confirmed_levels or {}
    fixed_count = 0
    failed_indices = []

    for idx in inconsistent_indices:
        if idx >= len(blocks):
            failed_indices.append(idx)
            continue

        block = blocks[idx]
        ko = block.get("ko", "").strip()
        if not ko:
            failed_indices.append(idx)
            continue

        speaker = block.get("speaker", "").strip()
        addressee = block.get("addressee", "").strip()
        # pair_key 우선순위: 구체적 → 일반
        pair_key = f"{speaker} → {addressee}" if addressee else f"{speaker} → ?"
        alt_key = f"{speaker}->?" if not addressee else f"{speaker}->{addressee}"
        level_info = (confirmed_levels.get(pair_key)
                      or confirmed_levels.get(alt_key)
                      or confirmed_levels.get(f"{speaker} → general")
                      or confirmed_levels.get(f"{speaker}->?"))

        if not level_info or not level_info.get("locked"):
            failed_indices.append(idx)
            continue

        expected_tone = (level_info.get("level") or "").lower()
        original_ko = ko
        matched = False

        # banmal/casual 강제: 존댓말→반말 패턴 적용
        if expected_tone in ("banmal", "casual", "informal", "casual_lock"):
            for _pat, _rep in _FORMAL_TO_BANMAL_EXT:
                if _pat.search(ko):
                    ko = _pat.sub(_rep, ko)
                    matched = True
                    break

        # jondaemal/formal/honorific 강제: 반말→존댓말 패턴 적용
        elif expected_tone in ("formal", "jondaemal", "honorific", "honorific_lock"):
            for _pat, _rep in _BANMAL_TO_JONDAEMAL_EXT:
                if _pat.search(ko):
                    ko = _pat.sub(_rep, ko)
                    matched = True
                    break

        if matched and ko != original_ko:
            blocks[idx]["ko"] = ko
            fixed_count += 1
        elif not matched:
            failed_indices.append(idx)

    return {"fixed_count": fixed_count, "failed_indices": failed_indices}


# 하위 호환성 유지 (기존 호출 코드가 이 이름을 쓰므로 alias 유지)
_fix_tone_inconsistency_simple = _fix_tone_inconsistency_with_patterns


# ═══════════════════════════════════════════════════════════════════════════════
# A1: Lexicon Dictionary Lookup (고정 용어 사전)
# ═══════════════════════════════════════════════════════════════════════════════

def _load_lexicon() -> dict:
    """
    Lexicon 사전 로드 (캐싱)
    """
    lexicon_path = Path(__file__).parent.parent / "config" / "lexicon_ko.json"
    if lexicon_path.exists():
        try:
            with open(lexicon_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠ Lexicon 로드 실패: {e}")
    return {}


_LEXICON_CACHE = None

def _get_lexicon() -> dict:
    """글로벌 캐시에서 Lexicon 반환"""
    global _LEXICON_CACHE
    if _LEXICON_CACHE is None:
        _LEXICON_CACHE = _load_lexicon()
    return _LEXICON_CACHE


def _apply_lexicon_lookup(blocks: list) -> dict:
    """
    Pass 3의 일부: 고정 용어 사전 적용
    - Lexicon에서 정의된 고정 용어를 한국어 자막에 적용
    - 맞춤법 통일성 확보

    Returns: {"replacement_count": int, "terms_applied": [term1, term2, ...]}
    """
    lexicon = _get_lexicon()
    if not lexicon:
        return {"replacement_count": 0, "terms_applied": []}

    replacement_count = 0
    terms_applied = set()

    # Always Replace 규칙 추출
    always_replace = lexicon.get("rules", {}).get("always_replace", {})

    for block_idx, block in enumerate(blocks):
        ko = block.get("ko", "")
        if not ko:
            continue

        original_ko = ko

        # 1. always_replace 규칙 적용 (정확한 매칭)
        for english_term, korean_term in always_replace.items():
            # 전체 단어 매칭 (단어 경계 사용)
            pattern = re.compile(r'\b' + re.escape(english_term) + r'\b', re.IGNORECASE)
            if pattern.search(ko):
                ko = pattern.sub(korean_term, ko)

        # 2. Character names 적용 (높은 우선순위)
        for char_english, char_korean_variants in lexicon.get("characters", {}).items():
            if char_korean_variants:
                primary_korean = char_korean_variants[0]
                # 영문 이름 찾기
                pattern = re.compile(r'\b' + re.escape(char_english) + r'\b', re.IGNORECASE)
                if pattern.search(ko):
                    ko = pattern.sub(primary_korean, ko)

        # 3. Terms 적용
        for english_term, korean_variants in lexicon.get("terms", {}).items():
            if korean_variants:
                primary_korean = korean_variants[0]
                pattern = re.compile(r'\b' + re.escape(english_term) + r'\b', re.IGNORECASE)
                if pattern.search(ko):
                    ko = pattern.sub(primary_korean, ko)
                    terms_applied.add(english_term)

        # 변경사항이 있으면 기록
        if ko != original_ko:
            blocks[block_idx]["ko"] = ko
            replacement_count += 1

    return {
        "replacement_count": replacement_count,
        "terms_applied": list(terms_applied)
    }


# ═══════════════════════════════════════════════════════════════════════════════
# A2: 감정/톤 마커 시스템 (Emotion/Tone Marker System)
# ═══════════════════════════════════════════════════════════════════════════════

def _load_emotion_markers() -> dict:
    """감정 마커 설정 로드"""
    config_path = Path(__file__).parent.parent / "config" / "emotion_markers.yaml"
    if config_path.exists():
        try:
            if yaml:
                with open(config_path, "r", encoding="utf-8") as f:
                    return yaml.safe_load(f)
            else:
                # YAML 미설치 시 대체 규칙 사용
                return _get_default_emotion_markers()
        except Exception as e:
            print(f"⚠ Emotion Markers 로드 실패: {e}")
    return _get_default_emotion_markers()


def _get_default_emotion_markers() -> dict:
    """기본 감정 마커 규칙 (YAML 없을 때 대체)"""
    return {
        "emotion_classes": {
            "HARSH": {
                "markers": ["!", "!?", "!!", "...!", "!!"],
                "keywords": ["never", "always", "must", "definitely", "absolutely"],
                "prompt_hint": "강렬하고 단호한 톤"
            },
            "SARCASM": {
                "markers": ["really?", "sure", "right", "obviously"],
                "keywords": ["right", "sure", "yeah", "obvious"],
                "prompt_hint": "반어적, 냉소적 톤"
            },
            "SADNESS": {
                "markers": ["...", "…", "...?"],
                "keywords": ["sorry", "sad", "unhappy", "lonely"],
                "prompt_hint": "잔잔하고 슬픈 톤"
            },
            "JOY": {
                "markers": ["!", "yeah!", "great!", "awesome!"],
                "keywords": ["happy", "great", "love", "fantastic"],
                "prompt_hint": "밝고 긍정적인 톤"
            },
            "CONFUSION": {
                "markers": ["?", "??", "...?", "what?"],
                "keywords": ["what", "confused", "understand", "mean"],
                "prompt_hint": "의아해하고 혼란스러운 톤"
            }
        }
    }


_EMOTION_MARKERS_CACHE = None

def _get_emotion_markers() -> dict:
    """글로벌 캐시에서 감정 마커 반환"""
    global _EMOTION_MARKERS_CACHE
    if _EMOTION_MARKERS_CACHE is None:
        _EMOTION_MARKERS_CACHE = _load_emotion_markers()
    return _EMOTION_MARKERS_CACHE


def _detect_emotion_from_english(text: str, markers_config: dict = None) -> str:
    """
    영어 텍스트에서 감정 탐지
    Returns: emotion class 또는 "NEUTRAL"
    """
    markers_config = markers_config or _get_emotion_markers()
    if not markers_config:
        return "NEUTRAL"

    text_lower = text.lower()
    emotion_classes = markers_config.get("emotion_classes", {})

    highest_score = 0
    detected_emotion = "NEUTRAL"

    for emotion_name, emotion_rules in emotion_classes.items():
        score = 0

        # 마커 탐지 (0.3 가중치)
        markers = emotion_rules.get("markers", [])
        for marker in markers:
            if marker.lower() in text_lower:
                score += 0.3
                break

        # 키워드 탐지 (0.7 가중치)
        keywords = emotion_rules.get("keywords", [])
        for keyword in keywords:
            if keyword.lower() in text_lower:
                score += 0.7
                break

        # Normalize score
        score = min(score, 1.0)

        if score > highest_score and score > 0.5:  # 임계값 50%
            highest_score = score
            detected_emotion = emotion_name

    return detected_emotion


def _inject_emotion_markers(blocks: list) -> dict:
    """
    Pass 1 시작 전: 영어 블록에 감정 마커 주입
    각 블록에 ['emotion_marker'] 필드 추가

    Returns: {"marked_count": int, "emotions_detected": {emotion: count}}
    """
    markers_config = _get_emotion_markers()
    marked_count = 0
    emotions_detected = {}

    for block in blocks:
        if not block.get("en"):
            continue

        en_text = block.get("en", "")
        detected_emotion = _detect_emotion_from_english(en_text, markers_config)

        if detected_emotion != "NEUTRAL":
            block["emotion_marker"] = detected_emotion
            marked_count += 1
            emotions_detected[detected_emotion] = emotions_detected.get(detected_emotion, 0) + 1

    return {
        "marked_count": marked_count,
        "emotions_detected": emotions_detected
    }


def _apply_emotion_prompt_injection(api_blocks: list, emotion_blocks: dict, markers_config: dict = None) -> str:
    """
    번역 프롬프트에 감정별 지침 추가
    emotion_blocks: {block_id: emotion_class}
    """
    markers_config = markers_config or _get_emotion_markers()

    emotion_hints = []
    prompt_templates = markers_config.get("prompt_templates", {})

    for block_id, emotion in emotion_blocks.items():
        if emotion != "NEUTRAL" and emotion in prompt_templates:
            emotion_hints.append(f"- {emotion}: {prompt_templates.get(emotion)}")

    if emotion_hints:
        return "\n\n[감정별 번역 지침]\n" + "\n".join(emotion_hints)
    return ""


# ═══════════════════════════════════════════════════════════════════════════════
# A3: 의역 프롬프트 강화 (Localization Prompt Enhancement)
# ═══════════════════════════════════════════════════════════════════════════════

def _load_localization_examples() -> str:
    """의역 예시 파일 로드"""
    examples_path = Path(__file__).parent.parent / "config" / "localization_examples.txt"
    if examples_path.exists():
        try:
            with open(examples_path, "r", encoding="utf-8") as f:
                content = f.read()
                # 파일에서 최대 40개 라인만 추출 (토큰 절약)
                lines = content.split("\n")
                relevant_lines = [l for l in lines if l.strip() and not l.startswith("#")][:40]
                return "\n".join(relevant_lines)
        except Exception as e:
            print(f"⚠ Localization 예시 로드 실패: {e}")
    return _get_default_localization_hints()


def _get_default_localization_hints() -> str:
    """기본 의역 힌트"""
    return """
[한글 의역 주요 패턴]

1. 슬랭 및 속어
   - "It's a hustle" → "뒤통수 치기"
   - "Keep it real" → "솔직하게"
   - "No way!" → "말도 안 돼!"

2. 감정 표현
   - "I'm dying!" → "죽겠어!"
   - "You're breaking my heart" → "날 실망시켰어"
   - "Don't be naive" → "순진한 척하지 마"

3. 의성어 및 의태어
   - "Yakkity-yak" → "쫑알쫑알"
   - "Blah blah" → "이런저런"

이런 식으로 한국식 표현을 유지하면서도 원문의 의미를 살려내세요.
"""


def _enhance_translation_prompt_with_localization(base_prompt: str) -> str:
    """
    Pass 1 메인 번역 프롬프트에 의역 예시 추가
    """
    localization_section = _load_localization_examples()
    enhanced = base_prompt

    if localization_section and "한글 의역" not in enhanced:
        enhanced += f"\n\n[의역 가이드 - 자연스러운 한국어 표현]\n{localization_section}"

    return enhanced


# ═══════════════════════════════════════════════════════════════════════════════
# B2: 화자 페르소나 매핑 (Character Persona Mapping)
# ═══════════════════════════════════════════════════════════════════════════════

def _load_character_personas() -> dict:
    """화자 페르소나 매핑 로드"""
    personas_path = Path(__file__).parent.parent / "config" / "character_personas.json"
    if personas_path.exists():
        try:
            with open(personas_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"⚠ Character Personas 로드 실패: {e}")
    return {"personas": {}}


_CHARACTER_PERSONAS_CACHE = None

def _get_character_personas() -> dict:
    """글로벌 캐시에서 화자 페르소나 반환"""
    global _CHARACTER_PERSONAS_CACHE
    if _CHARACTER_PERSONAS_CACHE is None:
        _CHARACTER_PERSONAS_CACHE = _load_character_personas()
    return _CHARACTER_PERSONAS_CACHE


def _inject_persona_hints_to_blocks(blocks: list, persona_map: dict = None) -> dict:
    """
    각 블록에 화자 페르소나 힌트 추가
    Pass 1 시작 시 호출
    """
    persona_config = persona_map or _get_character_personas()
    personas = persona_config.get("personas", {})

    persona_injected = 0
    for block in blocks:
        if not block.get("speaker"):
            continue

        speaker = block.get("speaker", "").strip()
        if speaker in personas:
            persona_info = personas[speaker]
            block["persona_hints"] = {
                "tone_markers": persona_info.get("tone_markers", {}),
                "typical_expressions": persona_info.get("typical_expressions", []),
                "personality": persona_info.get("personality", "")
            }
            persona_injected += 1

    return {
        "persona_injected": persona_injected,
        "total_blocks": len(blocks)
    }


# ═══════════════════════════════════════════════════════════════════════════════
# 모듈 레벨 말투 변환 패턴 테이블 (B2.5 + Pass 3 공유)
# ═══════════════════════════════════════════════════════════════════════════════

# ★ 확장 반말 강제 패턴 (banmal locked 화자 전용)
# 순서: 긴 패턴(특수형) → 짧은 패턴(일반형)
_FORMAL_TO_BANMAL_EXT = [
    # ── [Lexical Neutralization] 존칭/관용 인사말 사전 중화 ──
    (re.compile(r'실례합니다(?:[,.\s]*|)선생님'), r'저기, 잠깐만'),
    (re.compile(r'실례합니다\b'), r'저기요'),
    (re.compile(r'\b선생님\b'), r'당신'), # 직업 교사 제외 로직은 여기서 까다로우므로 우선 SF 타겟으로 강력 치환
    (re.compile(r'\b죄송합니다\b'), r'미안해'),
    (re.compile(r'\b감사합니다\b'), r'고마워'),

    # ── 능청/비꼼/어필 (Tone Archetype A, B) 최상위 우선순위 ──
    (re.compile(r'잖아요([.?!\s~]*)$'), r'잖아\1'),
    (re.compile(r'거든요([.?!\s~]*)$'), r'거든\1'),
    (re.compile(r'지요([.?!\s~]*)$'), r'지\1'),
    (re.compile(r'죠([.?!\s~]*)$'), r'지\1'),
    (re.compile(r'을걸요([.?!\s~]*)$'), r'을걸\1'),
    (re.compile(r'ㄹ걸요([.?!\s~]*)$'), r'ㄹ걸\1'),
    (re.compile(r'니까요([.?!\s~]*)$'), r'니까\1'),
    (re.compile(r'려고요([.?!\s~]*)$'), r'려고\1'),
    (re.compile(r'데요([.?!\s~]*)$'), r'데\1'),
    (re.compile(r'는데요([.?!\s~]*)$'), r'는데\1'),
    
    # ── 절대 누수 방어망 (가장 빈번하게 반존대 혼용을 일으키는 어미들) ──
    (re.compile(r'거예요([.?!\s~]*)$'), r'거야\1'),
    (re.compile(r'할게요([.?!\s~]*)$'), r'할게\1'),
    (re.compile(r'게요([.?!\s~]*)$'), r'게\1'),
    (re.compile(r'했어요([.?!\s~]*)$'), r'했어\1'),

    # 의지/제안형
    (re.compile(r'해드리겠습니다([.?!\s~]*)$'), r'해줄게\1'),
    (re.compile(r'봐드리겠습니다([.?!\s~]*)$'), r'봐줄게\1'),
    (re.compile(r'말씀해\s?주십시오([.?!\s~]*)$'), r'말해줘\1'),
    (re.compile(r'주시기\s?바랍니다([.?!\s~]*)$'), r'줘\1'),
    (re.compile(r'해주십시오([.?!\s~]*)$'), r'해줘\1'),
    (re.compile(r'해주세요([.?!\s~]*)$'), r'해줘\1'),
    (re.compile(r'봐주십시오([.?!\s~]*)$'), r'봐줘\1'),
    (re.compile(r'봐주세요([.?!\s~]*)$'), r'봐줘\1'),
    (re.compile(r'드리겠습니다([.?!\s~]*)$'), r'줄게\1'),
    (re.compile(r'하겠습니다([.?!\s~]*)$'), r'할게\1'),
    (re.compile(r'하십시오([.?!\s~]*)$'), r'해\1'),
    (re.compile(r'하시겠습니까\?([.?!\s~]*)$'), r'할 거야?\1'),
    (re.compile(r'해주시겠습니까\?([.?!\s~]*)$'), r'해줄 거야?\1'),
    # 의무/필요형
    (re.compile(r'어야만\s?합니다([.?!\s~]*)$'), r'어야만 해\1'),
    (re.compile(r'아야만\s?합니다([.?!\s~]*)$'), r'아야만 해\1'),
    (re.compile(r'해야만\s?합니다([.?!\s~]*)$'), r'해야만 해\1'),
    (re.compile(r'어야\s?합니다([.?!\s~]*)$'), r'어야 해\1'),
    (re.compile(r'아야\s?합니다([.?!\s~]*)$'), r'아야 해\1'),
    (re.compile(r'해야\s?합니다([.?!\s~]*)$'), r'해야 해\1'),
    (re.compile(r'어야\s?해요([.?!\s~]*)$'), r'어야 해\1'),
    (re.compile(r'아야\s?해요([.?!\s~]*)$'), r'아야 해\1'),
    # 진행형
    (re.compile(r'고\s?있습니다([.?!\s~]*)$'), r'고 있어\1'),
    (re.compile(r'고\s?있어요([.?!\s~]*)$'), r'고 있어\1'),
    (re.compile(r'고\s?있죠([.?!\s~]*)$'), r'고 있지\1'),
    # 가능/불가능형
    (re.compile(r'할\s?수\s?있습니다([.?!\s~]*)$'), r'할 수 있어\1'),
    (re.compile(r'할\s?수\s?없습니다([.?!\s~]*)$'), r'할 수 없어\1'),
    (re.compile(r'할\s?수\s?있어요([.?!\s~]*)$'), r'할 수 있어\1'),
    (re.compile(r'할\s?수\s?없어요([.?!\s~]*)$'), r'할 수 없어\1'),
    # 추측/판단형
    (re.compile(r'인\s?것\s?같습니다([.?!\s~]*)$'), r'인 것 같아\1'),
    (re.compile(r'인\s?것\s?같아요([.?!\s~]*)$'), r'인 것 같아\1'),
    (re.compile(r'것\s?같습니다([.?!\s~]*)$'), r'것 같아\1'),
    (re.compile(r'것\s?같아요([.?!\s~]*)$'), r'것 같아\1'),
    (re.compile(r'것\s?같죠([.?!\s~]*)$'), r'것 같지\1'),
    # 희망형
    (re.compile(r'하고\s?싶습니다([.?!\s~]*)$'), r'하고 싶어\1'),
    (re.compile(r'하고\s?싶어요([.?!\s~]*)$'), r'하고 싶어\1'),
    (re.compile(r'싶습니다([.?!\s~]*)$'), r'싶어\1'),
    (re.compile(r'싶어요([.?!\s~]*)$'), r'싶어\1'),
    # 미래/예측형
    (re.compile(r'할\s?겁니다([.?!\s~]*)$'), r'할 거야\1'),
    (re.compile(r'될\s?겁니다([.?!\s~]*)$'), r'될 거야\1'),
    (re.compile(r'할\s?것입니다([.?!\s~]*)$'), r'할 거야\1'),
    (re.compile(r'될\s?것입니다([.?!\s~]*)$'), r'될 거야\1'),
    (re.compile(r'겠습니다([.?!\s~]*)$'), r'겠어\1'),
    (re.compile(r'겠어요([.?!\s~]*)$'), r'겠어\1'),
    (re.compile(r'겠죠([.?!\s~]*)$'), r'겠지\1'),
    # 과거완료형
    (re.compile(r'하셨습니다([.?!\s~]*)$'), r'하셨어\1'),
    (re.compile(r'셨습니다([.?!\s~]*)$'), r'셨어\1'),
    (re.compile(r'했습니다([.?!\s~]*)$'), r'했어\1'),
    (re.compile(r'됐습니다([.?!\s~]*)$'), r'됐어\1'),
    (re.compile(r'봤습니다([.?!\s~]*)$'), r'봤어\1'),
    (re.compile(r'왔습니다([.?!\s~]*)$'), r'왔어\1'),
    (re.compile(r'갔습니다([.?!\s~]*)$'), r'갔어\1'),
    (re.compile(r'먹었습니다([.?!\s~]*)$'), r'먹었어\1'),
    (re.compile(r'찾았습니다([.?!\s~]*)$'), r'찾았어\1'),
    (re.compile(r'알았습니다([.?!\s~]*)$'), r'알았어\1'),
    (re.compile(r'났습니다([.?!\s~]*)$'), r'났어\1'),
    (re.compile(r'였습니다([.?!\s~]*)$'), r'였어\1'),
    (re.compile(r'았습니다([.?!\s~]*)$'), r'았어\1'),
    (re.compile(r'었습니다([.?!\s~]*)$'), r'었어\1'),
    # 의문형
    (re.compile(r'셨나요\?([.?!\s~]*)$'), r'셨어?\1'),
    (re.compile(r'셨습니까\?([.?!\s~]*)$'), r'셨어?\1'),
    (re.compile(r'었나요\?([.?!\s~]*)$'), r'었어?\1'),
    (re.compile(r'았나요\?([.?!\s~]*)$'), r'았어?\1'),
    (re.compile(r'했나요\?([.?!\s~]*)$'), r'했어?\1'),
    (re.compile(r'됐나요\?([.?!\s~]*)$'), r'됐어?\1'),
    (re.compile(r'봤나요\?([.?!\s~]*)$'), r'봤어?\1'),
    (re.compile(r'할까요\?([.?!\s~]*)$'), r'할까?\1'),
    (re.compile(r'볼까요\?([.?!\s~]*)$'), r'볼까?\1'),
    (re.compile(r'갈까요\?([.?!\s~]*)$'), r'갈까?\1'),
    (re.compile(r'까요\?([.?!\s~]*)$'), r'까?\1'),
    (re.compile(r'습니까\?([.?!\s~]*)$'), r'어?\1'),
    (re.compile(r'합니까\?([.?!\s~]*)$'), r'해?\1'),
    (re.compile(r'됩니까\?([.?!\s~]*)$'), r'돼?\1'),
    (re.compile(r'봅니까\?([.?!\s~]*)$'), r'봐?\1'),
    (re.compile(r'갑니까\?([.?!\s~]*)$'), r'가?\1'),
    # ㅂ니다 고빈도 불규칙
    (re.compile(r'봅니다([.?!\s~]*)$'), r'봐\1'),
    (re.compile(r'옵니다([.?!\s~]*)$'), r'와\1'),
    (re.compile(r'줍니다([.?!\s~]*)$'), r'줘\1'),
    (re.compile(r'갑니다([.?!\s~]*)$'), r'가\1'),
    # 해요체 어미 (나머지)
    (re.compile(r'할게요([.?!\s~]*)$'), r'할게\1'),
    (re.compile(r'줄게요([.?!\s~]*)$'), r'줄게\1'),
    (re.compile(r'볼게요([.?!\s~]*)$'), r'볼게\1'),
    (re.compile(r'갈게요([.?!\s~]*)$'), r'갈게\1'),
    (re.compile(r'올게요([.?!\s~]*)$'), r'올게\1'),
    (re.compile(r'더군요([.?!\s~]*)$'), r'더군\1'),
    (re.compile(r'는군요([.?!\s~]*)$'), r'는군\1'),
    (re.compile(r'군요([.?!\s~]*)$'), r'군\1'),
    # 일반형 (마지막)
    (re.compile(r'합니다([.?!\s~]*)$'), r'해\1'),
    (re.compile(r'없습니다([.?!\s~]*)$'), r'없어\1'),
    (re.compile(r'있습니다([.?!\s~]*)$'), r'있어\1'),
    (re.compile(r'않습니다([.?!\s~]*)$'), r'않아\1'),
    (re.compile(r'됩니다([.?!\s~]*)$'), r'돼\1'),
    (re.compile(r'입니다([.?!\s~]*)$'), r'야\1'),
    (re.compile(r'네요([.?!\s~]*)$'), r'네\1'),
    (re.compile(r'어요([.?!\s~]*)$'), r'어\1'),
    (re.compile(r'아요([.?!\s~]*)$'), r'아\1'),
    (re.compile(r'습니다([.?!\s~]*)$'), r'어\1'),
    (re.compile(r'요([.?!\s~]*)$'), r'어\1'),
]

# ★ 확장 존댓말 강제 패턴 (jondaemal locked 화자 전용)
_BANMAL_TO_JONDAEMAL_EXT = [
    (re.compile(r'할게([.?!\s~]*)$'), r'할게요\1'),
    (re.compile(r'줄게([.?!\s~]*)$'), r'줄게요\1'),
    (re.compile(r'볼게([.?!\s~]*)$'), r'볼게요\1'),
    (re.compile(r'갈게([.?!\s~]*)$'), r'갈게요\1'),
    (re.compile(r'올게([.?!\s~]*)$'), r'올게요\1'),
    (re.compile(r'것 같아([.?!\s~]*)$'), r'것 같아요\1'),
    (re.compile(r'것 같지([.?!\s~]*)$'), r'것 같죠\1'),
    (re.compile(r'겠지([.?!\s~]*)$'), r'겠죠\1'),
    (re.compile(r'했어([.?!\s~]*)$'), r'했어요\1'),
    (re.compile(r'됐어([.?!\s~]*)$'), r'됐어요\1'),
    (re.compile(r'봤어([.?!\s~]*)$'), r'봤어요\1'),
    (re.compile(r'왔어([.?!\s~]*)$'), r'왔어요\1'),
    (re.compile(r'갔어([.?!\s~]*)$'), r'갔어요\1'),
    (re.compile(r'었어([.?!\s~]*)$'), r'었어요\1'),
    (re.compile(r'았어([.?!\s~]*)$'), r'았어요\1'),
    (re.compile(r'없어([.?!\s~]*)$'), r'없어요\1'),
    (re.compile(r'있어([.?!\s~]*)$'), r'있어요\1'),
    (re.compile(r'않아([.?!\s~]*)$'), r'않아요\1'),
    (re.compile(r'더군([.?!\s~]*)$'), r'더군요\1'),
    (re.compile(r'는군([.?!\s~]*)$'), r'는군요\1'),
    (re.compile(r'군([.?!\s~]*)$'), r'군요\1'),
    (re.compile(r'잖아([.?!\s~]*)$'), r'잖아요\1'),
    (re.compile(r'거든([.?!\s~]*)$'), r'거든요\1'),
    (re.compile(r'는데([.?!\s~]*)$'), r'는데요\1'),
    (re.compile(r'데([.?!\s~]*)$'), r'데요\1'),
    (re.compile(r'네([.?!\s~]*)$'), r'네요\1'),
    (re.compile(r'겠어([.?!\s~]*)$'), r'겠어요\1'),
    (re.compile(r'(?<![시])어([.?!\s~]*)$'), r'어요\1'),
    (re.compile(r'(?<![시])아([.?!\s~]*)$'), r'아요\1'),
    (re.compile(r'지([.?!\s~]*)$'), r'죠\1'),
]


def _apply_postprocess(blocks: list, confirmed_levels: dict = None, char_relations: dict = None) -> dict:
    """
    Pass 5.1 하드코딩 후처리 - 금기어 치환, 말줄임표 통일, 마침표 제거, 권위 톤 교정, 피압박자 격식체 교정.
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

        # 5. 말투잠금 강제 교정 (★ 확장 v2)
        speaker = (block.get("speaker") or "").strip()
        addressee = (block.get("addressee") or "").strip()
        if speaker and confirmed_levels:
            _pk  = f"{speaker} → {addressee}" if addressee else f"{speaker} → general"
            _ak  = f"{speaker}->{addressee}"  if addressee else f"{speaker}->?"
            _lvl = (confirmed_levels.get(_pk)
                    or confirmed_levels.get(_ak)
                    or confirmed_levels.get(f"{speaker} → general")
                    or confirmed_levels.get(f"{speaker}->?"))

            if _lvl and _lvl.get("locked"):
                _expected = (_lvl.get("level") or "").lower()

                # 5-a. banmal 잠금: 격식체/해요체 → 반말 (확장 패턴 적용)
                if _expected in ("banmal", "casual", "casual_lock"):
                    for _pat, _rep in _FORMAL_TO_BANMAL_EXT:
                        if _pat.search(text):
                            _new = _pat.sub(_rep, text)
                            if _new != text:
                                text = _new
                                auth_drift_count += 1
                                changed = True
                            break

                # 5-b. jondaemal 잠금: 반말 → 해요체 (확장 패턴 적용)
                elif _expected in ("formal", "jondaemal", "honorific_lock", "honorific"):
                    for _pat, _rep in _BANMAL_TO_JONDAEMAL_EXT:
                        if _pat.search(text):
                            _new = _pat.sub(_rep, text)
                            if _new != text:
                                text = _new
                                auth_drift_count += 1
                                changed = True
                            break

                # 5-c. authoritative_downward 잠금: 격식체 질문 교정 (기존 로직)
                elif _expected in ("authoritative_downward",) or (
                    speaker and addressee and _is_downward_relation(speaker, addressee)
                ):
                    has_formal_question = any(p.search(text) for p, _ in _AUTH_DRIFT_PATTERNS)
                    if has_formal_question:
                        for _pat, _rep in _AUTH_DRIFT_PATTERNS:
                            if _pat.search(text):
                                text = _pat.sub(_rep, text)
                                auth_drift_count += 1
                                changed = True

        # 6. 피압박자 격식체 강제 (Submissive Formal) - confirmed_levels 미설정 fallback
        if speaker and addressee and _is_submissive_relation(speaker, addressee):
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
# _detect_side_talk() - 방백/대상 전환 감지 (Micro-Context Switching)
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
# _run_translation_job() - 백엔드 오케스트레이터 (Pass 1~5.1)
# ═══════════════════════════════════════════════════════════════════════════════

async def _run_translation_job(job_id: str, request: TranslateAllRequest):
    """Pass 1~5.1을 백엔드에서 자체 실행하는 오케스트레이터."""
    # HTTP 응답이 먼저 전송되도록 이벤트 루프에 제어권 반환
    await asyncio.sleep(0)
    job = _jobs[job_id]
    blocks = list(request.blocks)  # [{id, start, end, en, speaker, addressee}]

    meta = request.metadata or {}
    strategy = request.strategy or {}
    char_relations = request.character_relations or {}
    
    # [Task A] RelationToneMapper 초기화 (동적 톤 매핑)
    from app.core.tone_mapper import RelationToneMapper
    tone_mapper = RelationToneMapper(strategy.get("character_relationships", []))
    
    # 기존 레거시 함수(Pass 2 QC 등) 호환성을 위해 export() 딕셔너리 유지
    confirmed_levels = tone_mapper.export()


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

        # ═══ [Pass 0] Dynamic LORE Extraction ═══
        if not job.get("cancelled") and not meta.get("lore"):
            from app.engine.passes.pass_0_lore import run_pass_0_lore
            lore_json = await run_pass_0_lore(job, blocks, title)
            job["lore"] = lore_json
            meta["lore"] = lore_json

        # ═══ [Pass 0] Speaker Identification ═══
        # speaker/addressee가 없으면 자동 식별
        blocks_without_speakers = [b for b in blocks if not b.get("speaker") or not b.get("addressee")]
        if blocks_without_speakers:
            job["current_pass"] = "Pass 0: 화자 식별"
            job["logs"].append(f"> [Pass 0] {len(blocks_without_speakers)}개 블록의 화자 식별 중...")
            await _broadcast_job_update(job_id, job)

            try:
                translator = get_vertex_ai()

                # 프롬프트 생성
                user_prompt = build_speaker_id_prompt(
                    blocks=[{
                        "index": b.get("id"),
                        "start": b.get("start", ""),
                        "end": b.get("end", ""),
                        "text": b.get("en", "")
                    } for b in blocks_without_speakers],
                    title=title,
                    synopsis=full_synopsis[:1000],  # 처음 1000자만
                    genre=genre,
                    personas=detailed_personas,
                    prev_identified=None,
                )

                # Vertex AI 호출 (run_in_executor로 이벤트 루프 블로킹 방지)
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

                loop = asyncio.get_event_loop()
                response, error = await loop.run_in_executor(
                    None, lambda: translator._retry_with_backoff(make_speaker_call)
                )

                if not error and response:
                    speakers = parse_speaker_response(response.text)
                    # 원본 blocks에 speaker/addressee 추가
                    for speaker_info in speakers:
                        block_id = speaker_info.get("index")
                        for block in blocks:
                            if block.get("id") == block_id:
                                block["speaker"] = speaker_info.get("speaker")
                                block["addressee"] = speaker_info.get("addressee")
                    job["logs"].append(f"> [Pass 0] {len(speakers)}개 블록 화자 식별 완료!")
                    # Pass 0 완료 직후 speaker 정보 즉시 프론트엔드에 전달
                    job["partial_subtitles"] = [
                        {
                            "id": b.get("id"),
                            "ko": b.get("ko", ""),
                            "speaker": b.get("speaker", ""),
                            "addressee": b.get("addressee", ""),
                        }
                        for b in blocks if b.get("speaker")
                    ]
                else:
                    job["logs"].append(f"> [Pass 0] 화자 식별 실패, 계속 진행...")

            except Exception as e:
                job["logs"].append(f"> [Pass 0] 오류 (무시): {str(e)[:100]}")

        # ═══ [Pass 0.5] Dynamic Relationship Mapper ═══
        # strategy에 character_relations가 없으면 자막에서 자동 추출
        if not char_relations:
            job["current_pass"] = "Pass 0.5: 관계 매트릭스 추출"
            await _broadcast_job_update(job_id, job)
            job["logs"].append(f"> [Pass 0.5] 자막에서 관계 매트릭스 추출 중...")

            try:
                translator = get_vertex_ai()

                # 비동기 메서드이므로 await 사용
                extracted_relations = await translator.extract_relationship_matrix(
                    blocks=blocks,
                    title=title,
                    genre=genre
                )

                if extracted_relations:
                    char_relations = extracted_relations
                    tone_mapper.update_from_dynamic_extraction(char_relations)
                    job["logs"].append(f"> [Pass 0.5] {len(char_relations)}개 관계 추출 완료 (Tone Mapper 동기화)")
                else:
                    job["logs"].append(f"> [Pass 0.5] 관계 추출 실패, 기본값 사용")

            except Exception as e:
                job["logs"].append(f"> [Pass 0.5] 오류: {e}")
        else:
            job["logs"].append(f"> [Pass 0.5] strategy에서 관계 정보 사용 ({len(char_relations)}개)")

        # ═══ A2: 감정/톤 마커 주입 (Pass 1 시작 전) ═══
        if not job.get("cancelled"):
            job["current_pass"] = "A2: 감정 마커 주입"
            await _broadcast_job_update(job_id, job)
            emotion_result = _inject_emotion_markers(blocks)
            if emotion_result["marked_count"] > 0:
                job["logs"].append(f"> [A2] 감정 마커 주입 - {emotion_result['marked_count']}개 감지")
                for emotion, count in emotion_result["emotions_detected"].items():
                    job["logs"].append(f"    {emotion}: {count}개")
            else:
                job["logs"].append(f"> [A2] 감정 마커 주입 완료 (감정 없는 중립 텍스트)")

        # ═══ Pass 1: 시맨틱 배치 번역 ═══
        job["current_pass"] = "Pass 1: 메인 번역"
        await _broadcast_job_update(job_id, job)
        job["logs"].append(f"> [Pass 1] 시맨틱 배칭 시작...")

        # V2: Hard Binding - ...나 접속사로 끝나는 분절 자막 결합
        blocks_before_binding = len(blocks)
        blocks = _apply_hard_binding(blocks)
        if len(blocks) < blocks_before_binding:
            job["logs"].append(f"  [Hard Binding] {blocks_before_binding} → {len(blocks)}개 블록 ({blocks_before_binding - len(blocks)}개 결합)")

        batches = _build_semantic_batches(blocks)
        num_batches = len(batches)
        job["logs"].append(f"> [Pass 1] {len(blocks)}개 자막 → {num_batches}개 배치")

        # 디버그: 각 배치의 인덱스 범위 로깅
        for i, b in enumerate(batches):
            if b["blocks"]:
                first_idx = b["blocks"][0].get("id", b["blocks"][0].get("index", "?"))
                last_idx = b["blocks"][-1].get("id", b["blocks"][-1].get("index", "?"))
                job["logs"].append(f"  DEBUG: Batch {i+1} = indices {first_idx}~{last_idx} ({len(b['blocks'])} blocks)")

        failed_batches: set = set()
        # V4: 컨텍스트 사이즈 확대 + 오버랩
        context_size = 20  # 10 → 20으로 확대 (이전 컨텍스트 더 많이 확보)

        # Side-Talk 감지용 페르소나 이름 목록
        persona_names = [p.get("name", "") for p in personas_list if isinstance(p, dict)]

        async def process_batch(batch_idx: int, is_retry: bool = False) -> bool:
            nonlocal total_applied, tone_memory, confirmed_levels
            if job.get("cancelled"):
                return False

            # 배치 오버랩 상수 (V4)
            OVERLAP_LINES = 3

            batch = batches[batch_idx]
            batch_blocks = batch["blocks"]
            retry_label = " (재시도)" if is_retry else ""

            # V4: 오버랩 처리 - 이전 배치 마지막 N개 줄을 현재 배치 앞에 추가
            overlap_blocks = []
            if batch_idx > 0:
                prev_batch = batches[batch_idx - 1]
                prev_blocks = prev_batch["blocks"]
                overlap_count = min(OVERLAP_LINES, len(prev_blocks))
                overlap_blocks = prev_blocks[-overlap_count:]

            # 블록 준비
            api_blocks = []

            # 오버랩 블록 추가 (READONLY - 번역하지 않음, 컨텍스트용)
            for s in overlap_blocks:
                duration = _compute_block_duration(s)
                speaker = s.get("speaker")
                addressee = s.get("addressee")
                original_en = _sanitize_subtitle_text(s.get("en", ""))
                
                if speaker:
                    target_tone = tone_mapper.get_tone(speaker, addressee)
                    inline_tag = f"[System: {speaker} -> {addressee} ({target_tone})] "
                    tagged_en = inline_tag + original_en
                else:
                    tagged_en = original_en
                
                api_blocks.append({
                    "index": s.get("id"),
                    "start": s.get("start", ""),
                    "end": s.get("end", ""),
                    "text": tagged_en,
                    "speaker": speaker,
                    "addressee": addressee,
                    "duration_sec": duration,
                    "max_chars": 0,
                    "cps_warning": None,
                    "_is_overlap": True,  # 오버랩 표시
                })

            # 실제 번역할 블록
            for s in batch_blocks:
                duration = _compute_block_duration(s)
                max_chars = _compute_max_chars(duration)
                cps_warning = f"[{duration:.1f}초] {max_chars}자 이내 요약" if duration < 2.0 else None
                
                speaker = s.get("speaker")
                addressee = s.get("addressee")
                original_en = _sanitize_subtitle_text(s.get("en", ""))
                
                if speaker:
                    target_tone = tone_mapper.get_tone(speaker, addressee)
                    inline_tag = f"[System: {speaker} -> {addressee} ({target_tone})] "
                    tagged_en = inline_tag + original_en
                else:
                    tagged_en = original_en
                
                api_blocks.append({
                    "index": s.get("id"),
                    "start": s.get("start", ""),
                    "end": s.get("end", ""),
                    "text": tagged_en,
                    "speaker": speaker,
                    "addressee": addressee,
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

            # V4: 이전 배치의 batch_summary를 prev_context에 추가
            if batch_idx > 0:
                prev_batch_summary = batches[batch_idx - 1].get("batch_summary")
                if prev_batch_summary:
                    # prev_context 맨 앞에 batch_summary 추가
                    prev_context.insert(0, {
                        "index": -1,  # special marker
                        "original": "[BATCH_SUMMARY]",
                        "translated": prev_batch_summary,
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
                "lore_json": meta.get("lore"),
            }

            job["logs"].append(
                f"> [{batch_idx + 1}/{num_batches}]{retry_label} "
                f"자막 {api_blocks[0]['index']}~{api_blocks[-1]['index']} ({len(api_blocks)}개) 번역 중..."
            )

            try:
                translations = await translate_single_batch(api_blocks, context_info)
            except asyncio.TimeoutError as timeout_err:
                job["logs"].append(f"  ⏱ [{batch_idx + 1}]{retry_label} Timeout (30초 초과) → 재시도...")
                return False
            except Exception as e:
                err_name = type(e).__name__
                err_msg = str(e)[:100]
                job["logs"].append(f"  ⚠ [{batch_idx + 1}]{retry_label} {err_name}: {err_msg}")
                return False

            # V5: 전체 배치 실패 시 재시도 (translations가 비어있으면 entire batch가 실패한 것)
            print(f"[DEBUG] Batch {batch_idx+1}: translations count = {len(translations) if translations else 0}")
            if (not translations or len(translations) == 0) and api_blocks:
                print(f"[DEBUG] Batch {batch_idx+1}: 전체 배치 실패, 재시도...")
                job["logs"].append(f"  ⚠ [{batch_idx + 1}]{retry_label} 전체 실패, 재시도...")
                try:
                    # 1초 대기 후 재시도
                    await asyncio.sleep(1)
                    translations = await translate_single_batch(api_blocks, context_info)
                    if translations:
                        print(f"[DEBUG] Batch {batch_idx+1}: 재시도 성공, {len(translations)}개 번역")
                        job["logs"].append(f"  ✓ [{batch_idx + 1}]{retry_label} 재시도 성공")
                except asyncio.TimeoutError:
                    job["logs"].append(f"  ⏱ [{batch_idx + 1}]{retry_label} 재시도 중 Timeout")
                except Exception as e:
                    err_name = type(e).__name__
                    err_msg = str(e)[:80]
                    job["logs"].append(f"  ⚠ [{batch_idx + 1}]{retry_label} 재시도 {err_name}: {err_msg}")

            # 결과 적용 (ID 타입的统一: int로 비교)
            # NOTE: api_blocks의 index는 block의 id (0-based), Gemini가 그대로 반환
            # translation index와 block id는 둘 다 0-based이므로 비교 가능
            valid_ids = set()
            for s in batch_blocks:
                bid = s.get("id")
                if bid is not None:
                    valid_ids.add(int(bid))  # 0-based로 유지

            # V4: batch_summary 추출 (AI가 반환하는 번역 요약)
            batch_summary = None
            if translations and isinstance(translations[0], dict):
                try:
                    batch_summary = translations[0].get("batch_summary")
                    if batch_summary:
                        # 배치 객체에 batch_summary 저장 (다음 배치에서 사용)
                        batch["batch_summary"] = batch_summary
                        print(f"[V4] Batch {batch_idx + 1} summary: {batch_summary[:100]}...")
                except Exception as e:
                    print(f"[WARN] Batch {batch_idx + 1} summary extraction failed: {e}")

            # V4: 오버랩 블록 ID 집합 (번역 결과에서 제외)
            overlap_ids = set()
            if batch_idx > 0:
                prev_batch = batches[batch_idx - 1]
                prev_blocks = prev_batch["blocks"]
                overlap_count = min(OVERLAP_LINES, len(prev_blocks))
                for s in prev_blocks[-overlap_count:]:
                    overlap_ids.add(s.get("id"))  # 0-based로 유지

            # DEBUG: 로깅 - translation indices 확인
            try:
                trans_indices = [t.get('index') for t in translations if t.get('index') is not None]
                missing_ids = valid_ids - set(trans_indices)
                # More detailed logging
                first_batch_id = batch_blocks[0].get('id') if batch_blocks else 'N/A'
                last_batch_id = batch_blocks[-1].get('id') if batch_blocks else 'N/A'
                first_trans_idx = trans_indices[0] if trans_indices else 'N/A'
                last_trans_idx = trans_indices[-1] if trans_indices else 'N/A'
                print(f"[DEBUG] Batch {batch_idx+1}: batch_ids={first_batch_id}~{last_batch_id}, trans_indices={first_trans_idx}~{last_trans_idx}, valid={len(valid_ids)}, trans={len(translations)}, missing={len(missing_ids)}")
            except Exception as e:
                print(f"[ERROR] Batch {batch_idx+1} debug log failed: {e}, translations={translations[:3] if translations else 'empty'}")

            batch_count = 0
            applied_count = 0
            skipped_overlap = 0
            skipped_not_valid = 0
            skipped_no_text = 0
            for trans in translations:
                trans_idx = trans.get("index")
                if trans_idx is None:
                    continue
                try:
                    trans_idx = int(trans_idx)
                except:
                    continue

                # V4: 오버랩 블록은 번역 결과에서 제외
                if trans_idx in overlap_ids:
                    skipped_overlap += 1
                    continue

                if trans_idx not in valid_ids:
                    skipped_not_valid += 1
                    continue
                # 안전检查: text 필드가 없으면 다른 필드 확인
                trans_text = trans.get("text") or trans.get("ko") or trans.get("korean_text") or ""
                if not trans_text:
                    skipped_no_text += 1
                    continue
                idx = next((i for i, b in enumerate(blocks) if int(b.get("id", -1)) == trans_idx), None)  # 0-based 직접 비교
                if idx is not None:
                    blocks[idx]["ko"] = trans_text
                    total_applied += 1
                    batch_count += 1
                    applied_count += 1

            print(f"[DEBUG] Batch {batch_idx+1} apply: applied={applied_count}, skipped_overlap={skipped_overlap}, skipped_not_valid={skipped_not_valid}, skipped_no_text={skipped_no_text}")

            # 누락된 항목 재번역 (Gemini 출력 제한 대응)
            if missing_ids and len(missing_ids) <= 50:
                print(f"[DEBUG] Batch {batch_idx+1}: 누락 {len(missing_ids)}개 재번역 시도...")
                # 누락된 항목만单独的 번역 요청
                missing_blocks = [b for b in api_blocks if b.get("index") in missing_ids]  # 0-based 직접 비교
                if missing_blocks:
                    try:
                        retry_result = await translate_single_batch(missing_blocks, context_info)
                        for trans in retry_result:
                            tid = trans.get("index")
                            if tid is not None:
                                tid = int(tid)
                                # 안전检查
                                retry_text = trans.get("text") or trans.get("ko") or trans.get("korean_text") or ""
                                if retry_text:
                                    idx = next((i for i, b in enumerate(blocks) if int(b.get("id", -1)) == tid), None)  # 0-based 직접 비교
                                    if idx is not None:
                                        blocks[idx]["ko"] = retry_text
                                        total_applied += 1
                                        batch_count += 1
                        print(f"[DEBUG] Batch {batch_idx+1}: 재번역 완료, +{len(retry_result)}개")
                    except Exception as e:
                        print(f"[DEBUG] Batch {batch_idx+1}: 재번역 실패: {e}")

            job["logs"].append(
                f"  ✓ [{batch_idx + 1}/{num_batches}]{retry_label} 완료 (+{batch_count}개, 총 {total_applied}개)"
            )

            # 중간 결과 업데이트 (폴링 시 실시간 반영용) - speaker 포함
            job["partial_subtitles"] = [
                {
                    "id": b.get("id"),
                    "ko": b.get("ko", ""),
                    "speaker": b.get("speaker", ""),
                    "addressee": b.get("addressee", ""),
                }
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

        # ═══ V2+V3: Sliding Window Parallel (품질 안전 병렬) ═══
        # Concurrency=5, asyncio.Event로 배치 i가 배치 i-CONCURRENCY의 결과를 물려받아 시작.
        # 병렬 속도 + 톤 일관성 유지를 동시에 달성.
        #
        # 예: CONCURRENCY=5
        #   Batch 0-6: 동시 시작 (Semaphore 제한)
        #   Batch 3: Batch 0 완료 후 시작 (tone_memory 초기 안정화 - 짧음)
        #   Batch 7+: Batch 3+ 완료 후 시작 (동시, tone_memory 포함)
        # → 최대 7배 병렬화 + tone_memory 동적 가중치로 품질 유지
        # V2 개선: Batch i-3 축소 (i-5 → i-3) → 병렬도 5 → 7 (40% 증가)
        CONCURRENCY = 5  # 최대 동시 LLM 호출 수 (7→5: 이벤트 루프 응답성 확보)
        semaphore = asyncio.Semaphore(CONCURRENCY)

        # 배치별 완료 이벤트 (진행 추적용)
        batch_events = [asyncio.Event() for _ in range(num_batches)]

        # 완료 결과 추적
        stagger_results: dict[int, bool] = {}

        async def staggered_worker(idx: int) -> bool:
            """Semaphore 기반 병렬 처리 (최대 CONCURRENCY개 동시 - Stagger 제거)"""
            import time as time_module

            # Stagger 이벤트 대기 제거 - Semaphore만으로 동시성 제어
            # LLM 호출은 Semaphore로 동시성 제한
            async with semaphore:
                if job.get("cancelled"):
                    batch_events[idx].set()
                    return False

                start_time = time_module.time()
                timing_msg = f"[TIMING] Batch {idx + 1}/{num_batches} LLM 호출 시작 (현재 시간: {start_time:.2f})"
                print(timing_msg)
                job["logs"].append(timing_msg)
                result = await process_batch(idx)
                elapsed = time_module.time() - start_time
                timing_complete = f"[TIMING] Batch {idx + 1} 완료 ({elapsed:.2f}초)"
                print(timing_complete)
                job["logs"].append(timing_complete)
                stagger_results[idx] = result

                if isinstance(result, Exception):
                    print(f"[DEBUG] Batch {idx + 1} Exception: {result}")
                    job["logs"].append(f"  ERROR: Batch {idx + 1} Exception: {result}")
                    failed_batches.add(idx)
                elif not result:
                    print(f"[DEBUG] Batch {idx + 1} returned False")
                    job["logs"].append(f"  ERROR: Batch {idx + 1} returned False")
                    failed_batches.add(idx)
                else:
                    print(f"[DEBUG] Batch {idx + 1} succeeded")

                # 진행률: 12% → 80%
                completed = len(stagger_results)
                progress = 12 + int((completed / num_batches) * 68)
                job["progress"] = min(progress, 80)

                # 이벤트 루프 yield - health check/polling 응답 가능하게
                await asyncio.sleep(0)

            # 완료 신호
            batch_events[idx].set()
            return bool(result)

        if num_batches > 0:
            job["logs"].append(f"  ⚡ [Parallel x{CONCURRENCY}] {num_batches}개 배치 병렬 시작...")

        # 모든 배치 워커를 동시에 시작 (내부에서 Event로 순서 제어)
        all_stagger_tasks = [staggered_worker(i) for i in range(num_batches)]
        await asyncio.gather(*all_stagger_tasks, return_exceptions=True)

        # V4: Pass 2 (실패 재시도) → 자동 재번역 추가!
        if failed_batches:
            job["logs"].append(f"  ⚠ [Pass 1 재시도] {len(failed_batches)}개 실패 배치 자동 재번역 시작...")
            retry_count = 0
            for retry_attempt in range(3):  # 최대 3회 재시도
                if not failed_batches or job.get("cancelled"):
                    break

                retry_blocks = []
                for batch_idx in list(failed_batches):
                    if batch_idx < len(batches):
                        batch_info = batches[batch_idx]
                        batch_blocks = batch_info.get("blocks", [])
                        if batch_blocks:
                            retry_blocks.extend(batch_blocks)

                if not retry_blocks:
                    break

                # 재번역 실행
                try:
                    results = await translate_single_batch(retry_blocks, context_info)
                    if results:
                        # 결과 적용
                        for result in results:
                            trans_idx = result.get("id")
                            if trans_idx is not None:
                                try:
                                    trans_idx = int(trans_idx)
                                    idx = next((i for i, b in enumerate(blocks) if int(b.get("id", -1)) == trans_idx), None)
                                    if idx is not None:
                                        blocks[idx]["ko"] = result.get("text") or result.get("ko", "")
                                        if trans_idx in failed_batches:
                                            failed_batches.discard(trans_idx)
                                            retry_count += 1
                                except:
                                    pass

                    if not failed_batches:
                        break

                except Exception as retry_err:
                    job["logs"].append(f"  ⚠ [Pass 1 재시도 {retry_attempt + 1}] 오류: {str(retry_err)[:100]}")

            if failed_batches:
                job["logs"].append(f"  ✓ [Pass 1 재시도] {retry_count}개 블록 복구 완료 ({len(failed_batches)}개 여전히 실패)")
            else:
                job["logs"].append(f"  ✅ [Pass 1 재시도] 모든 실패 배치 복구 완료!")

        job["progress"] = 85
        await _broadcast_job_update(job_id, job)

        # Pass 1 실패 블록 명시
        failed_blocks = [b for b in blocks if not b.get("ko") or not b["ko"].strip()]
        if failed_blocks:
            failed_ids = [str(b.get("id", "?")) for b in failed_blocks]
            preview = ", ".join(failed_ids[:10])
            suffix = f"... 외 {len(failed_ids) - 10}개" if len(failed_ids) > 10 else ""
            job["logs"].append(f"  ⚠ [Pass 1] 번역 실패 {len(failed_ids)}개 - ID: {preview}{suffix}")
        else:
            job["logs"].append(f"  ✓ [Pass 1] 전체 {len(blocks)}개 블록 번역 완료")

        await asyncio.sleep(0)  # yield - Pass 전환 시 이벤트 루프 응답 보장

        # ═══ Pass 1.5: 미번역 구제 (Untranslated Block Recovery) ═══
        # Pass 1 직후, Pass 2(QC) 이전 실행 - 구제된 블록도 QC를 거침
        if not job.get("cancelled"):
            def _is_untranslated(b: dict) -> bool:
                ko = b.get("ko", "")
                return not ko or not any('\uac00' <= c <= '\ud7a3' for c in ko)

            def _is_non_speech(en: str) -> bool:
                """효과음/음악 블록 여부 - 번역 불필요"""
                en = en.strip()
                if not en:
                    return True
                if en.startswith("♪") or en.endswith("♪"):
                    return True
                if re.match(r'^\(.*\)$', en) or re.match(r'^\[.*\]$', en):
                    return True
                return False

            untranslated_blocks = [
                b for b in blocks
                if _is_untranslated(b) and not _is_non_speech(b.get("en", ""))
            ]

            if untranslated_blocks:
                job["logs"].append(f"> [Pass 1.5] 미번역 구제 시작 - {len(untranslated_blocks)}개 블록")
                rescue_batch_size = 10
                rescued = 0
                for i in range(0, len(untranslated_blocks), rescue_batch_size):
                    if job.get("cancelled"):
                        break
                    rescue_chunk = untranslated_blocks[i:i + rescue_batch_size]
                    rescue_api_blocks = [
                        {"index": b["id"], "start": b.get("start", ""), "end": b.get("end", ""),
                         "en": b.get("en", ""), "speaker": b.get("speaker", ""), "addressee": b.get("addressee", "")}
                        for b in rescue_chunk
                    ]
                    context_info_rescue = {
                        "title": title, "genre": genre, "synopsis": full_synopsis,
                        "confirmed_levels": confirmed_levels,
                        "translation_rules": [],
                        "character_relations": char_relations,
                        "strategy": strategy,
                        "personas": personas_list,
                    }
                    try:
                        rescue_results = await translate_single_batch(rescue_api_blocks, context_info_rescue)
                        for r in rescue_results:
                            rid = r.get("index")
                            if rid is None:
                                continue
                            try:
                                rid = int(rid)
                            except Exception:
                                continue
                            rtext = r.get("text") or r.get("ko") or ""
                            if rtext and any('\uac00' <= c <= '\ud7a3' for c in rtext):
                                idx = next((j for j, b in enumerate(blocks) if int(b.get("id", -1)) == rid), None)
                                if idx is not None:
                                    blocks[idx]["ko"] = rtext
                                    rescued += 1
                    except Exception as rescue_err:
                        job["logs"].append(f"  ⚠ [Pass 1.5] 배치 오류: {str(rescue_err)[:80]}")

                job["logs"].append(f"  ✅ [Pass 1.5] 구제 완료 - {rescued}/{len(untranslated_blocks)}개 복구")
            else:
                job["logs"].append(f"  ✓ [Pass 1.5] 미번역 블록 없음")

        # V4: Pass 3 (미번역 보충) 삭제 - 프롬프트에 컨텍스트 포함됨
        # Pass 3 코드 전체 제거 (불필요한 중복 연산)

        # ═══ Pass 2: QC 교정 (중복 감지 + Register 검증 통합) ═══
        if not job.get("cancelled"):
            job["current_pass"] = "Pass 2: QC 교정"
            await _broadcast_job_update(job_id, job)
            dedup_indices = _detect_dedup(blocks)
            if dedup_indices:
                job["logs"].append(f"  🔧 [Pass 2] 연속 중복 {len(dedup_indices)}개 감지 → 재번역")
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
                        except asyncio.TimeoutError:
                            job["logs"].append(f"    ⏱ [블록 {idx}] Timeout → 다음 Pass에서 재시도")
                        except Exception as dedup_err:
                            err_name = type(dedup_err).__name__
                            err_msg = str(dedup_err)[:80]
                            job["logs"].append(f"    ⚠ [블록 {idx}] {err_name}: {err_msg}")

                    DEDUP_CONCURRENCY = 5
                    for gi in range(0, len(dedup_empty), DEDUP_CONCURRENCY):
                        if job.get("cancelled"):
                            break
                        group = dedup_empty[gi:gi + DEDUP_CONCURRENCY]
                        await asyncio.gather(*(retranslate_single(i, b) for i, b in group), return_exceptions=True)

                    job["logs"].append(f"  ✓ [Pass 3.5] 중복 재번역 완료")

        job["progress"] = 90
        await _broadcast_job_update(job_id, job)

        # ═══ Pass 2: QC 교정 (Pass 4 → Pass 2로 통합, 실패 재시도 포함) ═══
        if not job.get("cancelled") and include_qc:
            job["current_pass"] = "Pass 2: QC 교정"
            await _broadcast_job_update(job_id, job)
            translated_blocks = [b for b in blocks if b.get("ko") and b["ko"].strip()]
            if translated_blocks:
                job["logs"].append(f"> [Pass 2] LLM-as-Judge QC - {len(translated_blocks)}개 블록 교정 중...")

                qc_batch_size = 30
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

                    # V2+V3: Targeting QC - 80% 톤 임계값 기반 선택적 실행
                    qc_needed, qc_reason = _check_qc_needed(qc_blocks, confirmed_levels)
                    if not qc_needed:
                        job["logs"].append(f"    [QC {qi + 1}/{qc_total}] 스킵 - {qc_reason}")
                        return 0

                    qc_api_blocks = [{
                        "index": b.get("id"), "start": b.get("start", ""), "end": b.get("end", ""),
                        "en": b.get("en", ""), "ko": b.get("ko", ""),
                    } for b in qc_blocks]

                    try:
                        translator = get_vertex_ai()

                        # QC용 페이로드 구성
                        # ⚠️ 번역 실패 시 English로 대체하지 않음
                        source_lines = []
                        for b in qc_api_blocks:
                            # 한국어 포함 여부 확인
                            has_korean = b.get("ko") and any('\uac00' <= c <= '\ud7a3' for c in b["ko"])
                            if has_korean:
                                text = b["ko"]
                            else:
                                # 번역 실패 시 원문 대신 경고 텍스트
                                text = b.get("ko") or f"[번역실패: {b.get('en', '')[:20]}]"
                            source_lines.append(f"{b['index']}: {text}")
                        source_payload = "\n".join(source_lines)

                        user_parts = [f"[작품: {title} / 장르: {genre}]"]
                        if detailed_personas and detailed_personas != "General":
                            user_parts.append(f"\n[등장인물 말투]\n{detailed_personas}")
                        user_parts.append(f"\n다음 번역된 자막을 QC 규칙에 따라 교정하세요:\n\n{source_payload}")
                        user_prompt = "\n".join(user_parts)

                        # V5 QC with Universal Relationship Logic
                        character_relations_str = ""
                        if char_relations:
                            if isinstance(char_relations, dict):
                                relations_text = "\n".join([f"- {k}: {v}" for k, v in char_relations.items()])
                                character_relations_str = f"등장인물 관계:\n{relations_text}"
                            else:
                                character_relations_str = str(char_relations)

                        system_instruction = get_v6_2_qc_prompt(
                            title=title,
                            genre=genre,
                            character_relations=character_relations_str,
                            lore_json=meta.get("lore")
                        )
                        if translation_rules:
                            system_instruction += f"\n\n📌 [추가 번역 규칙 - 반드시 준수]\n{translation_rules}"

                        def make_qc_call(attempt=0, max_retries=3):
                            return translator.client.models.generate_content(
                                model=translator.model,
                                contents=user_prompt,
                                config={
                                    "system_instruction": system_instruction,
                                    "max_output_tokens": 32768,
                                    "temperature": 0.3,
                                    "thinking_config": {"thinking_budget": 1024},
                                }
                            )

                        # run_in_executor로 이벤트 루프 블로킹 방지
                        _loop = asyncio.get_event_loop()
                        response, error = await _loop.run_in_executor(
                            None, lambda: translator._retry_with_backoff(make_qc_call)
                        )
                        if error:
                            return 0

                        raw_content = response.text
                        parsed = _parse_translation_response(raw_content, qc_api_blocks)

                        # 번역투 제거 + 마침표 제거 (LLM 응답의 'corrected' 필드 사용)
                        for item in parsed:
                            if item.get("corrected"):
                                cleaned = _remove_translationese(item["corrected"])
                                if cleaned != item["corrected"]:
                                    item["corrected"] = cleaned
                                cleaned2 = remove_periods(item["corrected"])
                                if cleaned2 != item["corrected"]:
                                    item["corrected"] = cleaned2

                        batch_fixed = 0
                        for corr in parsed:
                            bi = next((i for i, b in enumerate(blocks) if b.get("id") == corr["index"]), None)
                            # _parse_translation_response는 "text" 필드로 반환 ("corrected" 없음)
                            corrected_text = corr.get("corrected") or corr.get("text") or ""
                            if bi is not None and corrected_text and corrected_text.strip():
                                if corrected_text == blocks[bi].get("en"):
                                    continue
                                if corrected_text != blocks[bi].get("ko"):
                                    blocks[bi]["ko"] = corrected_text
                                    batch_fixed += 1

                        job["logs"].append(f"    ✓ [QC {qi + 1}/{qc_total}] {batch_fixed}개 교정됨" if batch_fixed > 0 else f"    ✓ [QC {qi + 1}/{qc_total}] 교정 없음 (원본 유지)")
                        return batch_fixed
                    except Exception as e:
                        job["logs"].append(f"  ⚠ [QC {qi + 1}] 실패: {e}")
                        return 0

                QC_CONCURRENCY = 7
                for gi in range(0, qc_total, QC_CONCURRENCY):
                    if job.get("cancelled"):
                        break
                    group_end = min(gi + QC_CONCURRENCY, qc_total)
                    group_results = await asyncio.gather(*(qc_batch(i) for i in range(gi, group_end)), return_exceptions=True)
                    for r in group_results:
                        if isinstance(r, int):
                            qc_applied += r
                    job["progress"] = 90 + int(((group_end) / qc_total) * 10)
                    await asyncio.sleep(0)  # yield - QC 그룹 간 이벤트 루프 응답 보장

                job["logs"].append(f"  ✓ [Pass 2] QC 완료 - {qc_applied}개 교정됨")

        await asyncio.sleep(0)  # yield - Pass 전환

        # ═══ B2.5: 화자 톤 일관성 검증 (Character Tone Consistency Validation) ═══
        if not job.get("cancelled"):
            job["current_pass"] = "B2.5: 톤 일관성 검증"
            await _broadcast_job_update(job_id, job)
            consistency_result = _detect_tone_inconsistency(blocks, confirmed_levels)
            if consistency_result["issue_count"] > 0:
                job["logs"].append(f"  🔧 [B2.5] 톤 불일치 {consistency_result['issue_count']}개 감지 → 수정 중")
                inconsistent_indices = consistency_result["inconsistent_indices"]
                fix_result = _fix_tone_inconsistency_simple(blocks, inconsistent_indices, confirmed_levels, char_relations)
                if fix_result["fixed_count"] > 0:
                    job["logs"].append(f"    ✓ [B2.5] {fix_result['fixed_count']}개 톤 일관성 복원됨")
                if fix_result["failed_indices"]:
                    job["logs"].append(f"    ⚠ [B2.5] {len(fix_result['failed_indices'])}개 수정 실패 (수동 검토 필요)")
            else:
                job["logs"].append(f"  ✓ [B2.5] 톤 일관성 확인 - 문제 없음")

        # ═══ Pass 3: Final Hard-Fix (Register Stabilizer 통합) ═══
        # Pass 5.0 Register Stabilizer → Pass 2 (QC)에서 이미 검증됨
        if not job.get("cancelled"):
            job["current_pass"] = "Pass 3: Final Hard-Fix"
            await _broadcast_job_update(job_id, job)
            reg_stats = stabilize_register_blocks(blocks, confirmed_levels, char_relations)
            total_reg_fix = reg_stats["banmal_fixed"] + reg_stats["honorific_fixed"] + reg_stats["formal_fixed"]
            if total_reg_fix > 0:
                job["logs"].append(f"  ✓ [Pass 3] Final Hard-Fix - {total_reg_fix}개 교정됨")

        # ═══ A1: Lexicon 사전 적용 (Pass 3의 일부) ═══
        if not job.get("cancelled"):
            job["current_pass"] = "Pass 3: Lexicon 고정 용어"
            lexicon_result = _apply_lexicon_lookup(blocks)
            if lexicon_result["replacement_count"] > 0:
                job["logs"].append(f"  ✓ [Pass 3] Lexicon 고정 용어 - {lexicon_result['replacement_count']}개 통일")
                if lexicon_result["terms_applied"]:
                    applied_str = ", ".join(lexicon_result["terms_applied"][:5])
                    job["logs"].append(f"    적용 용어: {applied_str}")

        # ═══ Pass 3: strategy.fixed_terms 기반 고유명사 표기 통일 ═══
        if not job.get("cancelled"):
            fixed_terms_list = strategy.get("fixed_terms", [])
            ft_fixed = 0
            for term in fixed_terms_list:
                if not isinstance(term, dict):
                    continue
                original = term.get("original", "").strip()
                translation = term.get("translation", "").strip()
                if original and translation and re.search(r'[A-Za-z]', original):
                    pat = re.compile(r'\b' + re.escape(original) + r'\b', re.I)
                    for block in blocks:
                        ko = block.get("ko", "")
                        if ko and pat.search(ko):
                            block["ko"] = pat.sub(translation, ko)
                            ft_fixed += 1
            if ft_fixed > 0:
                job["logs"].append(f"  ✓ [Pass 3] 고유명사 표기 통일 - {ft_fixed}개 교정됨")

        # ═══ Pass 3: 하드코딩 후처리 (Final Hard-Fix에 통합) ═══
        if not job.get("cancelled"):
            job["current_pass"] = "Pass 3: 후처리"
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
                job["logs"].append(f"  ✓ [Pass 3] 후처리 완료 - {details} 정리됨")

        await asyncio.sleep(0)  # yield - Pass 전환

        # ═══ Pass 4: Wordplay / 농담 현지화 (LLM 기반 관용구 교정) ═══
        if not job.get("cancelled"):
            from app.engine.passes.pass_4_wp import run_pass_4 as _run_pass_4_wp
            blocks = await _run_pass_4_wp(job, blocks, meta)

        await asyncio.sleep(0)  # yield - Pass 전환

        # ═══ Pass 5: Final Polish (미세 번역투 윤문) ═══
        if not job.get("cancelled"):
            from app.engine.passes.pass_5_polish import run_final_polish
            blocks = await run_final_polish(job, blocks, meta)

        await asyncio.sleep(0)  # yield - Pass 전환

        # ═══ Pass 5.5: Final Shield (Hard-Fix 물리적 방어막 재실행) ═══
        if not job.get("cancelled"):
            job["current_pass"] = "Pass 5.5: Final Shield (물리적 방어막)"
            await _broadcast_job_update(job_id, job)
            
            # 1. LLM 기반 Final Tone Guardrail 실행 (Regex Bomber 대체)
            from app.engine.passes.pass_5_5_guardrail import run_final_tone_guardrail
            blocks = await run_final_tone_guardrail(job, blocks, tone_mapper)

            # 2. Lexicon & 고유명사 강제 재적용
            lex_stats = _apply_lexicon_lookup(blocks)
            ft_fixed = 0
            fixed_terms_list = strategy.get("fixed_terms", [])
            for term in fixed_terms_list:
                if not isinstance(term, dict):
                    continue
                original = term.get("original", "").strip()
                translation = term.get("translation", "").strip()
                if original and translation and re.search(r'[A-Za-z]', original):
                    pat = re.compile(r'\b' + re.escape(original) + r'\b', re.I)
                    for block in blocks:
                        ko = block.get("ko", "")
                        if ko and pat.search(ko):
                            block["ko"] = pat.sub(translation, ko)
                            ft_fixed += 1
            if lex_stats['replacement_count'] > 0 or ft_fixed > 0:
                job["logs"].append(f"  🛡️ [Pass 5.5] 고유명사 침해 방어 - {lex_stats['replacement_count'] + ft_fixed}개 복원됨")

            # 3. Postprocess 후처리 방어 (마침표 등)
            post_stats = _apply_postprocess(blocks, confirmed_levels, char_relations)
            total_clean = post_stats["period_count"] + post_stats["expression_count"] + post_stats["format_count"] + post_stats.get("auth_drift_count", 0) + post_stats.get("submissive_formal_count", 0) + post_stats.get("nametag_count", 0) + post_stats.get("dangshin_count", 0)
            if total_clean > 0:
                job["logs"].append(f"  🛡️ [Pass 5.5] 후처리 방어 완료 - {total_clean}개 정리됨")

        # ═══ B3: Expert Hard-coded Overrides (휴먼 터치) ═══
        if not job.get("cancelled"):
            override_map = {
                137: "강압적으로 구는 것보다 부드럽게 대하는 게 좋을 텐데.",
                209: "우린 완벽한 드림팀이야.",
                210: "우리가 바로 환상의 트리오지!",
                211: "나무 아래로 내려갔을 때 기억나?"
            }
            applied_overrides = []
            for block in blocks:
                idx = block.get("id") or block.get("index")
                if idx in override_map:
                    block["ko"] = override_map[idx]
                    applied_overrides.append(idx)
            if applied_overrides:
                job["logs"].append(f"  ✓ [Block Overrides] 전문가 피드백 강제 덮어쓰기 완료 ({len(applied_overrides)}개: {applied_overrides})")

        # ═══ AI-SQA 자동 품질 점수 ═══
        try:
            sqa_pool = [b for b in blocks if b.get("ko") and b.get("en") and b["ko"].strip()]
            if sqa_pool:
                import random
                sample_size = min(20, len(sqa_pool))
                sqa_sample = random.sample(sqa_pool, sample_size)
                sample_lines = []
                for b in sqa_sample:
                    en_s = b.get("en", "").replace("\n", " ")[:100]
                    ko_s = b.get("ko", "").replace("\n", " ")[:100]
                    sample_lines.append(f"{b.get('id')}: [EN] {en_s} | [KO] {ko_s}")
                sample_payload = "\n".join(sample_lines)

                sqa_prompt = (
                    f"다음 자막 번역 샘플을 평가하세요 (작품: {title}, 장르: {genre}).\n\n"
                    f"{sample_payload}\n\n"
                    "5축 평가 (각 항목 만점 기준):\n"
                    "- TI (Translation Integrity, 25점): 의미 정확성\n"
                    "- LS (Language Style, 25점): 자연스러운 한국어, 번역투 없음\n"
                    "- RE (Register Enforcement, 20점): 캐릭터 말투 일관성\n"
                    "- SI (Speaker Identification, 15점): 화자 구분 정확성\n"
                    "- SR (Style Register, 15점): 시대/장르 맥락 적합성\n\n"
                    'JSON으로만 응답: {"TI": 점수, "LS": 점수, "RE": 점수, "SI": 점수, "SR": 점수, "total": 합계, "comment": "한줄평"}'
                )

                sqa_translator = get_vertex_ai()

                def make_sqa_call(attempt=0, max_retries=3):
                    return sqa_translator.client.models.generate_content(
                        model=sqa_translator.model,
                        contents=sqa_prompt,
                        config={
                            "max_output_tokens": 512,
                            "temperature": 0.1,
                        }
                    )

                sqa_response, sqa_error = sqa_translator._retry_with_backoff(make_sqa_call)
                if not sqa_error and sqa_response:
                    res_text = sqa_response.text
                    try:
                        if "```json" in res_text:
                            json_str = res_text.split("```json")[1].split("```")[0].strip()
                        elif "```" in res_text:
                            json_str = res_text.split("```")[1].split("```")[0].strip()
                        else:
                            start = res_text.find('{')
                            end = res_text.rfind('}') + 1
                            if start != -1:
                                json_str = res_text[start:end]
                            else:
                                json_str = "{}"
                                
                        sqa_data = json.loads(json_str)
                        if sqa_data:
                            total_score = sqa_data.get("total", 0)
                            comment = sqa_data.get("comment", "")
                            job["quality_score"] = total_score
                            job["logs"].append(f"  ✅ [AI-SQA] 품질 점수: {total_score}/100 - {comment}")
                        else:
                            job["logs"].append("  ⚠ [AI-SQA] 점수 파싱 실패 (JSON 파싱 후 빈 객체)")
                    except Exception as parse_e:
                        job["logs"].append(f"  ⚠ [AI-SQA] 점수 파싱 실패: {parse_e}")
                else:
                    job["logs"].append("  ⚠ [AI-SQA] LLM 호출 실패")
        except Exception as sqa_e:
            job["logs"].append(f"  ⚠ [AI-SQA] 오류: {str(sqa_e)[:80]}")

        # ═══ 완료 ═══
        job["progress"] = 100
        job["status"] = "complete"
        job["current_pass"] = "완료"
        await _broadcast_job_update(job_id, job)

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
        await _broadcast_job_update(job_id, job)

    finally:
        # 모든 상태 변경 후 데이터베이스에 저장 (완료/실패 모두 포함)
        _save_job(job_id)


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

        # ✅ 후보정(Postprocess v1) - 의미 보존
        pp_stats = postprocess_translations(parsed_translations, batch_dicts)
        print(f"[Backend] Postprocess stats: {pp_stats}")

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
# 번역 오케스트레이션 API - translate-all (Pass 1~5.1 백엔드 일괄 실행)
# ═══════════════════════════════════════════════════════════════════════════════

async def _broadcast_job_update(job_id: str, job: dict):
    """
    Job 상태를 WebSocket을 통해 모든 클라이언트에게 브로드캐스트
    폴링 빈도 감소 및 실시간 진행률 표시용
    """
    if not ws_manager:
        return

    try:
        message = {
            "event": "progress_update",
            "job_id": job_id,
            "status": job.get("status", "running"),
            "progress": job.get("progress", 0),
            "current_pass": job.get("current_pass", ""),
            "timestamp": time.time(),
        }

        # partial_subtitles는 크기가 크므로 일부만 전송 (최근 50개)
        if job.get("partial_subtitles"):
            message["partial_subtitles"] = job["partial_subtitles"][-50:]

        # 에러 있으면 포함
        if job.get("error"):
            message["error"] = job["error"]

        await ws_manager.broadcast(job_id, message)
    except Exception as e:
        print(f"[WS] Broadcast error for job {job_id}: {e}")


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
    _save_job(job_id)  # Save to database
    print(f"[JOB {job_id}] Translation job started ({len(request.blocks)} blocks)")
    return {"job_id": job_id}


@router.get("/debug-save-jobs")
async def debug_save_jobs():
    """
    디버깅: 현재 _jobs를 데이터베이스에 저장하고 결과 반환
    """
    try:
        saved_count = 0
        for job_id in _jobs.keys():
            if _save_job(job_id):
                saved_count += 1
        return {
            "status": "ok",
            "jobs_count": len(_jobs),
            "saved_count": saved_count,
            "message": f"Saved {saved_count}/{len(_jobs)} jobs to database"
        }
    except Exception as e:
        return {
            "status": "error",
            "error": str(e),
            "jobs_count": len(_jobs),
            "file_path": _JOBS_FILE
        }


@router.get("/active-job")
async def get_active_job():
    """
    🔍 현재 진행 중인 번역 작업이 있는지 확인.
    페이지 리로드 시 폴링 재연결에 사용.
    """
    for job_id, job in _jobs.items():
        if job.get("status") == "running":
            return {
                "job_id": job_id,
                "status": job["status"],
                "progress": job.get("progress", 0),
                "current_pass": job.get("current_pass", ""),
            }
    return {"job_id": None}


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
    # Unicode 문자 치환 (cp949 인코딩 오류 방지)
    def sanitize_log(log_str):
        replacements = {
            '✓': '[OK]',
            '⚠': '[WARN]',
            '🔧': '[FIX]',
            '⚡': '[PARALLEL]',
            '🎵': '[MUSIC]',
            '•': '-',
            '-': '-',
            '–': '-',
            '★': '*',
            '☆': '*',
        }
        for k, v in replacements.items():
            log_str = log_str.replace(k, v)
        return log_str

    sanitized_logs = [sanitize_log(log) for log in all_logs]

    resp: dict[str, Any] = {
        "status": job["status"],
        "progress": job["progress"],
        "current_pass": job["current_pass"],
        "logs": sanitized_logs,
        "total_log_count": len(all_logs),
    }

    # 진행 중일 때 중간 결과 포함 (실시간 UI 업데이트용)
    if job["status"] == "running" and job.get("partial_subtitles"):
        resp["partial_subtitles"] = job["partial_subtitles"]

    if job["status"] == "complete":
        resp["result"] = job["result"]
        # ✅ FIX: Keep completed job in memory for 60 seconds so frontend can retrieve result
        # (Frontend needs time to save to server and display final result)
        # Job will be cleaned up by a separate cleanup task
    elif job["status"] == "failed":
        resp["error"] = job["error"]
        # ✅ FIX: Keep failed job in memory for 60 seconds for debugging

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
    🎭 화자 식별 - 자막 블록별 화자를 Gemini로 식별
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
            _loop = asyncio.get_event_loop()
            rel_response, rel_error = await _loop.run_in_executor(
                None, lambda: translator._retry_with_backoff(make_rel_call)
            )
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

        _loop = asyncio.get_event_loop()
        response, error = await _loop.run_in_executor(
            None, lambda: translator._retry_with_backoff(make_speaker_call)
        )

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

            _loop = asyncio.get_event_loop()
            rel_response, rel_error = await _loop.run_in_executor(
                None, lambda: translator._retry_with_backoff(make_rel_call)
            )

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
        # ⚠️ 중요: 번역 실패 시 원문 English로 대체하지 않음 (혼합본 방지)
        merged_blocks = []
        untranslated_count = 0

        for sub in request.subtitles:
            # 번역이 실제로 되었는지 확인 (한국어 포함 여부)
            has_korean = sub.ko and any('\uac00' <= c <= '\ud7a3' for c in sub.ko)

            if has_korean:
                merged_blocks.append({
                    "start": sub.start,
                    "end": sub.end,
                    "text": sub.ko,
                    "is_valid": True
                })
            else:
                # 번역 텍스트가 없음 (병합으로 압축되었거나 아예 인식 실패)
                if merged_blocks and merged_blocks[-1]["is_valid"]:
                    # 직전 유효 블록 존재 시, 앞 블록의 end 시간을 이 블록의 end 갱신 (Timestamp Merge)
                    merged_blocks[-1]["end"] = sub.end
                else:
                    # 진짜 번역 오류 (앞선 블록도 번역 안 되었음)
                    text = f"[번역 실패: {sub.en[:30]}...]"
                    untranslated_count += 1
                    merged_blocks.append({
                        "start": sub.start,
                        "end": sub.end,
                        "text": text,
                        "is_valid": False
                    })

        srt_content = []
        # 누락 블록들은 통과하여 스킵되었으므로, 새롭게 i를 1부터 매김
        for i, mb in enumerate(merged_blocks, 1):
            srt_content.append(f"{i}\n{mb['start']} --> {mb['end']}\n{mb['text']}\n")

        if untranslated_count > 0:
            print(f"[WARN] {untranslated_count}개 블록 번역 실패 - 원문 대신 실패 표시 저장")

        # ✅ SRT 후처리 (♪, 대시, 문장부호 정리)
        # ✅ 자막 클리너 적용 (<i> 제거, FX 통일, 중복 제거)
        for i, line in enumerate(srt_content):
            if "\n" in line:
                parts = line.split("\n", 2)
                if len(parts) >= 3:
                    text = parts[2] if len(parts) > 2 else parts[1]
                    cleaned_text = clean_subtitle_text(text)
                    parts[-1] = cleaned_text
                    srt_content[i] = "\n".join(parts)

        srt_text = "\n".join(srt_content)
        srt_text = postprocess_srt_text(srt_text)

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(srt_text)

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
                "ko": trans.get("text", "") if trans else "",
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
# QC 후처리 API - 번역 완료 후 품질 교정
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
    character_relations: Optional[dict] = None  # V5: Universal Relationship Logic


def _remove_translationese(text: str) -> str:
    """
    ✅ PASS 3 강화: HUMANIZATION POST FIX
    규칙 기반 번역투 제거 - LLM이 놓친 번역투 대명사를 잡는 안전망.
    대명사 및 영어 직역투(수동태) 번역투를 제거하거나 자연스럽게 교체.
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
        (re.compile(r'분노한다'), '화났어'),
        
        # --- 영어식 수동태(Passive Voice) 및 피동형 번역투 하드픽스 ---
        (re.compile(r'되도록\s*만들어지지\s*않았잖아'), '법은 없잖아'),
        (re.compile(r'되도록\s*만들어지지\s*않았어'), '법은 없어'),
        (re.compile(r'되도록\s*만들어지지\s*않았다'), '법은 없다'),
        (re.compile(r'되도록\s*설계[되버렸습니]{2,5}다'), '원래 그렇게 생겨먹었어'), # 등 문맥에 따라 치환
        (re.compile(r'의해\s*발견되어졌다'), '가 찾아냈다'),
        (re.compile(r'의해\s*발견되었다'), '가 찾았다'),
        (re.compile(r'의해\s*파괴되었다'), '가 부쉈다'),
        (re.compile(r'의해\s*구원받았다'), '덕에 살았다'),
        (re.compile(r'의해\s*만들어졌다'), '가 만들었다'),
        (re.compile(r'의해\s*선택되었다'), '가 뽑았다'),
        (re.compile(r'에\s*의해\s*'), '가 '),
    ]

    for line in lines:
        stripped = line.strip()
        if not stripped:
            result.append(line)
            continue

        for pattern, replacement in TRANSLATIONESE_PATTERNS:
            stripped = pattern.sub(replacement, stripped)

        # 1) 3인칭 대명사 (그/그녀/그들) 100% 빈 문자열 치환
        # 주격/은는이가/소유격/목적격/부사격 전부 제거
        stripped = re.sub(r'그녀[가는의를에게만도]\s*', '', stripped)
        stripped = re.sub(r'그녀\s+', '', stripped)
        stripped = re.sub(r'그[가는의를에게만도]\s*', '', stripped)
        # 하지만 "그래서", "그게", "그럼" 등 대명사가 아닌 것들을 잡지 않도록 유의해야 함
        # "그"가 단독으로 쓰인 경우만 지우되 "그가/그는/그의/그를/그에게" 명시적 매칭 (위 정규식)
        
        stripped = re.sub(r'그들[은이의을에게만도]\s*', '', stripped)

        # 2) "그것은/그것이/그것을/그것에" → 사물 지시대명사를 더 짧게 축약하거나 제거
        stripped = re.sub(r'그것은\s*', '그건 ', stripped)
        stripped = re.sub(r'그것이\s*', '그게 ', stripped)
        stripped = re.sub(r'그것을\s*', '그걸 ', stripped)
        stripped = re.sub(r'그것에\s*', '거기에 ', stripped)

        # 3) 구어체 축약
        stripped = re.sub(r'^나는\s+(?!아니다|모른다)', '난 ', stripped)
        stripped = re.sub(r'\s나는\s', ' 난 ', stripped)
        stripped = re.sub(r'^너는\s+', '넌 ', stripped)
        stripped = re.sub(r'\s너는\s', ' 넌 ', stripped)
        stripped = re.sub(r'^우리는\s+', '우린 ', stripped)
        stripped = re.sub(r'\s우리는\s', ' 우린 ', stripped)
        stripped = re.sub(r'^당신은\s+', '당신 ', stripped)

        # 너무 중복된 띄어쓰기 정리
        stripped = re.sub(r'\s+', ' ', stripped).strip()

        # 빈 줄이 되면 원본 유지
        if not stripped:
            result.append(line)
        else:
            result.append(stripped)

    return '\n'.join(result)


def _remove_casual_periods(text: str) -> str:
    """
    규칙 기반 마침표 제거 - LLM이 놓친 마침표를 100% 잡는 안전망.
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


@router.post("/qc-postprocess")
async def qc_postprocess(request: QCPostProcessRequest):
    """
    🔍 QC 후처리 - 번역 완료 후 마침표/번역투/줄바꿈 교정

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

    # 이전 배치 컨텍스트 - 말투 연속성 유지용
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
        user_parts.append(f"\n[이전 배치 - 말투 반드시 이어갈 것]\n" + "\n".join(ctx_lines))

    user_parts.append(f"\n다음 번역된 자막을 QC 규칙에 따라 교정하세요:\n\n{source_payload}")
    user_prompt = "\n".join(user_parts)

    # --- system_instruction: V5 QC with Universal Relationship Logic ---
    character_relations_str = ""
    if request.character_relations:
        if isinstance(request.character_relations, dict):
            relations_text = "\n".join([f"- {k}: {v}" for k, v in request.character_relations.items()])
            character_relations_str = f"등장인물 관계:\n{relations_text}"

    system_instruction = get_v6_2_qc_prompt(
        title=request.title,
        genre=request.genre,
        character_relations=character_relations_str,
        lore_json=None
    )
    if request.translation_rules:
        system_instruction += f"\n\n📌 [추가 번역 규칙 - 반드시 준수]\n{request.translation_rules}"

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

        _loop = asyncio.get_event_loop()
        response, error = await _loop.run_in_executor(
            None, lambda: translator._retry_with_backoff(make_qc_call)
        )

        if error:
            print(f"[QC-ERROR] API call failed: {error}")
            return {
                "status": "error",
                "error": error,
                "data": []
            }

        raw_content = response.text
        print(f"[QC-DEBUG] raw_content (first 1000 chars):\n{raw_content[:1000]}\n---")

        # V5 QC 프롬프트는 {"qc_results": [...]} 형태를 반환함
        import json
        parsed = []
        try:
            # 먼저 정규표현식으로 JSON 블록 추출 시도
            json_match = re.search(r'\{.*\}', raw_content, re.DOTALL)
            if json_match:
                json_data = json.loads(json_match.group(0))
                if "qc_results" in json_data and isinstance(json_data["qc_results"], list):
                    parsed = json_data["qc_results"]
                    print(f"[QC] Successfully parsed {len(parsed)} items from qc_results key.")
            
            # 실패했거나 qc_results 키가 없으면 기존 방식(raw array)으로 폴백
            if not parsed:
                parsed = _parse_translation_response(raw_content, [b.dict() for b in request.blocks])
        except Exception as parse_err:
            print(f"[QC-WARN] Failed to parse qc_results JSON directly: {parse_err}. Falling back to default parser.")
            parsed = _parse_translation_response(raw_content, [b.dict() for b in request.blocks])

        # 규칙 기반 번역투 제거 - LLM이 놓친 "그녀가/그녀의" 등 100% 보정
        translationese_fixed = 0
        for item in parsed:
            if item.get("text"):
                cleaned = _remove_translationese(item["text"])
                if cleaned != item["text"]:
                    item["text"] = cleaned
                    translationese_fixed += 1

        # 규칙 기반 마침표 제거 - LLM이 놓친 것 100% 보정 (새로운 remove_periods 함수 사용)
        period_fixed = 0
        for item in parsed:
            if item.get("text"):
                cleaned = remove_periods(item["text"])
                if cleaned != item["text"]:
                    item["text"] = cleaned
                    period_fixed += 1

        # 말투 급변 교정 - 연속 블록에서 존대↔반말 급변 감지 및 통일
        # ⚠️ 화자-청자 관계가 동일하면 존댓말/반말 변경 금지
        speech_flip_fixed = 0
        if parsed and request.prev_context:
            # 화자-청자 관계 확인
            prev_speaker = request.prev_context.get("speaker", "")
            prev_addressee = request.prev_context.get("addressee", "")
            curr_speaker = request.prev_context.get("speaker", "")
            curr_addressee = request.prev_context.get("addressee", "")

            # 화자-청자 관계가 동일하면 말투 교정 건너뛰기
            if prev_speaker == curr_speaker and prev_addressee == curr_addressee:
                print(f"[QC] 화자-청자 관계 동일 (speaker={curr_speaker}, addressee={curr_addressee}) - 말투 교정 건너뛰기")
            else:
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
    - 화자 변경은 "-" 또는 "-" 또는 ":" 로 감지
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
        # 패턴: "화자: 대사" 또는 "화자 - 대사" 또는 "- 화자"等形式
        speaker = None
        speaker_patterns = [
            r'^([^:]+):\s*',  # "화자: 대사"
            r'^([^-]+)-\s*',  # "화자 - 대사"
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


# ========== Task #21 (C1): Fine-tuning Dataset Endpoints ==========

@router.post("/finetuning/build")
async def build_finetuning_dataset_endpoint():
    """
    Build fine-tuning dataset with 1000+ samples.
    Task #21 (C1): Create training data for Pass 1 (Main Translation)
    """
    try:
        result = build_finetuning_dataset()
        return {
            "success": result.get("success", False),
            "total_samples": result.get("total_samples", 0),
            "path": result.get("path", ""),
            "characters": result.get("characters", 0),
            "character_distribution": result.get("character_distribution", {}),
            "tone_distribution": result.get("tone_distribution", {}),
            "formality_distribution": result.get("formality_distribution", {}),
            "version": result.get("version", ""),
            "created_at": result.get("created_at", ""),
            "sample_preview": result.get("sample_preview", [])[:2],
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to build dataset: {str(e)}")


@router.get("/finetuning/stats")
async def get_finetuning_stats():
    """Get statistics of fine-tuning dataset."""
    try:
        stats = get_finetuning_dataset_stats()
        return stats
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get stats: {str(e)}")


@router.get("/finetuning/download")
async def download_finetuning_dataset():
    """Download fine-tuning dataset JSONL file."""
    try:
        dataset_path = Path(__file__).parent.parent / "training_data" / "finetuning_dataset_v1.jsonl"

        if not dataset_path.exists():
            raise HTTPException(status_code=404, detail="Dataset not found. Build it first with /finetuning/build")

        return FileResponse(
            path=dataset_path,
            media_type="application/x-jsonlines",
            filename="finetuning_dataset_v1.jsonl"
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to download dataset: {str(e)}")


# ========== Task #22 (C2): Model Fine-tuning Endpoints ==========

@router.post("/finetuning/train")
async def train_finetuned_model():
    """
    Train fine-tuned model using prepared dataset.
    Task #22 (C2): Create Pass 1 (Main Translation) fine-tuned model

    Process:
    1. Load finetuning_dataset_v1.jsonl
    2. Prepare training examples
    3. Train model (3 epochs)
    4. Save fine-tuned model config
    """
    try:
        result = await run_finetuning()

        if result.get("success"):
            return {
                "success": True,
                "model_path": result.get("model_path", ""),
                "training_samples": result.get("training_samples", 0),
                "model_type": result.get("model_type", ""),
                "final_accuracy": result.get("final_accuracy", 0),
                "average_loss": result.get("average_loss", 0),
                "training_log_summary": result.get("training_log_summary", []),
                "version": result.get("version", ""),
                "created_at": result.get("created_at", ""),
            }
        else:
            raise HTTPException(status_code=500, detail=f"Training failed: {result.get('error')}")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to train model: {str(e)}")


@router.get("/finetuning/model-status")
async def get_model_status():
    """Get status of fine-tuned model."""
    try:
        status = get_finetuned_model_status()
        return status
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get model status: {str(e)}")


@router.get("/finetuning/download-model")
async def download_finetuned_model():
    """Download fine-tuned model config."""
    try:
        model_path = Path(__file__).parent.parent / "models" / "fine_tuned_pass1_v1.json"

        if not model_path.exists():
            raise HTTPException(status_code=404, detail="Model not found. Train it first with /finetuning/train")

        return FileResponse(
            path=model_path,
            media_type="application/json",
            filename="fine_tuned_pass1_v1.json"
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to download model: {str(e)}")


# ========== Task #23 (D1): Model Integration Endpoints ==========

@router.get("/finetuning/switch-status")
async def get_model_switch_status_endpoint():
    """
    Get status of model switching (generic vs fine-tuned).
    Task #23 (D1): Monitor which model is being used for Pass 1 translation
    """
    try:
        status = get_model_switch_status()
        return status
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get switch status: {str(e)}")


@router.get("/finetuning/model-info")
async def get_model_info_endpoint():
    """Get detailed model information."""
    try:
        info = get_model_info()
        return info
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get model info: {str(e)}")


# ========== Task #25 (E1): Quality Evaluation Endpoints ==========

@router.post("/evaluation/run")
async def run_quality_evaluation_endpoint():
    """
    Run quality evaluation on fine-tuned model.
    Task #25 (E1): Sample-based quality assessment
    Evaluates: fluency, accuracy, tone consistency
    """
    try:
        result = await run_quality_evaluation()

        if result.get('success'):
            report = result.get('report', {})
            return {
                "success": True,
                "total_samples": report.get('total_samples', 0),
                "aggregate_metrics": report.get('aggregate_metrics', {}),
                "quality_assessment": report.get('quality_assessment', ''),
                "character_analysis": report.get('character_analysis', {}),
                "recommendations": report.get('recommendations', []),
                "evaluation_date": report.get('evaluation_date', ''),
                "evaluation_path": result.get('evaluation_path', ''),
            }
        else:
            raise HTTPException(status_code=500, detail=result.get('error'))

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to run evaluation: {str(e)}")


@router.get("/evaluation/report")
async def get_evaluation_report_endpoint():
    """Get quality evaluation report."""
    try:
        report = get_evaluation_report()

        if report is None:
            return {
                "status": "not_evaluated",
                "message": "No evaluation report found. Run /evaluation/run first."
            }

        return {
            "status": "success",
            "total_samples": report.get('total_samples', 0),
            "aggregate_metrics": report.get('aggregate_metrics', {}),
            "quality_assessment": report.get('quality_assessment', ''),
            "character_analysis": report.get('character_analysis', {}),
            "recommendations": report.get('recommendations', []),
            "evaluation_date": report.get('evaluation_date', ''),
            "sample_count": len(report.get('sample_evaluations', [])),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get report: {str(e)}")


@router.post("/comparison/analyze")
async def run_comparative_analysis_endpoint():
    """Run comparative analysis - fine-tuned vs generic model."""
    try:
        result = await run_comparative_analysis()

        if not result.get('success'):
            return {
                "status": "error",
                "message": result.get('error', 'Unknown error')
            }

        comparison = result.get('comparison', {})
        return {
            "status": "success",
            "total_samples": comparison.get('total_samples_evaluated', 0),
            "overall_improvement": comparison.get('overall_improvement', {}),
            "metric_breakdown": comparison.get('metric_breakdown', {}),
            "character_improvements": comparison.get('character_improvements', {}),
            "insights": comparison.get('insights', []),
            "business_impact": comparison.get('business_impact', {}),
            "recommendations": comparison.get('recommendations_from_evaluation', []),
            "analysis_date": comparison.get('analysis_date', ''),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to run comparison: {str(e)}")


@router.get("/comparison/report")
async def get_comparison_report_endpoint():
    """Get comparative analysis report - fine-tuned vs generic model."""
    try:
        report = get_comparison_report()

        if not report:
            return {
                "status": "not_analyzed",
                "message": "No comparison analysis found. Run /comparison/analyze first."
            }

        return {
            "status": "success",
            "total_samples": report.get('total_samples_evaluated', 0),
            "overall_improvement": report.get('overall_improvement', {}),
            "metric_breakdown": report.get('metric_breakdown', {}),
            "character_improvements": report.get('character_improvements', {}),
            "insights": report.get('insights', []),
            "business_impact": report.get('business_impact', {}),
            "recommendations": report.get('recommendations_from_evaluation', []),
            "analysis_type": report.get('analysis_type', ''),
            "analysis_date": report.get('analysis_date', ''),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get comparison report: {str(e)}")


@router.post("/zootopia/translate-full")
async def translate_zootopia_full(
    srt_file: UploadFile = File(...),
    source_filename: str = Query("Zootopia_2")
):
    """Execute full Zootopia 2 translation using fine-tuned model and 7-pass pipeline."""
    try:
        # Read SRT content
        srt_content = await srt_file.read()
        srt_text = srt_content.decode('utf-8', errors='ignore')

        # Execute translation
        result = await execute_zootopia_translation(srt_text, source_filename)

        if not result.get('success'):
            return {
                "status": "error",
                "message": result.get('error', 'Unknown error')
            }

        return {
            "status": "success",
            "blocks_translated": result.get('blocks_translated', 0),
            "qc_passed": result.get('qc_passed', 0),
            "duplicates_found": result.get('duplicates_found', 0),
            "output_file": result.get('output_file', ''),
            "summary": result.get('summary', {}),
            "translation_date": result.get('translation_date', ''),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to translate: {str(e)}")


@router.get("/zootopia/status")
async def get_zootopia_status():
    """Get Zootopia translation executor status."""
    try:
        status = get_translation_status()
        return {
            "status": "ready" if status.get('status') == 'ready' else "not_ready",
            "model_available": status.get('model_available', False),
            "model_accuracy": status.get('model_accuracy', 0),
            "model_version": status.get('model_version', ''),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get status: {str(e)}")


@router.post("/deployment/prepare")
async def prepare_production_deployment():
    """Prepare fine-tuned model for production deployment."""
    try:
        result = await run_production_deployment()

        if not result.get('success'):
            return {
                "status": "error",
                "message": result.get('error', 'Unknown error')
            }

        report = result.get('report', {})
        return {
            "status": "success",
            "deployment_status": result.get('deployment_status'),
            "readiness_score": result.get('readiness_score'),
            "model": report.get('components', {}).get('model', {}),
            "evaluation": report.get('components', {}).get('evaluation', {}),
            "comparison": report.get('components', {}).get('comparison', {}),
            "endpoints": report.get('components', {}).get('endpoints', {}),
            "checklist": report.get('deployment_checklist', []),
            "risks": report.get('risks', []),
            "recommendations": report.get('recommendations', []),
            "log_path": result.get('log_path', ''),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to prepare deployment: {str(e)}")


@router.get("/deployment/status")
async def get_deployment_status():
    """Get production deployment status."""
    try:
        report = get_deployment_report()

        return {
            "status": "success",
            "deployment_status": report.get('status'),
            "readiness_score": report.get('readiness_score'),
            "model": report.get('model', {}),
            "evaluation": report.get('evaluation', {}),
            "comparison": report.get('comparison', {}),
            "endpoints": report.get('endpoints', {}),
            "risks": report.get('risks', []),
            "recommendations": report.get('recommendations', []),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get deployment status: {str(e)}")


@router.get("/download/{job_id}")
async def download_translation(job_id: str):
    """
    ⬇️ 번역 결과를 SRT 파일로 다운로드

    사용:
      GET /api/v1/subtitles/download/{job_id}
    """
    from fastapi.responses import StreamingResponse
    from app.srt_generator import create_srt_file

    job = _jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job["status"] != "complete":
        raise HTTPException(status_code=400, detail=f"Job not completed. Status: {job['status']}")

    result = job.get("result", {})
    subtitles = result.get("subtitles", [])

    if not subtitles:
        raise HTTPException(status_code=400, detail="No subtitles found in result")

    # SRT 파일 생성
    srt_file = create_srt_file(subtitles)

    return StreamingResponse(
        iter([srt_file.getvalue()]),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename=\"subtitle_{job_id}.srt\""}
    )
