"""
E2E 100블록 테스트: 실제 번역 → QC 연속 실행
1. a.srt 주토피아 100블록 파싱
2. batch-translate 호출 (실제 Gemini 번역)
3. 번역 결과를 qc-postprocess 통과
4. 교정 전/후 비교 및 raw_content 확인
"""

import re
import json
import httpx
import asyncio
import sys
import os

sys.stdout.reconfigure(encoding='utf-8')

BASE_URL = "http://localhost:8033/api/v1/subtitles"


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
                "en": text,
                "ko": "",
                "speaker": "",
                "addressee": "",
            })
        if len(blocks) >= limit:
            break
    return blocks


async def step1_translate(blocks: list[dict]) -> list[dict]:
    """batch-translate API 호출 → 실제 Gemini 번역"""
    print(f"\n[Step 1] batch-translate 호출 ({len(blocks)}블록)...")

    # 30개씩 배치로 나눠서 호출
    batch_size = 30
    all_translated = {b["index"]: b.copy() for b in blocks}

    for i in range(0, len(blocks), batch_size):
        batch = blocks[i:i+batch_size]
        batch_num = i // batch_size + 1
        total_batches = (len(blocks) + batch_size - 1) // batch_size

        payload = {
            "blocks": [
                {
                    "index": b["index"],
                    "start": b["start"],
                    "end": b["end"],
                    "text": b["en"],
                    "speaker": b.get("speaker", "") or "",
                    "addressee": b.get("addressee", "") or "",
                    "duration_sec": 2.0,
                    "max_chars": 30,
                }
                for b in batch
            ],
            "title": "Zootopia (2016)",
            "genre": "Animation, Adventure, Comedy",
            "synopsis": "주디 홉스는 최초의 토끼 경찰관으로서 닉 와일드 여우와 함께 실종 사건을 해결합니다.",
            "personas": "- Nick: 능글맞은 반말, 여유롭고 위트 있는 말투\n- Judy: 열정적이고 단호한 말투",
            "fixed_terms": "",
            "translation_rules": "",
            "prev_context": [],
            "character_relations": {"Nick→Judy": "편한 동료, 반말"},
            "confirmed_speech_levels": {},
            "tone_memory": [],
            "batch_mood": "경쾌하고 유머러스한",
            "content_rating": "PG",
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(f"{BASE_URL}/batch-translate", json=payload)
            if resp.status_code != 200:
                print(f"  [배치 {batch_num}/{total_batches}] 오류: {resp.status_code}")
                continue

            data = resp.json()
            trans_list = data.get("data", [])
            if trans_list:
                for item in trans_list[0].get("content", []):
                    idx = item.get("index")
                    text = item.get("text", "")
                    if idx and text and idx in all_translated:
                        all_translated[idx]["ko"] = text

        translated_in_batch = sum(1 for b in batch if all_translated[b["index"]].get("ko"))
        print(f"  [배치 {batch_num}/{total_batches}] {translated_in_batch}/{len(batch)}개 번역됨")

    result = list(all_translated.values())
    total_translated = sum(1 for b in result if b.get("ko"))
    print(f"  총 {total_translated}/{len(blocks)}개 번역 완료")
    return result


async def step2_qc(blocks: list[dict]) -> tuple[list[dict], int]:
    """qc-postprocess 호출 → QC 교정 적용"""
    print(f"\n[Step 2] qc-postprocess 호출 ({len(blocks)}블록)...")

    # 번역된 블록만 QC에 통과
    translated = [b for b in blocks if b.get("ko")]
    print(f"  번역된 블록: {len(translated)}개")

    payload = {
        "blocks": [
            {
                "index": b["index"],
                "start": b["start"],
                "end": b["end"],
                "en": b["en"],
                "ko": b["ko"],
            }
            for b in translated
        ],
        "title": "Zootopia (2016)",
        "genre": "Animation, Adventure, Comedy",
        "synopsis": "주디 홉스는 최초의 토끼 경찰관으로서 닉 와일드 여우와 함께 실종 사건을 해결합니다.",
        "personas": "- Nick: 능글맞은 반말, 여유롭고 위트 있는 말투\n- Judy: 열정적이고 단호한 말투",
        "character_relations": {"Nick→Judy": "편한 동료, 반말"},
        "translation_rules": "",
        "prev_context": [],
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(f"{BASE_URL}/qc-postprocess", json=payload)
        if resp.status_code != 200:
            print(f"  오류: {resp.status_code}")
            return blocks, 0

        data = resp.json()

    parsed_items = data.get("data", [{}])[0].get("content", [])

    # 교정된 것 적용
    result = {b["index"]: b.copy() for b in blocks}
    changed = 0
    for item in parsed_items:
        idx = item.get("index")
        new_text = item.get("text", "")
        if idx and new_text and idx in result:
            old_text = result[idx].get("ko", "")
            if new_text.strip() != old_text.strip():
                result[idx]["ko_qc"] = new_text
                changed += 1
            else:
                result[idx]["ko_qc"] = old_text  # 변경 없음

    print(f"  교정됨: {changed}/{len(parsed_items)}개")
    print(f"  period_fixed: {data.get('period_fixed', 0)}")
    print(f"  translationese_fixed: {data.get('translationese_fixed', 0)}")

    return list(result.values()), changed


async def main():
    print("=" * 60)
    print("E2E 100블록 테스트: 번역 → QC")
    print("=" * 60)

    # SRT 파싱
    srt_path = "../a.srt"
    blocks = parse_srt(srt_path, limit=100)
    print(f"\n파싱된 블록: {len(blocks)}개")

    # Step 1: 실제 번역
    blocks = await step1_translate(blocks)

    # 번역 결과 샘플 출력
    print("\n번역 결과 샘플 (10개):")
    for b in blocks[:10]:
        if b.get("ko"):
            print(f"  [{b['index']:3d}] EN: {b['en'][:50]}")
            print(f"       KO: {b['ko'][:50]}")

    # Step 2: QC
    blocks, changed = await step2_qc(blocks)

    # QC 전후 비교
    print("\nQC 교정 비교 (처음 변경된 것들):")
    count = 0
    for b in blocks:
        if b.get("ko_qc") and b.get("ko") and b["ko_qc"] != b["ko"]:
            print(f"  [{b['index']:3d}] BEFORE: {b['ko'][:60]}")
            print(f"       AFTER:  {b['ko_qc'][:60]}")
            print()
            count += 1
            if count >= 5:
                break

    if changed == 0:
        print("  QC 교정 없음 — 번역이 이미 자연스럽거나 QC가 너무 관대합니다")

    # 결과 저장
    output = {
        "total_blocks": len(blocks),
        "translated": sum(1 for b in blocks if b.get("ko")),
        "qc_changed": changed,
        "samples": [
            {
                "index": b["index"],
                "en": b["en"],
                "ko_before": b.get("ko", ""),
                "ko_after": b.get("ko_qc", b.get("ko", "")),
                "changed": b.get("ko_qc", "") != b.get("ko", "") and bool(b.get("ko_qc")),
            }
            for b in blocks[:30]  # 처음 30개만
        ],
    }
    with open("test_e2e_result.json", "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\n결과 저장: test_e2e_result.json")
    print(f"총 번역: {output['translated']}/{output['total_blocks']}개")
    print(f"QC 교정: {output['qc_changed']}개")


if __name__ == "__main__":
    asyncio.run(main())
