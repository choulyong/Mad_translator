"""번역 SRT 품질 전수 분석 스크립트"""
import re
import sys
import io
from pathlib import Path
from collections import Counter

# Windows 콘솔 UTF-8 강제
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

# ── SRT 파서 ──
def parse_srt(filepath: str) -> list[dict]:
    """SRT 파일을 파싱하여 블록 리스트 반환"""
    blocks = []
    with open(filepath, 'r', encoding='utf-8-sig') as f:
        content = f.read()

    # SRT 블록 분리
    raw_blocks = re.split(r'\n\s*\n', content.strip())
    for raw in raw_blocks:
        lines = raw.strip().split('\n')
        if len(lines) < 2:
            continue
        try:
            idx = int(lines[0].strip())
        except ValueError:
            continue

        # 타임코드
        timecode = lines[1].strip() if len(lines) > 1 else ""
        # 텍스트 (나머지 줄 전부)
        text = '\n'.join(lines[2:]).strip() if len(lines) > 2 else ""

        blocks.append({
            'id': idx,
            'timecode': timecode,
            'text': text,
        })
    return blocks


# ── 1. 마침표 잔류 검사 ──
def check_period_residual(blocks: list[dict]) -> list[dict]:
    """자막에 마침표(.)가 남아있는 블록 찾기. 말줄임(..., …)은 제외"""
    issues = []
    for b in blocks:
        text = b['text'].rstrip()
        if not text:
            continue
        # 각 줄 검사
        for line in text.split('\n'):
            line = line.rstrip()
            if not line:
                continue
            # 말줄임 제거 후 검사
            clean = line.replace('...', '').replace('…', '')
            # 마침표가 남아있으면 (줄 끝 또는 중간)
            if '.' in clean:
                issues.append({
                    'id': b['id'],
                    'text': line,
                    'severity': '치명',
                })
    return issues


# ── 2. 말투 급변 (존대↔반말 널뛰기) ──
HONORIFIC_ENDINGS = re.compile(
    r'(습니다|습니까|세요|셔요|십시오|시오|에요|이에요|해요|예요|죠|지요|나요|까요|할게요|볼게요|할래요|드릴게요|겠습니다|됩니다|합니다|입니다|입니까|주세요|하세요|드려요|올게요|갈게요|보세요|가세요|오세요)[.?!~…]*$'
)
BANMAL_ENDINGS = re.compile(
    r'(해|돼|야|지|냐|나|자|래|거야|거지|잖아|거든|다고|라고|는데|건데|할게|볼게|갈게|줄게|는거야|인거야|한거야|된거야|할거야|간다|온다|한다|된다|만든다|보낸다|간거야|할래|뭐야|거야|잖아|걸|거든|는걸|거라고|거잖아|어|네|군|구나|다|까)[.?!~…]*$'
)

def classify_speech(text: str) -> str:
    """텍스트의 말투 분류: honorific / banmal / unknown"""
    # 마지막 줄 기준으로 판단
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    if not lines:
        return 'unknown'

    last_line = lines[-1]
    # 효과음/태그 등은 무시
    if last_line.startswith('[') or last_line.startswith('(') or last_line.startswith('♪'):
        return 'unknown'

    if HONORIFIC_ENDINGS.search(last_line):
        return 'honorific'
    if BANMAL_ENDINGS.search(last_line):
        return 'banmal'
    return 'unknown'


