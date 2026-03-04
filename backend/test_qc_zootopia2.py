"""
주토피아 2 실제 번역 결과로 QC 테스트
- 영어 원본: 주토피아 2 (2025)_1_Eng.srt
- 한국어 번역: 주토피아 2 (2025)_1_Eng_ko_20260302_212351.srt
- 두 파일을 인덱스로 매칭하여 QC API 호출
"""

import re
import json
import httpx
import asyncio
import sys
import os

sys.stdout.reconfigure(encoding='utf-8')

BASE_URL = "http://localhost:8033/api/v1/subtitles"
LIMIT = 100


def parse_srt(path: str, limit: int = 9999) -> list[dict]:
    """빈 줄 없는 SRT도 처리 가능한 라인 기반 파서"""
    with open(path, encoding="utf-8-sig") as f:
        lines = f.readlines()

    blocks = []
    i = 0
    while i < len(lines) and len(blocks) < limit:
        line = lines[i].strip()
        if line.isdigit():
            idx = int(line)
            if i + 1 < len(lines) and "-->" in lines[i + 1]:
                timecode = lines[i + 1].strip()
                parts = timecode.split("-->")
                start = parts[0].strip()
                end = parts[1].strip()
                text_lines = []
                j = i + 2
                while j < len(lines):
                    t = lines[j].strip()
                    if t.isdigit() and j + 1 < len(lines) and "-->" in lines[j + 1]:
                        break
                    if t:
                        t = re.sub(r"<.*?>", "", t)
                        t = re.sub(r"^\[.*?\]\s*", "", t)
                        if t:
                            text_lines.append(t)
                    j += 1
                text = " ".join(text_lines).strip()
                if text:
                    blocks.append({
                        "index": idx,
                        "start": start,
                        "end": end,
                        "text": text,
                    })
                i = j
                continue
        i += 1
    return blocks


