#!/usr/bin/env python3
"""
자막 말투 일관성 분석기 (Honorific Drift Detector)
- SRT 파일에서 캐릭터별 말투(존댓말/반말) 변화를 추적
- 배치 경계에서의 급변 감지
- 존반말 혼용 블록 검출
"""
import re
import sys
from collections import defaultdict

def parse_srt(filepath):
    """SRT 파일을 파싱하여 블록 리스트 반환"""
    blocks = []
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    # SRT 블록 분리
    raw_blocks = re.split(r'\n\s*\n', content.strip())

    for raw in raw_blocks:
        lines = raw.strip().split('\n')
        if len(lines) < 2:
            continue

        # 첫줄: 번호
        try:
            idx = int(lines[0].strip())
        except ValueError:
            continue

        # 둘째줄: 타임코드
        tc_match = re.match(r'(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})', lines[1])
        if not tc_match:
            continue

        # 나머지: 텍스트
        text = '\n'.join(lines[2:]).strip()
        if not text:
            continue

        blocks.append({
            'id': idx,
            'start': tc_match.group(1),
            'end': tc_match.group(2),
            'text': text,
        })

    return blocks

# ── 말투 판별 패턴 ──

# 존댓말 어미 (하십시오체 / 해요체)
HONORIFIC_PATTERNS = [
    r'합니다[.!?\s]*$',
    r'합니까[.!?\s]*$',
    r'하십시오[.!?\s]*$',
    r'하세요[.!?\s]*$',
    r'입니다[.!?\s]*$',
    r'입니까[.!?\s]*$',
    r'습니다[.!?\s]*$',
    r'습니까[.!?\s]*$',
    r'세요[.!?\s]*$',
    r'에요[.!?\s]*$',
    r'이에요[.!?\s]*$',
    r'해요[.!?\s]*$',
    r'돼요[.!?\s]*$',
    r'줘요[.!?\s]*$',
    r'는데요[.!?\s]*$',
    r'거든요[.!?\s]*$',
    r'잖아요[.!?\s]*$',
    r'요[.!?\s]*$',  # 해요체 종결
    r'겠습니다[.!?\s]*$',
    r'드립니다[.!?\s]*$',
    r'드려요[.!?\s]*$',
    r'으세요[.!?\s]*$',
    r'으십시오[.!?\s]*$',
    r'십시오[.!?\s]*$',
    r'겠어요[.!?\s]*$',
    r'셨어요[.!?\s]*$',
    r'셨습니다[.!?\s]*$',
    r'시겠습니까[.!?\s]*$',
]

# 반말 어미 (해체 / 해라체)
CASUAL_PATTERNS = [
    r'[^요]야[.!?\s]*$',
    r'이야[.!?\s]*$',
    r'해[.!?\s]*$',
    r'해라[.!?\s]*$',
    r'하자[.!?\s]*$',
    r'잖아[.!?\s]*$',
    r'거든[.!?\s]*$',
    r'는데[.!?\s]*$',
    r'[^요]지[.!?\s]*$',
    r'어[.!?\s]*$',
    r'아[.!?\s]*$',
    r'냐[.!?\s]*$',
    r'니[.!?\s]*$',
    r'래[.!?\s]*$',
    r'게[.!?\s]*$',
    r'자[.!?\s]*$',
    r'줘[.!?\s]*$',
    r'네[.!?\s]*$',
    r'지[.!?\s]*$',
    r'걸[.!?\s]*$',
    r'군[.!?\s]*$',
    r'든[.!?\s]*$',
    r'거야[.!?\s]*$',
    r'건데[.!?\s]*$',
    r'잖아[.!?\s]*$',
    r'는거야[.!?\s]*$',
    r'었어[.!?\s]*$',
    r'였어[.!?\s]*$',
    r'했어[.!?\s]*$',
    r'겠어[.!?\s]*$',
    r'알겠지[.!?\s]*$',
    r'알았지[.!?\s]*$',
    r'맞지[.!?\s]*$',
]

