"""
QC 100블록 실제 테스트 스크립트
- a.srt 주토피아 100블록 파싱
- 번역투 있는 직역 한국어 자동 생성
- /qc-postprocess HTTP 호출 (thinking_config 있음/없음 비교)
- raw_content 출력으로 LLM 응답 직접 확인
"""

import re
import json
import httpx
import asyncio
import sys

# ─── SRT 파서 ───────────────────────────────────────────────────────────────
def parse_srt(path: str, limit: int = 100) -> list[dict]:
    with open(path, encoding="utf-8-sig") as f:
        content = f.read()
    blocks = []
    pattern = r"(\d+)\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\n(.*?)(?=\n\n|\Z)"
    for m in re.finditer(pattern, content, re.DOTALL):
        text = re.sub(r"<.*?>", "", m.group(4)).strip()
        text = re.sub(r"^\[.*?\]\s*", "", text).strip()
        if text:
            blocks.append({
                "index": int(m.group(1)),
                "start": m.group(2),
                "end": m.group(3),
                "en": text
            })
        if len(blocks) >= limit:
            break
    return blocks


# ─── 번역투 한국어 생성기 (패턴 기반) ───────────────────────────────────────
WORD_MAP = {
    r"\bI\b": "나는", r"\bme\b": "나를", r"\bmy\b": "나의",
    r"\byou\b": "당신", r"\byour\b": "당신의",
    r"\bhe\b": "그는", r"\bshe\b": "그녀는",
    r"\bwe\b": "우리는", r"\bthey\b": "그들은",
    r"\bit\b": "그것은",
    r"\bblood\b": "피", r"\bdeath\b": "죽음",
    r"\bright\b": "맞습니다", r"\bwrong\b": "틀렸습니다",
    r"\byes\b": "예", r"\bno\b": "아니요",
    r"\bplease\b": "부탁드립니다", r"\bsorry\b": "죄송합니다",
    r"\bthank you\b": "감사합니다", r"\bthanks\b": "감사합니다",
    r"\bhave\b": "가지고 있습니다", r"\bhas\b": "가지고 있습니다",
    r"\bwant\b": "원합니다", r"\bneed\b": "필요합니다",
    r"\bgo\b": "가다", r"\bcome\b": "오다",
    r"\bgot\b": "얻었습니다", r"\bget\b": "얻다",
    r"\bknow\b": "압니다", r"\bsee\b": "봅니다",
    r"\bsay\b": "말합니다", r"\btell\b": "말합니다",
    r"\bthink\b": "생각합니다", r"\bbelieve\b": "믿습니다",
    r"\bcan\b": "할 수 있습니다", r"\bwill\b": "할 것입니다",
    r"\bis\b": "입니다", r"\bare\b": "입니다",
    r"\bwas\b": "이었습니다", r"\bwere\b": "이었습니다",
}

def make_translationese(en: str) -> str:
    """의도적으로 번역투 있는 한국어를 생성"""
    text = en.lower()
    for pat, ko in WORD_MAP.items():
        text = re.sub(pat, ko, text, flags=re.IGNORECASE)
    # 마지막에 마침표 추가 (번역투 특징)
    text = text.strip()
    if text and not text.endswith((".", "!", "?")):
        text += "."
    return text