async def test_qc(en_blocks: list[dict], ko_blocks: list[dict]):
    # index로 매칭
    ko_map = {b["index"]: b["text"] for b in ko_blocks}

    matched = []
    for b in en_blocks:
        ko_text = ko_map.get(b["index"], "")
        if ko_text and ko_text.strip():
            matched.append({
                "index": b["index"],
                "start": b["start"],
                "end": b["end"],
                "en": b["text"],
                "ko": ko_text,
            })

    print(f"  매칭된 블록: {len(matched)}개 (영어: {len(en_blocks)}, 한국어: {len(ko_blocks)})")

    if not matched:
        print("  ERROR: 매칭된 블록이 없습니다!")
        return

    # 처음 10개 샘플 출력
    print("\n  [샘플 10개]")
    for b in matched[:10]:
        print(f"  [{b['index']:3d}] EN: {b['en'][:60]}")
        print(f"       KO: {b['ko'][:60]}")

    # QC 호출
    print(f"\n  QC API 호출 ({len(matched)}블록)...")

    payload = {
        "blocks": [
            {
                "index": b["index"],
                "start": b["start"],
                "end": b["end"],
                "en": b["en"],
                "ko": b["ko"],
            }
            for b in matched
        ],
        "title": "Zootopia 2 (2025)",
        "genre": "Animation, Adventure, Comedy",
        "synopsis": "주디 홉스와 닉 와일드가 다시 만나 새로운 모험을 펼칩니다.",
        "personas": "- Nick: 능글맞은 반말, 여유롭고 위트 있는 말투\n- Judy: 열정적이고 단호한 말투",
        "character_relations": {"Nick→Judy": "편한 동료, 반말"},
        "translation_rules": "",
        "prev_context": [],
    }

    async with httpx.AsyncClient(timeout=180.0) as client:
        resp = await client.post(f"{BASE_URL}/qc-postprocess", json=payload)
        if resp.status_code != 200:
            print(f"  ERROR: {resp.status_code} - {resp.text[:200]}")
            return
        data = resp.json()

    parsed_items = data.get("data", [{}])[0].get("content", [])
    period_fixed = data.get("period_fixed", 0)
    translationese_fixed = data.get("translationese_fixed", 0)

    print(f"\n  [QC 결과]")
    print(f"  parsed_items: {len(parsed_items)}개")
    print(f"  period_fixed: {period_fixed}")
    print(f"  translationese_fixed: {translationese_fixed}")

    # 실제 교정된 것 카운트
    ko_orig = {b["index"]: b["ko"] for b in matched}
    changed = 0
    changed_list = []
    for item in parsed_items:
        idx = item.get("index")
        new_text = item.get("text", "")
        orig = ko_orig.get(idx, "")
        if new_text and new_text.strip() != orig.strip():
            changed += 1
            changed_list.append((idx, orig, new_text))

    print(f"  실제 교정된 블록: {changed}/{len(parsed_items)}개")

    if changed == 0:
        print("\n  ⚠️  교정이 전혀 없습니다!")
        print("  → 번역 품질이 이미 좋거나 QC 프롬프트가 너무 관대합니다")
        print("\n  [교정 없음 샘플 — QC가 원본과 동일하게 반환한 것들]")
        count = 0
        for item in parsed_items[:10]:
            idx = item.get("index")
            text = item.get("text", "")
            orig = ko_orig.get(idx, "")
            if text:
                match_marker = "✓ 동일" if text.strip() == orig.strip() else "✗ 다름"
                print(f"    [{idx}] {match_marker}")
                print(f"         orig: {orig[:60]}")
                print(f"         qc:   {text[:60]}")
                count += 1
                if count >= 5:
                    break
    else:
        print(f"\n  ✅ {changed}개 교정됨")
        print("\n  [교정 예시 (처음 5개)]")
        for idx, orig, new_text in changed_list[:5]:
            print(f"    [{idx}] BEFORE: {orig[:60]}")
            print(f"         AFTER:  {new_text[:60]}")

    # 결과 저장
    output = {
        "summary": {
            "total_blocks": len(matched),
            "parsed": len(parsed_items),
            "changed": changed,
            "period_fixed": period_fixed,
            "translationese_fixed": translationese_fixed,
        },
        "changed_items": [
            {"index": idx, "before": orig, "after": new_text}
            for idx, orig, new_text in changed_list[:30]
        ],
    }
    with open("test_qc_zootopia2_result.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n  결과 저장: test_qc_zootopia2_result.json")


async def main():
    print("=" * 60)
    print("주토피아 2 실제 번역 QC 테스트")
    print("=" * 60)

    en_path = "../../rename/주토피아 2 (2025)_1_Eng.srt"
    ko_path = "../../rename/주토피아 2 (2025)_1_Eng_ko_20260302_212351.srt"

    # 절대 경로 시도
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    en_path_abs = os.path.join(base, "주토피아 2 (2025)_1_Eng.srt")
    ko_path_abs = os.path.join(base, "주토피아 2 (2025)_1_Eng_ko_20260302_212351.srt")

    if os.path.exists(en_path_abs):
        en_path = en_path_abs
    if os.path.exists(ko_path_abs):
        ko_path = ko_path_abs

    print(f"\n영어 원본: {en_path}")
    print(f"한국어 번역: {ko_path}")

    if not os.path.exists(en_path):
        print(f"ERROR: 영어 파일 없음: {en_path}")
        return
    if not os.path.exists(ko_path):
        print(f"ERROR: 한국어 파일 없음: {ko_path}")
        return

    en_blocks = parse_srt(en_path, limit=LIMIT)
    ko_blocks = parse_srt(ko_path, limit=LIMIT)

    print(f"\n파싱: 영어 {len(en_blocks)}개, 한국어 {len(ko_blocks)}개")

    await test_qc(en_blocks, ko_blocks)


if __name__ == "__main__":
    asyncio.run(main())
