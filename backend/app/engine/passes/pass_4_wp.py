"""
Pass 4: Wordplay Localization - 워드플레이 로컬라이제이션

역할:
- 영어 관용구/문화적 참조/말장난 감지
- LLM 기반 한국어 등가 표현으로 재창조
- 직역된 슬랭/은어 현지화
"""

import re
import math
from typing import Dict, Any, List, Tuple

from app.api.subtitles import get_vertex_ai
from app.core.k_cinematic_prompt import get_v6_2_wordplay_localization_prompt


# ═══ 워드플레이 감지 패턴 ═══
# (정규식, 분류, 설명)
_IDIOM_PATTERNS: List[Tuple[re.Pattern, str]] = [
    # 일반 영어 관용구
    (re.compile(r'\bhit the road\b', re.I), "idiom"),
    (re.compile(r'\bbreak a leg\b', re.I), "idiom"),
    (re.compile(r'\bkick the bucket\b', re.I), "idiom"),
    (re.compile(r'\bspill the beans\b', re.I), "idiom"),
    (re.compile(r'\bkill it\b', re.I), "idiom"),
    (re.compile(r'\bnail it\b', re.I), "idiom"),
    (re.compile(r'\bthat\'?s? a wrap\b', re.I), "idiom"),
    (re.compile(r'\bagree to disagree\b', re.I), "idiom"),
    (re.compile(r'\bhit a home run\b', re.I), "idiom"),
    (re.compile(r'\bball?park\b', re.I), "idiom"),
    (re.compile(r'\btouch base\b', re.I), "idiom"),
    (re.compile(r'\bthrow .{0,15} under the bus\b', re.I), "idiom"),
    (re.compile(r'\bhead.?s up\b', re.I), "idiom"),
    (re.compile(r'\bpull (my|your|his|her) leg\b', re.I), "idiom"),
    (re.compile(r'\bon (my|your|his|her) plate\b', re.I), "idiom"),
    (re.compile(r'\bpiece of cake\b', re.I), "idiom"),
    (re.compile(r'\bunder the weather\b', re.I), "idiom"),
    (re.compile(r'\bbeat around the bush\b', re.I), "idiom"),
    (re.compile(r'\bcall it (a day|quits)\b', re.I), "idiom"),
    (re.compile(r'\bget (your|my|his|her) act together\b', re.I), "idiom"),
    # 슬랭
    (re.compile(r'\bbadass\b', re.I), "slang"),
    (re.compile(r'\bchill out\b', re.I), "slang"),
    (re.compile(r'\bdope\b', re.I), "slang"),
    (re.compile(r'\blit\b(?!\w)', re.I), "slang"),
    (re.compile(r'\bsick\b(?! of| day| leave)', re.I), "slang"),
    (re.compile(r'\blegit\b', re.I), "slang"),
    (re.compile(r'\bgoat\b', re.I), "slang"),
    (re.compile(r'\bno cap\b', re.I), "slang"),
    (re.compile(r'\bfr\b', re.I), "slang"),
    (re.compile(r'\bbussin\b', re.I), "slang"),
    # 문화적 참조
    (re.compile(r'\bFML\b'), "cultural"),
    (re.compile(r'\bOMG\b', re.I), "cultural"),
    (re.compile(r'\bTBH\b', re.I), "cultural"),
    (re.compile(r'\bTBT\b', re.I), "cultural"),
    (re.compile(r'\bfyi\b', re.I), "cultural"),
    (re.compile(r'\bsmh\b', re.I), "cultural"),
    # V6.2 Module D: Foreign Filler
    (re.compile(r'^\s*(okay|alright|hey|yes|no|oh|well|listen)[\s,.]+', re.I), "foreign_filler"),
    (re.compile(r'[\s,.]+(okay|alright|hey|yes|no|oh|well|listen)\s*$', re.I), "foreign_filler"),
    (re.compile(r'\bguys\b', re.I), "foreign_filler"),
    # 직역 위험 표현들
    (re.compile(r'\bgot(ta)? (your|his|her) back\b', re.I), "idiom"),
    (re.compile(r'\bwatch (your|my|his|her) back\b', re.I), "idiom"),
    (re.compile(r'\bstep up (your|the) game\b', re.I), "idiom"),
    (re.compile(r'\bcome on,?\s*(man|buddy|dude|pal)\b', re.I), "idiom"),
    # 법률/행정 구어체 변환 필요 표현
    (re.compile(r'\blegally blind\b', re.I), "idiom"),
    (re.compile(r'\blegally\s+(deaf|mute|disabled)\b', re.I), "idiom"),
    (re.compile(r'\bon the record\b', re.I), "idiom"),
    (re.compile(r'\boff the record\b', re.I), "idiom"),
    # 추가 관용구
    (re.compile(r'\bin the same boat\b', re.I), "idiom"),
    (re.compile(r'\bhit (the|a) wall\b', re.I), "idiom"),
    (re.compile(r'\bget (the|a) clue\b', re.I), "idiom"),
    (re.compile(r'\bmiss the point\b', re.I), "idiom"),
    (re.compile(r'\bcut to the chase\b', re.I), "idiom"),
    (re.compile(r'\bthe bottom line\b', re.I), "idiom"),
    (re.compile(r'\bread my lips\b', re.I), "idiom"),
    (re.compile(r'\bget out of (my|your|the) way\b', re.I), "idiom"),
    (re.compile(r'\blong story short\b', re.I), "idiom"),
    (re.compile(r'\btake it easy\b', re.I), "idiom"),
    (re.compile(r'\bgive (me|you|him|her|them|us) a break\b', re.I), "idiom"),
    (re.compile(r'\bhang in there\b', re.I), "idiom"),
    (re.compile(r'\bfair enough\b', re.I), "idiom"),
    (re.compile(r'\bnot (my|your|his|her|their|our) problem\b', re.I), "idiom"),
    (re.compile(r'\bsuck it up\b', re.I), "idiom"),
    (re.compile(r'\bget over it\b', re.I), "idiom"),
    (re.compile(r'\bmy bad\b', re.I), "slang"),
    (re.compile(r'\bfor real\b', re.I), "slang"),
    (re.compile(r'\bthat.?s (what|all) (she|he|it) said\b', re.I), "idiom"),
    (re.compile(r'\bsame old (story|thing|deal)\b', re.I), "idiom"),
    (re.compile(r'\bright on\b', re.I), "slang"),
    (re.compile(r'\bno biggie\b', re.I), "slang"),
    (re.compile(r'\btotally\b', re.I), "slang"),
    (re.compile(r'\bnailed it\b', re.I), "idiom"),
    (re.compile(r'\bgood to go\b', re.I), "idiom"),
    (re.compile(r'\bworth it\b', re.I), "idiom"),
    (re.compile(r'\bnot gonna (lie|happen)\b', re.I), "slang"),
    (re.compile(r'\bwhatever\b', re.I), "slang"),
    (re.compile(r'\bseriously\b', re.I), "slang"),
    (re.compile(r'\bmeet in the middle\b', re.I), "idiom"),
    # 범용 동물 소리/동음이의어 말장난 포착 (Universal Animal & Sound Puns)
    (re.compile(r'\bneigh-sayer\b', re.I), "animal_pun"),
    (re.compile(r'\bbaa-d\b', re.I), "animal_pun"),
    (re.compile(r'\bpurr-fect\b', re.I), "animal_pun"),
    (re.compile(r'\bfur-real\b', re.I), "animal_pun"),
    (re.compile(r'\b(moo|meow|woof|oink|quack)-?[a-z]+\b', re.I), "animal_pun_universal"),
    # 범용 언어유희(Pun) 메타 발언 감지
    (re.compile(r'\bpun(s)?(\s+intended)?\b', re.I), "meta_pun"),
    (re.compile(r'\bno\s+pun\b', re.I), "meta_pun"),
]