def classify_line(line):
    """한 줄의 말투를 분류: 'H'=존댓말, 'C'=반말, 'N'=불명"""
    line = line.strip()
    # 태그/음향효과/음악 제거
    if re.match(r'^[\[♪\(]', line):
        return 'N'
    if re.match(r'^<i>', line) and re.search(r'</i>$', line):
        line = re.sub(r'</?i>', '', line)

    # 한국어가 거의 없으면 스킵
    korean_chars = len(re.findall(r'[가-힣]', line))
    if korean_chars < 3:
        return 'N'

    # 줄 끝부분 체크 (마지막 10자)
    tail = line[-15:] if len(line) > 15 else line

    h_score = 0
    c_score = 0

    for pat in HONORIFIC_PATTERNS:
        if re.search(pat, tail):
            h_score += 1

    for pat in CASUAL_PATTERNS:
        if re.search(pat, tail):
            c_score += 1

    # '요'로 끝나면 강력한 존댓말 신호
    if re.search(r'요[.!?\s]*$', tail):
        h_score += 3

    # '습니다/습니까'는 매우 강력
    if re.search(r'습니[다까][.!?\s]*$', tail):
        h_score += 5

    if h_score > c_score:
        return 'H'
    elif c_score > h_score:
        return 'C'
    else:
        return 'N'

def classify_block(text):
    """블록 전체의 말투 분류"""
    lines = text.split('\n')
    scores = {'H': 0, 'C': 0, 'N': 0}
    details = []

    for line in lines:
        # 화자 분리 (- 로 시작하는 경우)
        if line.strip().startswith('-'):
            line = line.strip()[1:].strip()

        cls = classify_line(line)
        scores[cls] += 1
        if cls != 'N':
            details.append((line.strip(), cls))

    # 혼용 감지
    if scores['H'] > 0 and scores['C'] > 0:
        return 'MIX', details
    elif scores['H'] > scores['C']:
        return 'H', details
    elif scores['C'] > scores['H']:
        return 'C', details
    else:
        return 'N', details

def detect_speaker(text, prev_blocks):
    """화자 추정 (간단한 휴리스틱)"""
    # [닉], [주디], (닉), (주디) 등의 태그
    speaker_match = re.search(r'[\[\(](닉|주디|서장|보고|벨웨더|클로하우저|플래시)', text)
    if speaker_match:
        return speaker_match.group(1)
    return None

def timecode_to_seconds(tc):
    """타임코드를 초로 변환"""
    h, m, s = tc.split(':')
    s, ms = s.split(',')
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000

def analyze_drift(blocks):
    """전체 블록에서 말투 드리프트 분석"""
    results = {
        'mixed_blocks': [],       # 존반말 혼용 블록
        'batch_boundaries': [],   # 배치 경계 급변
        'drift_sequences': [],    # 연속 말투 변화
        'honorific_to_boss': [],  # 상관에게 반말
        'stats': defaultdict(int),
    }

    BATCH_SIZE = 15
    prev_style = None
    consecutive_same = 0
    drift_start = None

    for i, block in enumerate(blocks):
        style, details = classify_block(block['text'])
        block['style'] = style
        block['details'] = details

        # 1. 혼용 블록 감지
        if style == 'MIX':
            results['mixed_blocks'].append({
                'id': block['id'],
                'time': block['start'],
                'text': block['text'],
                'details': details,
            })

        # 2. 배치 경계 감지 (15블록마다)
        if i > 0 and i % BATCH_SIZE == 0:
            prev_block = blocks[i - 1]
            if (prev_block.get('style') in ('H', 'C') and
                style in ('H', 'C') and
                prev_block['style'] != style):
                results['batch_boundaries'].append({
                    'batch_num': i // BATCH_SIZE,
                    'boundary_at': block['id'],
                    'time': block['start'],
                    'before': f"#{prev_block['id']} [{prev_block['style']}] {prev_block['text'][:40]}",
                    'after': f"#{block['id']} [{style}] {block['text'][:40]}",
                })

        # 3. 말투 급변 시퀀스 (3블록 이내에 존↔반 전환)
        if style in ('H', 'C'):
            if prev_style and prev_style != style and prev_style in ('H', 'C'):
                results['drift_sequences'].append({
                    'id': block['id'],
                    'time': block['start'],
                    'from': prev_style,
                    'to': style,
                    'text': block['text'][:60],
                    'prev_text': blocks[i-1]['text'][:60] if i > 0 else '',
                })
            prev_style = style

        # 4. 상관에게 반말 감지
        boss_keywords = ['서장님', '시장님', '경위님', '국장님', '서장', '교수님']
        if style == 'C':
            for kw in boss_keywords:
                if kw in block['text']:
                    results['honorific_to_boss'].append({
                        'id': block['id'],
                        'time': block['start'],
                        'text': block['text'],
                        'keyword': kw,
                    })

        results['stats'][style] += 1

    return results