def check_speech_flip(blocks: list[dict]) -> list[dict]:
    """연속 블록에서 말투가 급변하는 경우 감지

    오탐 제거 로직:
    1. 블록 간 거리 5 이상 → 다른 화자로 간주 (스킵)
    2. 대시(-) 시작 블록 → 다중 화자 장면 (스킵)
    3. 연속 2블록 이내에서 같은 화자가 급변한 것만 잡기
    """
    issues = []
    prev_style = 'unknown'
    prev_id = 0
    prev_text = ''

    for b in blocks:
        text = b['text']
        style = classify_speech(text)

        if style != 'unknown' and prev_style != 'unknown':
            if style != prev_style:
                block_gap = b['id'] - prev_id

                # 오탐 필터 1: 블록 간 거리가 5 이상이면 다른 화자
                if block_gap >= 5:
                    prev_style = style
                    prev_id = b['id']
                    prev_text = text
                    continue

                # 오탐 필터 2: 대시(-)로 시작하는 다중 화자 블록
                lines = [l.strip() for l in text.split('\n') if l.strip()]
                prev_lines = [l.strip() for l in prev_text.split('\n') if l.strip()]
                has_dash_curr = any(l.startswith('-') for l in lines)
                has_dash_prev = any(l.startswith('-') for l in prev_lines)
                if has_dash_curr or has_dash_prev:
                    prev_style = style
                    prev_id = b['id']
                    prev_text = text
                    continue

                # 오탐 필터 3: 전형적 화자 교체 패턴
                # 이전 블록이 존대(공식 발언)이고 현재가 반말(사적 대화)이면서
                # 블록 갭이 2 이상이면 화자 교체 가능성 높음
                if block_gap >= 2:
                    prev_style = style
                    prev_id = b['id']
                    prev_text = text
                    continue

                issues.append({
                    'id': b['id'],
                    'prev_id': prev_id,
                    'prev_style': prev_style,
                    'curr_style': style,
                    'prev_text': prev_text[-40:],
                    'curr_text': text[-40:],
                    'severity': '중요',
                })
        if style != 'unknown':
            prev_style = style
            prev_id = b['id']
            prev_text = text
    return issues


# ── 3. 번역투/직역체 검사 ──
TRANSLATIONESE_PATTERNS = [
    (re.compile(r'그것은\s'), '그것은~'),
    (re.compile(r'이것은\s'), '이것은~'),
    (re.compile(r'그녀는\s'), '그녀는~'),
    (re.compile(r'그녀가\s'), '그녀가~'),
    (re.compile(r'그녀를\s'), '그녀를~'),
    (re.compile(r'그녀의\s'), '그녀의~'),
    (re.compile(r'나는\s(?!아니다|모른다)'), '나는~ (구어에서 "난" 선호)'),
    (re.compile(r'너는\s'), '너는~ (구어에서 "넌" 선호)'),
    (re.compile(r'우리는\s'), '우리는~ (구어에서 "우린" 선호)'),
    (re.compile(r'당신은\s'), '당신은~'),
    (re.compile(r'당신의\s'), '당신의~'),
    (re.compile(r'그들은\s'), '그들은~'),
    (re.compile(r'그들의\s'), '그들의~'),
    (re.compile(r'하는 것이\s'), '하는 것이~ (딱딱)'),
    (re.compile(r'할 수 있는\s'), '할 수 있는~ (문어체)'),
    (re.compile(r'라고 생각한다'), '~라고 생각한다 (문어체)'),
    (re.compile(r'에 대해서\s'), '에 대해서~ (번역투)'),
    (re.compile(r'하고 있는 중'), '하고 있는 중 (영어식 진행형)'),
]

def check_translationese(blocks: list[dict]) -> list[dict]:
    issues = []
    for b in blocks:
        # 효과음 태그 내부 텍스트 제외 (♪...♪, [...], (...))
        clean_text = re.sub(r'♪[^♪]*♪|\[[^\]]*\]|\([^)]*\)', '', b['text'])
        for pat, label in TRANSLATIONESE_PATTERNS:
            if pat.search(clean_text):
                issues.append({
                    'id': b['id'],
                    'pattern': label,
                    'context': b['text'][:60],
                    'severity': '중요',
                })
    return issues


# ── 4. 영어 잔류 검사 ──
# 고유명사 허용 목록 (주토피아 + 범용)
ALLOWED_ENGLISH = {
    'ok', 'no', 'yes', 'oh', 'wow', 'hey', 'bye', 'hi',
    'zpd', 'zootopia', 'judy', 'nick', 'hopps', 'wilde',
    'bellwether', 'lionheart', 'bogo', 'clawhauser',
    'flash', 'otterton', 'finnick', 'gazelle',
    'tv', 'dna', 'gps', 'snl', 'fbi', 'cia', 'vip',
    'dj', 'mc', 'vs', 'wifi', 'sns', 'id', 'app',
    'v.o.', 'sfx', 'bgm',
}