# 번역투 직역 탐지 패턴 (한국어 텍스트에서)
_KO_DIRECT_TRANSLATE: List[Tuple[re.Pattern, str]] = [
    (re.compile(r'의견이 다르다고 해두'), "agree_to_disagree"),
    (re.compile(r'그게 전부야'), "thats_a_wrap_candidate"),
    (re.compile(r'다리를 부러'), "break_a_leg"),
    (re.compile(r'길을 쳐'), "hit_the_road"),
    (re.compile(r'도로를 치'), "hit_the_road"),
    (re.compile(r'콩을 쏟'), "spill_the_beans"),
    (re.compile(r'양동이를 걷어'), "kick_the_bucket"),
    (re.compile(r'합의하다고\s*해'), "agree_to_disagree_2"),
    # 추가 직역 탐지
    (re.compile(r'법적으로 시각'), "legally_blind"),
    (re.compile(r'법적으로 청각'), "legally_deaf"),
    (re.compile(r'케이크 한\s*조각'), "piece_of_cake"),
    (re.compile(r'날씨 아래'), "under_the_weather"),
    (re.compile(r'같은 배'), "in_the_same_boat"),
    (re.compile(r'입술을 읽'), "read_my_lips"),
    (re.compile(r'요점을 놓'), "miss_the_point"),
    (re.compile(r'핵심으로 가'), "cut_to_the_chase"),
    (re.compile(r'거기 매달려'), "hang_in_there"),
    (re.compile(r'충분히 공정'), "fair_enough"),
    (re.compile(r'홈런을 치'), "hit_a_home_run"),
    (re.compile(r'게임을 올려'), "step_up_game"),
    (re.compile(r'버스 아래'), "under_the_bus"),
    (re.compile(r'중간에서 만나다'), "meet_in_the_middle"),
    (re.compile(r'가운데에서 만나다'), "meet_in_the_middle"),
    (re.compile(r'이웃의 말'), "neigh_sayer_direct"),
    (re.compile(r'이웃의\s*말하는\s*사람'), "neigh_sayer_direct"),
]