def find_narrator_inconsistency(blocks):
    """내레이션(이탤릭) 블록의 말투 일관성 체크"""
    narration_blocks = []
    for b in blocks:
        if '<i>' in b['text']:
            style, details = classify_block(b['text'])
            if style in ('H', 'C'):
                narration_blocks.append({
                    'id': b['id'],
                    'time': b['start'],
                    'style': style,
                    'text': b['text'][:60],
                })

    # 내레이션 말투 변화 감지
    inconsistencies = []
    prev = None
    for nb in narration_blocks:
        if prev and prev['style'] != nb['style']:
            inconsistencies.append({
                'before': prev,
                'after': nb,
            })
        prev = nb

    return narration_blocks, inconsistencies

def find_english_remnants(blocks):
    """영어 잔류 블록 검출"""
    remnants = []
    for b in blocks:
        text = b['text']
        # 태그 제거
        clean = re.sub(r'<[^>]+>', '', text)
        clean = re.sub(r'[\[♪\(][^\]♪\)]*[\]♪\)]', '', clean)
        clean = clean.strip()

        if not clean:
            continue

        # 영어 비율 체크
        eng_chars = len(re.findall(r'[a-zA-Z]', clean))
        total_chars = len(clean.replace(' ', ''))

        if total_chars > 5 and eng_chars / max(total_chars, 1) > 0.5:
            remnants.append({
                'id': b['id'],
                'time': b['start'],
                'text': text,
            })

    return remnants

def find_period_violations(blocks):
    """마침표 잔류 검출"""
    violations = []
    for b in blocks:
        text = b['text']
        # 줄별로 체크
        for line in text.split('\n'):
            line = line.strip()
            # 태그 안의 마침표는 제외
            clean = re.sub(r'<[^>]+>', '', line)
            clean = re.sub(r'\.{3}', '…', clean)  # ... → … 치환
            clean = re.sub(r'…', '', clean)  # 말줄임표 제외

            if clean.endswith('.'):
                violations.append({
                    'id': b['id'],
                    'time': b['start'],
                    'text': line,
                })
    return violations

