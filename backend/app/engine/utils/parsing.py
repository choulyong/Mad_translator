"""
Parsing Utilities - JSON 정제 및 파싱

역할:
- JSON 문자열 정제 (제어 문자 이스케이프, 문법 수정)
- 번역 응답 파싱 (다중 폴백 전략)
"""

import re
import json
from typing import List, Dict, Any, Optional


def sanitize_json(json_str: str) -> str:
    """
    JSON 문자열 정제 - 아포스트로피 보존!

    처리 내용:
    - 제어 문자 이스케이프 (Invalid control character 에러 방지)
    - 후행 쉼마 제거 (,} , ,])
    - 인용되지 않은 키 인용 처리
    - 이중 따옴표 정리
    """
    result = json_str

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

    # 후행 쉼마 제거
    result = re.sub(r',\s*}', '}', result)
    result = re.sub(r',\s*]', ']', result)

    # 인용되지 않은 키만 수정 (텍스트 값은 건드리지 않음)
    result = re.sub(r'([{\[,]\s*)(\w+)(\s*:)', r'\1"\2"\3', result)

    # 이중 따옴표 수정
    result = result.replace('""', '"')

    # 주의: .replace(/'/g, '"') 는 아포스트로피를 손상시키므로 사용하지 않음!

    return result


def parse_translation_response(raw_content: str, original_blocks: list) -> List[Dict[str, Any]]:
    """
    번역 응답 파싱 - 다중 폴백 전략

    Args:
        raw_content: LLM 원본 응답 텍스트
        original_blocks: 원본 블록 리스트 (미사용, 호환성 유지용)

    Returns:
        list of {index: int, text: str}
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
            sanitized = sanitize_json(content)
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
                        sanitized_recovered = sanitize_json(recovered)
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