def _detect_wordplay_blocks(blocks: List[Dict[str, Any]]) -> List[int]:
    """
    워드플레이가 있는 블록 인덱스 목록 반환.

    감지 기준:
    1. 영어 원문에서 관용구/슬랭/문화적 참조 패턴 매칭
    2. 한국어 번역에서 직역 흔적 탐지

    Args:
        blocks: 자막 블록 리스트

    Returns:
        워드플레이 후보 블록의 인덱스 리스트
    """
    candidate_indices = []
    for i, block in enumerate(blocks):
        en = block.get("en", "")
        ko = block.get("ko", "")
        if not en or not ko:
            continue

        # 영어 원문에서 관용구/슬랭 감지
        for pattern, _ in _IDIOM_PATTERNS:
            if pattern.search(en):
                candidate_indices.append(i)
                break
        else:
            # 한국어 번역에서 직역 흔적 탐지
            for pattern, _ in _KO_DIRECT_TRANSLATE:
                if pattern.search(ko):
                    candidate_indices.append(i)
                    break

    return candidate_indices


def _parse_wp_response(response_text: str, blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    워드플레이 LLM 응답 파싱.

    Args:
        response_text: LLM 응답 텍스트
        blocks: 원본 블록 리스트

    Returns:
        [{index, text, changed}, ...] 리스트
    """
    import json

    results = []
    try:
        # JSON 추출
        if "```json" in response_text:
            json_str = response_text.split("```json")[1].split("```")[0].strip()
        elif "```" in response_text:
            json_str = response_text.split("```")[1].split("```")[0].strip()
        else:
            start = response_text.find('{')
            end = response_text.rfind('}') + 1
            if start == -1:
                return results
            json_str = response_text[start:end]

        data = json.loads(json_str)
        # V6 output is a direct array
        wp_results = data if isinstance(data, list) else data.get("wp_results", [])
        for item in wp_results:
            if isinstance(item, dict) and item.get("index") is not None:
                results.append({
                    "index": item["index"],
                    "text": item.get("text", ""),
                    "changed": item.get("changed", True), # Assume changed if returned
                })
    except Exception:
        pass
    return results


async def run_pass_4(
    job: Dict[str, Any],
    blocks: List[Dict[str, Any]],
    metadata: Dict[str, Any] = None,
) -> List[Dict[str, Any]]:
    """
    Pass 4: Wordplay Localization 실행

    Args:
        job: 작업 저장소
        blocks: 자막 블록 리스트
        metadata: 메타데이터

    Returns:
        업데이트된 블록 리스트
    """
    job["current_pass"] = "Pass 4: 워드플레이 로컬라이제이션"
    job["progress"] = 99
    job["logs"].append("> [Pass 4] 워드플레이 감지 중...")

    metadata = metadata or {}
    title = metadata.get("title", "Unknown")
    genre = metadata.get("genre", "Drama")
    if isinstance(genre, list):
        genre = ", ".join(genre)

    # ═══ 워드플레이 후보 블록 감지 ═══
    candidate_indices = _detect_wordplay_blocks(blocks)

    if not candidate_indices:
        job["logs"].append("> [Pass 4] 워드플레이 교정 대상 없음")
        job["progress"] = 100
        job["logs"].append("> [Pass 4] 완료")
        return blocks

    job["logs"].append(f"  🎭 [Pass 4] {len(candidate_indices)}개 워드플레이 후보 감지 → LLM 교정 시작")

    # ═══ LLM 배치 교정 ═══
    WP_BATCH_SIZE = 20
    wp_total_fixed = 0

    system_prompt = get_v6_2_wordplay_localization_prompt(title=title, genre=genre, lore_json=job.get("lore"))
    translator = get_vertex_ai()

    num_batches = math.ceil(len(candidate_indices) / WP_BATCH_SIZE)

    for bi in range(num_batches):
        if job.get("cancelled"):
            break

        batch_idxs = candidate_indices[bi * WP_BATCH_SIZE:(bi + 1) * WP_BATCH_SIZE]
        batch_blocks = [blocks[i] for i in batch_idxs]

        # 앞뒤 2블록 컨텍스트 수집 (배치 범위 밖 블록만)
        context_ids: set = set()
        for idx in batch_idxs:
            for ci in range(max(0, idx - 2), min(len(blocks), idx + 3)):
                if ci not in batch_idxs:
                    context_ids.add(ci)

        # 프롬프트 구성 (컨텍스트 → 타겟 순서)
        lines = []
        if context_ids:
            lines.append("[CONTEXT - 참고용, 수정하지 말 것]")
            for ci in sorted(context_ids):
                cb = blocks[ci]
                c_en = cb.get("en", "").replace("\n", " ")
                c_ko = cb.get("ko", "").replace("\n", " ")
                lines.append(f"(ctx){cb.get('id')}: [EN] {c_en} | [KO] {c_ko}")
            lines.append("\n[TARGET - 아래 블록들의 워드플레이를 교정하세요]")

        for b in batch_blocks:
            en = b.get("en", "").replace("\n", " ")
            ko = b.get("ko", "").replace("\n", " ")
            lines.append(f"{b.get('id')}: [EN] {en} | [KO] {ko}")
        user_content = "Input:\n" + "\n".join(lines)

        try:
            def make_wp_call(attempt=0, max_retries=3):
                return translator.client.models.generate_content(
                    model=translator.model,
                    contents=user_content,
                    config={
                        "system_instruction": system_prompt,
                        "max_output_tokens": 8192,
                        "temperature": 0.3,
                    }
                )

            import asyncio as _asyncio
            response, error = await _asyncio.to_thread(translator._retry_with_backoff, make_wp_call)
            if error or not response:
                job["logs"].append(f"  ⚠ [Pass 4 배치 {bi + 1}] LLM 호출 실패")
                continue

            parsed = _parse_wp_response(response.text, batch_blocks)
            batch_fixed = 0

            for item in parsed:
                if not item.get("changed") or not item.get("text"):
                    continue
                target_id = item["index"]
                for block in blocks:
                    if block.get("id") == target_id:
                        old_ko = block.get("ko", "")
                        new_ko = item["text"].strip()
                        if new_ko and new_ko != old_ko:
                            block["ko"] = new_ko
                            batch_fixed += 1
                        break

            wp_total_fixed += batch_fixed
            if batch_fixed > 0:
                job["logs"].append(
                    f"  ✓ [Pass 4 배치 {bi + 1}/{num_batches}] {batch_fixed}개 워드플레이 교정됨"
                )

        except Exception as e:
            job["logs"].append(f"  ⚠ [Pass 4 배치 {bi + 1}] 오류: {str(e)[:80]}")

    if wp_total_fixed > 0:
        job["logs"].append(f"  ✅ [Pass 4] 총 {wp_total_fixed}개 워드플레이 로컬라이제이션 완료")
    else:
        job["logs"].append(
            f"  ℹ [Pass 4] {len(candidate_indices)}개 후보 감지됨, 교정 필요 없음 (이미 자연스러운 번역)"
        )

    job["progress"] = 100
    job["logs"].append("> [Pass 4] 완료")

    return blocks
