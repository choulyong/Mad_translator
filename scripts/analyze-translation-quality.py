#!/usr/bin/env python3
"""
번역 품질 심층 분석기 (Translation Quality Deep Analyzer)
- 직역투/번역투 감지
- 중복 블록 감지
- 대명사 남용
- 생일 소년 같은 직역 관용구
- 부자연스러운 표현
- 너무 긴 자막
- 마침표 외 문장부호 문제
"""
import re
import sys
from collections import Counter, defaultdict

def parse_srt(filepath):
    blocks = []
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    raw_blocks = re.split(r'\n\s*\n', content.strip())
    for raw in raw_blocks:
        lines = raw.strip().split('\n')
        if len(lines) < 2:
            continue
        try:
            idx = int(lines[0].strip())
        except ValueError:
            continue
        tc_match = re.match(r'(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})', lines[1])
        if not tc_match:
            continue
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

def find_duplicate_blocks(blocks):
    """완전 동일 또는 거의 동일한 연속 블록 감지"""
    dupes = []
    for i in range(1, len(blocks)):
        # 한국어 텍스트만 비교 (태그 제거)
        prev_clean = re.sub(r'<[^>]+>', '', blocks[i-1]['text']).strip()
        curr_clean = re.sub(r'<[^>]+>', '', blocks[i]['text']).strip()

        if not prev_clean or not curr_clean:
            continue

        if prev_clean == curr_clean:
            dupes.append({
                'ids': [blocks[i-1]['id'], blocks[i]['id']],
                'time': blocks[i-1]['start'],
                'text': prev_clean[:60],
                'type': 'exact',
            })
        elif len(prev_clean) > 10 and len(curr_clean) > 10:
            # 부분 중복 (한쪽이 다른쪽을 포함)
            if prev_clean in curr_clean or curr_clean in prev_clean:
                dupes.append({
                    'ids': [blocks[i-1]['id'], blocks[i]['id']],
                    'time': blocks[i-1]['start'],
                    'text': f"{prev_clean[:30]} / {curr_clean[:30]}",
                    'type': 'partial',
                })
    return dupes

def find_translationese(blocks):
    """번역투/직역투 표현 감지"""
    patterns = [
        # 대명사 남용
        (r'그녀[가는를의]', '그녀 남용 (한국어에서 부자연스러움)'),
        (r'그[가는를의]\s', '그 (대명사) 남용'),
        (r'당신[이은를의에]', '당신 남용'),
        (r'나는\s', '"나는" (주어 과다 노출)'),

        # 직역 관용구
        (r'생일\s*소년', '"Birthday boy" 직역'),
        (r'생일\s*걸', '"Birthday girl" 직역'),
        (r'큰\s*남자', '"Big man" 직역 가능성'),
        (r'작은\s*남자', '"Little man" 직역 가능성'),
        (r'좋은\s*소년', '"Good boy" 직역'),
        (r'내\s*나쁜', '"My bad" 직역'),
        (r'사업을\s*의미', '"Mean business" 직역'),
        (r'그것은\s', '"It is" 직역투'),
        (r'그것이\s', '"It is" 직역투'),
        (r'이것은\s', '"This is" 직역투'),
        (r'거기에\s있', '"There is/are" 직역투'),

        # 번역투 문체
        (r'하고\s*있는\s*중', '"~ing" 번역투'),
        (r'되어\s*지', '이중 피동'),
        (r'되어져', '이중 피동'),
        (r'시켜\s*지', '사역+피동 혼용'),
        (r'에\s*대해서', '"about" 직역투 (불필요한 경우)'),
        (r'그래서\s*그것', '"So it" 직역투'),
        (r'하는\s*것은\s*가능', '"It is possible to" 직역투'),

        # 과잉 한자어 (구어체 자막에서)
        (r'진행하다|진행합니다|진행해', '진행하다 (구어체에서 부자연스러움)'),
        (r'수행하다|수행합니다|수행해', '수행하다 (구어체에서 부자연스러움)'),
        (r'실시하다|실시합니다|실시해', '실시하다 (구어체에서 부자연스러움)'),
    ]

    issues = []
    for block in blocks:
        text = block['text']
        clean = re.sub(r'<[^>]+>', '', text)

        for pat, desc in patterns:
            matches = re.findall(pat, clean)
            if matches:
                issues.append({
                    'id': block['id'],
                    'time': block['start'],
                    'text': clean[:60],
                    'issue': desc,
                    'match': matches[0] if matches else '',
                })
    return issues