def check_english_residual(blocks: list[dict]) -> list[dict]:
    issues = []
    # 영어 단어 2개 이상 연속이면 잔류로 판단
    eng_phrase = re.compile(r'[A-Za-z]{2,}(?:\s+[A-Za-z]{2,})+')
    # 단일 영어 단어 (3글자 이상, 허용 목록 외)
    eng_word = re.compile(r'\b[A-Za-z]{3,}\b')

    for b in blocks:
        text = b['text']
        # HTML 태그 제거 + 효과음 태그 안은 무시
        clean = re.sub(r'</?[a-zA-Z][^>]*>', '', text)
        clean = re.sub(r'\[.*?\]|\(.*?\)|♪.*?♪', '', clean)

        # 영어 구절 검사 (2단어 이상)
        for m in eng_phrase.finditer(clean):
            phrase = m.group().strip()
            words = phrase.lower().split()
            if not all(w in ALLOWED_ENGLISH for w in words):
                issues.append({
                    'id': b['id'],
                    'english': phrase,
                    'context': text[:60],
                    'severity': '치명',
                })

        # 단일 영어 단어 (허용 목록 외, 대문자 시작 = 고유명사 가능성 → 경미)
        for m in eng_word.finditer(clean):
            word = m.group()
            if word.lower() in ALLOWED_ENGLISH:
                continue
            # 이미 구절로 잡힌 것은 스킵
            if any(word in iss.get('english', '') for iss in issues if iss['id'] == b['id']):
                continue
            # 대문자 시작 = 아마 고유명사
            if word[0].isupper():
                continue
            issues.append({
                'id': b['id'],
                'english': word,
                'context': text[:60],
                'severity': '중요',
            })
    return issues


# ── 5. 중복 블록 검사 ──
def check_duplicates(blocks: list[dict]) -> list[dict]:
    """연속 3개 이상 동일 번역 반복"""
    issues = []
    streak = 1
    prev_text = ''
    streak_start = 0

    for b in blocks:
        text = b['text'].strip()
        if not text:
            streak = 0
            prev_text = ''
            continue

        if text == prev_text:
            streak += 1
        else:
            if streak >= 3:
                issues.append({
                    'start_id': streak_start,
                    'end_id': b['id'] - 1,
                    'count': streak,
                    'text': prev_text[:40],
                    'severity': '중요',
                })
            streak = 1
            streak_start = b['id']
        prev_text = text

    # 마지막 streak 체크
    if streak >= 3:
        issues.append({
            'start_id': streak_start,
            'end_id': blocks[-1]['id'],
            'count': streak,
            'text': prev_text[:40],
            'severity': '중요',
        })
    return issues


# ── 6. 추가: 혼용 블록 (한 블록 안에 존대+반말 섞임) ──
def check_mixed_speech_in_block(blocks: list[dict]) -> list[dict]:
    """한 블록 내에서 존대와 반말이 섞인 경우"""
    issues = []
    for b in blocks:
        lines = [l.strip() for l in b['text'].split('\n') if l.strip()]
        if len(lines) < 2:
            continue
        styles = set()
        for line in lines:
            if line.startswith('[') or line.startswith('(') or line.startswith('♪') or line.startswith('-'):
                continue
            s = classify_speech(line)
            if s != 'unknown':
                styles.add(s)
        if len(styles) > 1:
            issues.append({
                'id': b['id'],
                'text': b['text'][:60],
                'severity': '치명',
            })
    return issues