# ─── QC 엔드포인트 호출 ──────────────────────────────────────────────────────
async def call_qc(blocks: list[dict], use_thinking: bool = True) -> dict:
    """
    /qc-postprocess 엔드포인트 직접 호출
    Returns: (raw_response_dict, status_code)
    """
    payload = {
        "blocks": [
            {
                "index": b["index"],
                "start": b["start"],
                "end": b["end"],
                "en": b["en"],
                "ko": b["ko"],
            }
            for b in blocks
        ],
        "title": "Zootopia (2016)",
        "genre": "Animation, Adventure, Comedy",
        "synopsis": "주디 홉스는 최초의 토끼 경찰관으로서 닉 와일드 여우와 함께 실종 사건을 해결합니다.",
        "personas": "- Nick: 능글맞은 반말, 여유롭고 위트 있는 말투\n- Judy: 열정적이고 단호한 말투, 가끔 존댓말",
        "character_relations": {"Nick→Judy": "편한 동료, 반말"},
        "translation_rules": "",
        "prev_context": [],
    }

    # thinking_config 없는 버전 테스트 원할 때 임시로 백엔드 코드 수정 필요
    # 여기서는 그냥 API 호출만 함
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            "http://localhost:8033/api/v1/subtitles/qc-postprocess",
            json=payload,
        )
        return resp.json(), resp.status_code


# ─── 메인 ────────────────────────────────────────────────────────────────────
async def main():
    print("=" * 60)
    print("QC 100블록 테스트")
    print("=" * 60)

    # 1) SRT 파싱
    srt_path = "../a.srt"
    blocks = parse_srt(srt_path, limit=100)
    print(f"\n[1] {len(blocks)}개 블록 파싱 완료")

    # 2) 번역투 한국어 생성
    for b in blocks:
        b["ko"] = make_translationese(b["en"])
    print(f"[2] 번역투 한국어 생성 완료")
    print("  예시 (처음 5개):")
    for b in blocks[:5]:
        print(f"    EN: {b['en'][:50]}")
        print(f"    KO: {b['ko'][:50]}")
        print()

    # 3) QC 호출
    print(f"[3] /qc-postprocess 호출 중 (100블록)...")
    result, status = await call_qc(blocks)
    print(f"  HTTP 상태: {status}")

    if status != 200:
        print(f"  오류: {result}")
        return

    # 4) 결과 분석
    expected = result.get("expected_count", 0)
    received = result.get("received_count", 0)
    period_fixed = result.get("period_fixed", 0)
    translationese_fixed = result.get("translationese_fixed", 0)

    data_list = result.get("data", [])
    parsed_items = data_list[0].get("content", []) if data_list else []

    print(f"\n[4] 결과 분석:")
    print(f"  expected: {expected}, received: {received}")
    print(f"  period_fixed: {period_fixed}")
    print(f"  translationese_fixed: {translationese_fixed}")
    print(f"  parsed_items: {len(parsed_items)}개")

    # 5) 교정된 항목 확인
    changed = 0
    for item in parsed_items:
        idx = item.get("index")
        new_text = item.get("text", "")
        original = next((b["ko"] for b in blocks if b["index"] == idx), "")
        if new_text and new_text != original:
            changed += 1

    print(f"\n[5] 교정 결과:")
    print(f"  실제 교정된 블록 수: {changed} / {len(parsed_items)}")

    if changed == 0:
        print("  ⚠️  교정이 전혀 없습니다!")
        print("  → 백엔드 로그에서 [QC-DEBUG] 확인 필요")
    else:
        print(f"  ✅ {changed}개 교정됨")
        print("\n  교정 예시 (처음 3개):")
        count = 0
        for item in parsed_items:
            idx = item.get("index")
            new_text = item.get("text", "")
            original = next((b["ko"] for b in blocks if b["index"] == idx), "")
            if new_text and new_text != original:
                print(f"    [{idx}] BEFORE: {original[:60]}")
                print(f"    [{idx}] AFTER:  {new_text[:60]}")
                print()
                count += 1
                if count >= 3:
                    break

    # 6) 전체 결과 저장
    output_path = "test_qc_100_result.json"
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({
            "summary": {
                "expected": expected,
                "received": received,
                "changed": changed,
                "period_fixed": period_fixed,
                "translationese_fixed": translationese_fixed,
            },
            "items": parsed_items[:20],  # 처음 20개만 저장
        }, f, ensure_ascii=False, indent=2)
    print(f"\n결과 저장: {output_path}")


if __name__ == "__main__":
    asyncio.run(main())