def find_long_subtitles(blocks):
    """자막 길이 초과 블록 (한 줄 20자 기준)"""
    long_subs = []
    for block in blocks:
        text = block['text']
        clean = re.sub(r'<[^>]+>', '', text)

        for line in clean.split('\n'):
            line = line.strip()
            if line.startswith('-'):
                line = line[1:].strip()
            # 순수 한국어+숫자+기호 길이
            display_len = len(line)
            if display_len > 25:
                long_subs.append({
                    'id': block['id'],
                    'time': block['start'],
                    'text': line,
                    'length': display_len,
                })
    return long_subs

def find_repetitive_translations(blocks):
    """AI 반복 패턴 (동일 표현 연속 3회 이상)"""
    # 짧은 번역 표현 추적
    short_phrases = []
    for block in blocks:
        text = re.sub(r'<[^>]+>', '', block['text']).strip()
        if len(text) < 15:
            short_phrases.append((block['id'], text))

    repetitions = []
    for i in range(2, len(short_phrases)):
        if (short_phrases[i][1] == short_phrases[i-1][1] == short_phrases[i-2][1]
            and len(short_phrases[i][1]) > 2):
            repetitions.append({
                'ids': [short_phrases[i-2][0], short_phrases[i-1][0], short_phrases[i][0]],
                'text': short_phrases[i][1],
            })
    return repetitions

def find_tag_remnants(blocks):
    """HTML/ASS 태그 잔류물"""
    issues = []
    for block in blocks:
        text = block['text']
        # <i> 태그가 열리고 안 닫히거나, 짝이 안 맞는 경우
        opens = len(re.findall(r'<i>', text, re.I))
        closes = len(re.findall(r'</i>', text, re.I))
        if opens != closes:
            issues.append({
                'id': block['id'],
                'time': block['start'],
                'text': text[:60],
                'issue': f'<i> 태그 불일치 (열림:{opens}, 닫힘:{closes})',
            })
        # ASS 태그 잔류
        ass_tags = re.findall(r'\{\\[^}]+\}', text)
        if ass_tags:
            issues.append({
                'id': block['id'],
                'time': block['start'],
                'text': text[:60],
                'issue': f'ASS 태그 잔류: {ass_tags}',
            })
    return issues

def find_inconsistent_names(blocks):
    """캐릭터 이름 표기 불일치"""
    # 주요 캐릭터 이름 변형 추적
    name_variants = defaultdict(lambda: defaultdict(list))
    name_groups = {
        'Nick': [r'닉', r'니콜라스', r'니크', r'Nick'],
        'Judy': [r'주디', r'주디스', r'Judy'],
        'Bogo': [r'보고', r'보고우', r'Bogo'],
        'Bellwether': [r'벨웨더', r'Bellwether'],
        'Flash': [r'플래시', r'Flash'],
    }

    for block in blocks:
        text = re.sub(r'<[^>]+>', '', block['text'])
        for char_name, variants in name_groups.items():
            for var in variants:
                if re.search(var, text):
                    name_variants[char_name][var].append(block['id'])

    return name_variants

def find_tone_mismatch_with_context(blocks):
    """문맥상 부적절한 톤 감지 (공식 장면에서 반말 등)"""
    # 공식 장면 키워드
    formal_keywords = ['연설', '시민 여러분', '기념', '축하', '발표', '보고합니다',
                       '브리핑', '뉴스', '기자', '방송', '환영합니다']

    issues = []
    casual_endings = [r'야[.!?\s]*$', r'거든[.!?\s]*$', r'잖아[.!?\s]*$', r'하지 마[.!?\s]*$']

    for i, block in enumerate(blocks):
        text = re.sub(r'<[^>]+>', '', block['text'])

        # 주변 5블록에서 공식 장면 키워드 확인
        context = ' '.join(
            re.sub(r'<[^>]+>', '', blocks[j]['text'])
            for j in range(max(0, i-3), min(len(blocks), i+3))
        )

        is_formal = any(kw in context for kw in formal_keywords)

        if is_formal:
            for pat in casual_endings:
                if re.search(pat, text):
                    issues.append({
                        'id': block['id'],
                        'time': block['start'],
                        'text': text[:60],
                        'issue': '공식 장면 근처에서 반말 사용',
                    })
                    break

    return issues