# ── 메인 ──
def main():
    if len(sys.argv) < 2:
        # 기본 파일
        srt_path = r"C:\Vibe Coding\rename\주토피아 2 (2025)_Eng_ko_20260215_012939.srt"
    else:
        srt_path = sys.argv[1]

    if not Path(srt_path).exists():
        print(f"[ERROR] 파일 없음: {srt_path}")
        sys.exit(1)

    print(f"=== 번역 품질 전수 분석 ===")
    print(f"파일: {Path(srt_path).name}")

    blocks = parse_srt(srt_path)
    total = len(blocks)
    print(f"총 블록: {total}개\n")

    # 1. 마침표 잔류
    print("━" * 60)
    print("1. 마침표(.) 잔류")
    print("━" * 60)
    periods = check_period_residual(blocks)
    if periods:
        for p in periods[:30]:
            print(f"  #{p['id']:4d} [{p['severity']}] ...{p['text'][-30:]}")
        if len(periods) > 30:
            print(f"  ... 외 {len(periods) - 30}건")
    else:
        print("  ✓ 없음")
    print(f"  합계: {len(periods)}건\n")

    # 2. 말투 급변
    print("━" * 60)
    print("2. 말투 급변 (연속 블록 존대↔반말)")
    print("━" * 60)
    flips = check_speech_flip(blocks)
    if flips:
        for f in flips[:30]:
            print(f"  #{f['prev_id']:4d}→#{f['id']:4d} [{f['severity']}] {f['prev_style']}→{f['curr_style']}")
            print(f"         이전: ...{f['prev_text']}")
            print(f"         현재: ...{f['curr_text']}")
        if len(flips) > 30:
            print(f"  ... 외 {len(flips) - 30}건")
    else:
        print("  ✓ 없음")
    print(f"  합계: {len(flips)}건\n")

    # 2-1. 블록 내 혼용
    print("━" * 60)
    print("2-1. 블록 내 존대/반말 혼용")
    print("━" * 60)
    mixed = check_mixed_speech_in_block(blocks)
    if mixed:
        for m in mixed[:20]:
            print(f"  #{m['id']:4d} [{m['severity']}] {m['text']}")
        if len(mixed) > 20:
            print(f"  ... 외 {len(mixed) - 20}건")
    else:
        print("  ✓ 없음")
    print(f"  합계: {len(mixed)}건\n")

    # 3. 번역투
    print("━" * 60)
    print("3. 번역투/직역체")
    print("━" * 60)
    trans = check_translationese(blocks)
    if trans:
        for t in trans[:30]:
            print(f"  #{t['id']:4d} [{t['severity']}] {t['pattern']}: {t['context']}")
        if len(trans) > 30:
            print(f"  ... 외 {len(trans) - 30}건")
    else:
        print("  ✓ 없음")
    print(f"  합계: {len(trans)}건\n")

    # 패턴별 통계
    if trans:
        print("  [패턴별 분포]")
        pat_counts = Counter(t['pattern'] for t in trans)
        for pat, cnt in pat_counts.most_common():
            print(f"    {pat}: {cnt}건")
        print()

    # 4. 영어 잔류
    print("━" * 60)
    print("4. 영어 잔류")
    print("━" * 60)
    eng = check_english_residual(blocks)
    if eng:
        for e in eng[:30]:
            print(f"  #{e['id']:4d} [{e['severity']}] \"{e['english']}\" → {e['context']}")
        if len(eng) > 30:
            print(f"  ... 외 {len(eng) - 30}건")
    else:
        print("  ✓ 없음")
    print(f"  합계: {len(eng)}건\n")

    # 5. 중복 블록
    print("━" * 60)
    print("5. 중복 블록 (연속 3+)")
    print("━" * 60)
    dups = check_duplicates(blocks)
    if dups:
        for d in dups:
            print(f"  #{d['start_id']}~#{d['end_id']} [{d['severity']}] {d['count']}회 반복: \"{d['text']}\"")
    else:
        print("  ✓ 없음")
    print(f"  합계: {len(dups)}건\n")

    # ── 요약 ──
    print("=" * 60)
    print("요약")
    print("=" * 60)
    print(f"  {'항목':<30} {'건수':>6}  {'심각도'}")
    print(f"  {'-'*30} {'-'*6}  {'-'*10}")
    print(f"  {'마침표 잔류':<28} {len(periods):>6}  치명")
    print(f"  {'말투 급변 (블록간)':<26} {len(flips):>6}  중요")
    print(f"  {'블록 내 혼용':<28} {len(mixed):>6}  치명")
    print(f"  {'번역투/직역체':<27} {len(trans):>6}  중요")
    print(f"  {'영어 잔류':<29} {len(eng):>6}  치명/중요")
    print(f"  {'중복 블록':<29} {len(dups):>6}  중요")
    print(f"  {'-'*30} {'-'*6}")
    total_issues = len(periods) + len(flips) + len(mixed) + len(trans) + len(eng) + len(dups)
    print(f"  {'총 이슈':<29} {total_issues:>6}")
    print(f"\n  총 블록: {total}개 | 이슈율: {total_issues/total*100:.1f}%")


if __name__ == '__main__':
    main()