def main():
    filepath = sys.argv[1] if len(sys.argv) > 1 else r"C:\Vibe Coding\rename\주토피아 2 (2025)_Eng_ko_20260215_000818.srt"

    print("=" * 80)
    print("  자막 말투 일관성 심층 분석 (Honorific Drift Detector)")
    print("=" * 80)
    print(f"\n파일: {filepath}\n")

    blocks = parse_srt(filepath)
    print(f"총 {len(blocks)}개 블록 파싱됨\n")

    # ── 1. 말투 드리프트 분석 ──
    results = analyze_drift(blocks)

    print("-" * 80)
    print("  [1] 기본 통계")
    print("-" * 80)
    print(f"  존댓말(H) 블록: {results['stats']['H']}개")
    print(f"  반말(C) 블록:   {results['stats']['C']}개")
    print(f"  혼용(MIX) 블록: {results['stats']['MIX']}개")
    print(f"  불명(N) 블록:   {results['stats']['N']}개")

    # ── 2. 존반말 혼용 블록 ──
    print(f"\n{'=' * 80}")
    print(f"  [2] 존반말 혼용 블록 ({len(results['mixed_blocks'])}개)")
    print(f"{'=' * 80}")
    for mb in results['mixed_blocks'][:30]:  # 상위 30개
        print(f"\n  #{mb['id']} [{mb['time']}]")
        print(f"  텍스트: {mb['text']}")
        for line, cls in mb['details']:
            label = '존댓말' if cls == 'H' else '반말'
            print(f"    → [{label}] {line}")
    if len(results['mixed_blocks']) > 30:
        print(f"\n  ... 외 {len(results['mixed_blocks']) - 30}개 더")

    # ── 3. 배치 경계 급변 ──
    print(f"\n{'=' * 80}")
    print(f"  [3] 배치 경계(15블록) 말투 급변 ({len(results['batch_boundaries'])}개)")
    print(f"{'=' * 80}")
    for bb in results['batch_boundaries']:
        print(f"\n  배치 {bb['batch_num']} → {bb['batch_num']+1} (블록 #{bb['boundary_at']}, {bb['time']})")
        print(f"    이전: {bb['before']}")
        print(f"    이후: {bb['after']}")

    # ── 4. 말투 급변 시퀀스 ──
    print(f"\n{'=' * 80}")
    print(f"  [4] 말투 급변 시퀀스 — 존↔반 전환 ({len(results['drift_sequences'])}개)")
    print(f"{'=' * 80}")
    # 밀집 구간 찾기
    if results['drift_sequences']:
        # 10블록 윈도우로 밀집도 계산
        drift_ids = [d['id'] for d in results['drift_sequences']]
        dense_zones = []
        for i in range(0, max(drift_ids) + 1, 10):
            count = sum(1 for d in drift_ids if i <= d < i + 10)
            if count >= 3:
                dense_zones.append((i, i + 10, count))

        if dense_zones:
            print("\n  *** 말투 급변 밀집 구간 (10블록 내 3회 이상) ***")
            for start, end, cnt in dense_zones:
                # 해당 구간의 타임코드 찾기
                zone_blocks = [b for b in blocks if start <= b['id'] < end]
                if zone_blocks:
                    tc = zone_blocks[0]['start']
                    print(f"  블록 #{start}~#{end} ({tc}): {cnt}회 전환")

        print(f"\n  전체 급변 목록 (상위 50개):")
        for ds in results['drift_sequences'][:50]:
            fr = '존댓말' if ds['from'] == 'H' else '반말'
            to = '존댓말' if ds['to'] == 'H' else '반말'
            print(f"  #{ds['id']} [{ds['time']}] {fr}→{to}")
            print(f"    이전: {ds['prev_text']}")
            print(f"    현재: {ds['text']}")

    # ── 5. 상관에게 반말 ──
    print(f"\n{'=' * 80}")
    print(f"  [5] 상관/직함에게 반말 사용 ({len(results['honorific_to_boss'])}개)")
    print(f"{'=' * 80}")
    for hb in results['honorific_to_boss']:
        print(f"  #{hb['id']} [{hb['time']}] ('{hb['keyword']}' 포함)")
        print(f"    {hb['text']}")

    # ── 6. 내레이션 일관성 ──
    print(f"\n{'=' * 80}")
    print(f"  [6] 내레이션(<i>) 말투 일관성")
    print(f"{'=' * 80}")
    narr_blocks, narr_inconsist = find_narrator_inconsistency(blocks)
    print(f"  내레이션 블록: {len(narr_blocks)}개")
    print(f"  말투 전환: {len(narr_inconsist)}개")
    for ni in narr_inconsist[:20]:
        fr = '존댓말' if ni['before']['style'] == 'H' else '반말'
        to = '존댓말' if ni['after']['style'] == 'H' else '반말'
        print(f"  #{ni['before']['id']}→#{ni['after']['id']}: {fr}→{to}")
        print(f"    이전: {ni['before']['text']}")
        print(f"    이후: {ni['after']['text']}")

    # ── 7. 영어 잔류 ──
    print(f"\n{'=' * 80}")
    print(f"  [7] 영어 잔류 블록")
    print(f"{'=' * 80}")
    remnants = find_english_remnants(blocks)
    print(f"  영어 잔류: {len(remnants)}개")
    for r in remnants[:20]:
        print(f"  #{r['id']} [{r['time']}] {r['text']}")

    # ── 8. 마침표 잔류 ──
    print(f"\n{'=' * 80}")
    print(f"  [8] 마침표(.) 잔류 블록")
    print(f"{'=' * 80}")
    periods = find_period_violations(blocks)
    print(f"  마침표 잔류: {len(periods)}개")
    for p in periods[:20]:
        print(f"  #{p['id']} [{p['time']}] {p['text']}")

    # ── 종합 ──
    print(f"\n{'=' * 80}")
    print(f"  [종합 진단]")
    print(f"{'=' * 80}")

    total_issues = (
        len(results['mixed_blocks']) +
        len(results['batch_boundaries']) +
        len(results['honorific_to_boss']) +
        len(narr_inconsist) +
        len(remnants) +
        len(periods)
    )

    print(f"\n  총 이슈: {total_issues}개")
    print(f"  ├── 존반말 혼용: {len(results['mixed_blocks'])}개")
    print(f"  ├── 배치 경계 급변: {len(results['batch_boundaries'])}개")
    print(f"  ├── 말투 급변 시퀀스: {len(results['drift_sequences'])}개")
    print(f"  ├── 상관에게 반말: {len(results['honorific_to_boss'])}개")
    print(f"  ├── 내레이션 전환: {len(narr_inconsist)}개")
    print(f"  ├── 영어 잔류: {len(remnants)}개")
    print(f"  └── 마침표 잔류: {len(periods)}개")

    severity = "심각" if total_issues > 50 else "보통" if total_issues > 20 else "경미"
    print(f"\n  심각도: {severity}")

    if results['batch_boundaries']:
        print(f"\n  ⚠ 배치 경계 급변이 {len(results['batch_boundaries'])}개 발견됨")
        print(f"    → 원인: QC Pass의 prev_context 부재 + HONORIFIC_RULES 이중 주입")
        print(f"    → 플랜의 수정으로 직접적 개선 기대")

if __name__ == '__main__':
    main()