def main():
    filepath = sys.argv[1] if len(sys.argv) > 1 else r"C:\Vibe Coding\rename\주토피아 2 (2025)_Eng_ko_20260215_000818.srt"

    print("=" * 80)
    print("  번역 품질 심층 분석 (Translation Quality Deep Analyzer)")
    print("=" * 80)

    blocks = parse_srt(filepath)
    print(f"\n총 {len(blocks)}개 블록\n")

    # 1. 중복 블록
    print("-" * 80)
    print("  [1] 중복/반복 블록")
    print("-" * 80)
    dupes = find_duplicate_blocks(blocks)
    exact = [d for d in dupes if d['type'] == 'exact']
    partial = [d for d in dupes if d['type'] == 'partial']
    print(f"  완전 동일: {len(exact)}개, 부분 중복: {len(partial)}개")
    for d in exact:
        print(f"  #{d['ids'][0]}=#{d['ids'][1]} [{d['time']}] \"{d['text']}\"")
    for d in partial[:10]:
        print(f"  #{d['ids'][0]}~#{d['ids'][1]} [{d['time']}] (부분) \"{d['text']}\"")

    # 2. 번역투/직역투
    print(f"\n{'=' * 80}")
    print("  [2] 번역투/직역투 표현")
    print(f"{'=' * 80}")
    translationese = find_translationese(blocks)
    issue_types = Counter(t['issue'] for t in translationese)
    print(f"  총 {len(translationese)}개 감지")
    print(f"\n  유형별:")
    for issue, count in issue_types.most_common():
        print(f"    {issue}: {count}개")
    print(f"\n  상세 (상위 30개):")
    for t in translationese[:30]:
        print(f"  #{t['id']} [{t['time']}] {t['issue']}")
        print(f"    \"{t['text']}\"")

    # 3. 긴 자막
    print(f"\n{'=' * 80}")
    print("  [3] 자막 길이 초과 (25자 이상)")
    print(f"{'=' * 80}")
    long_subs = find_long_subtitles(blocks)
    print(f"  초과 블록: {len(long_subs)}개")
    for ls in long_subs[:20]:
        print(f"  #{ls['id']} [{ls['time']}] ({ls['length']}자) \"{ls['text']}\"")

    # 4. AI 반복 패턴
    print(f"\n{'=' * 80}")
    print("  [4] AI 반복 패턴 (동일 표현 3회 연속)")
    print(f"{'=' * 80}")
    reps = find_repetitive_translations(blocks)
    print(f"  반복: {len(reps)}개")
    for r in reps:
        print(f"  #{r['ids']}: \"{r['text']}\"")

    # 5. 태그 잔류
    print(f"\n{'=' * 80}")
    print("  [5] 태그 잔류물")
    print(f"{'=' * 80}")
    tags = find_tag_remnants(blocks)
    print(f"  태그 이슈: {len(tags)}개")
    for t in tags[:15]:
        print(f"  #{t['id']} [{t['time']}] {t['issue']}")
        print(f"    \"{t['text']}\"")

    # 6. 캐릭터 이름 불일치
    print(f"\n{'=' * 80}")
    print("  [6] 캐릭터 이름 표기")
    print(f"{'=' * 80}")
    names = find_inconsistent_names(blocks)
    for char, variants in names.items():
        if len(variants) > 1:
            print(f"\n  {char}:")
            for var, ids in variants.items():
                print(f"    '{var}': {len(ids)}회 (#{ids[0]}~#{ids[-1]})")

    # 7. 문맥 톤 불일치
    print(f"\n{'=' * 80}")
    print("  [7] 공식 장면 근처 반말 사용")
    print(f"{'=' * 80}")
    tone_issues = find_tone_mismatch_with_context(blocks)
    print(f"  이슈: {len(tone_issues)}개")
    for t in tone_issues[:15]:
        print(f"  #{t['id']} [{t['time']}] {t['text']}")

    # 종합
    print(f"\n{'=' * 80}")
    print("  [종합 번역 품질 보고서]")
    print(f"{'=' * 80}")
    print(f"  중복 블록: {len(dupes)}개")
    print(f"  번역투/직역투: {len(translationese)}개")
    print(f"  길이 초과: {len(long_subs)}개")
    print(f"  AI 반복: {len(reps)}개")
    print(f"  태그 잔류: {len(tags)}개")
    print(f"  이름 불일치: {sum(1 for v in names.values() if len(v) > 1)}개 캐릭터")
    print(f"  공식장면 톤 불일치: {len(tone_issues)}개")

if __name__ == '__main__':
    main()
