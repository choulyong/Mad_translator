# 번역 프롬프트 파이프라인 최적화 기록

> 날짜: 2026-02-13
> 목표: 토큰 30-40% 절약 + 규칙 충돌 해결 + 품질 검증 자동화

---

## 1. 변경 전 문제점

### 1-1. 말투 기본값 충돌
- `universal_speech_consistency.py`: "불확실하면 존댓말 (안전)"
- `prompt_addon_v4.py`: "불확실하면 반말 기본"
- 두 모듈이 동시에 system_instruction에 포함 → AI가 혼란

### 1-2. Deep-Dive 15개 모듈 전체 포함
- 매 번역 배치마다 15개 모듈 전부 토큰 소모
- 이 중 7개는 다른 모듈과 중복

### 1-3. system_instruction ~10,000+ 토큰
- 시놉시스 300자 제한으로 맥락 부족
- prev_context 5개(프론트)/15개(백엔드)로 연속성 한계
- 품질 검사기가 메인 /batch-translate에서 미사용

---

## 2. 변경 내역 (6개 파일)

### Phase 1: 말투 기본값 통일

**파일**: `app/core/universal_speech_consistency.py`

| 항목 | 변경 전 | 변경 후 |
|------|---------|---------|
| UNIVERSAL_SPEECH_COMPACT | 5단계, "불확실→기존 유지" | 6단계 결정 프로세스 + 문제상황 가이드 |
| UNIVERSAL_SPEECH_FULL | "불확실→존댓말(안전)" | "불확실→반말 기본, 존댓말은 근거 필요" |
| 관계별 기본 말투 | 연인: 친밀도에 따라 | 연인/부부: 서로 반말 |
| 적대 관계 | 없음 | 적대/무시: 반말 추가 |
| 말투 마커 | ~요,~세요,~습니다,~습니까 / ~해,~야,~어,~지,~냐 | +~시죠,~ㄹ게요 / +~니,~자 |

**핵심 변경 — 6단계 결정 프로세스**:
```
① 화자/청자 식별
② 기존 말투 있나? → YES → 유지
③ character_relations → 따르기
④ 관계 추론 (호칭/원문 어조/상황)
⑤ 불확실 → 반말 기본 (존댓말은 확실한 근거만)
```

**문제 상황 가이드 추가**:
- 화자 불명 → 이전 대화 흐름에서 추론
- 원문 톤 변화 → 관계 변화 이벤트 없으면 기존 말투 유지
- 감정 폭발 → 원문에 명시적이면 일시적 전환, 아니면 어조로 표현
- 새 캐릭터 → 관계 파악 후 결정, 한번 정하면 유지

---

### Phase 2: 프롬프트 중복 제거

**파일**: `app/core/subtitle_translation_prompt.py`

| 항목 | 변경 전 | 변경 후 |
|------|---------|---------|
| COMPACT_TRANSLATION_PROMPT | 말투 규칙 + 번역투 제거 + 포맷 (중복) | 포맷 + 고유명사만 (핵심만) |

**제거된 중복 내용**:
- "번역투 제거" → `natural_korean_translation.py`에서 담당
- "말투 규칙" → `universal_speech_consistency.py`에서 담당
- "캐릭터 말투 일관성 유지" → 위와 동일

**파일**: `app/services/vertex_ai.py`

| 항목 | 변경 |
|------|------|
| import | `speech_level_enforcement` import 제거 (미사용) |

---

### Phase 3: Deep-Dive 15→8 선별

**파일**: `app/services/translation_rules.py`

#### 유지 (8개) — 다른 모듈과 중복 없는 고유 규칙

| 모듈 | 이유 |
|------|------|
| `BATCH_CONTEXT_RULES` | 배치 간 연속성 (유일) |
| `SIMULTANEOUS_SPEECH` | 동시대화/전화/속삭임 (유일) |
| `NONVERBAL_EXPRESSIONS` | 한국어 의성어/의태어 (유일) |
| `NUMBER_AND_UNIT_RULES` | 숫자/단위 한국화 (유일) |
| `FOREIGN_LANGUAGE_RULES` | 외국어/방언 처리 (유일) |
| `ERROR_PREVENTION` | 오역 방지 패턴 (유일) |
| `QUALITY_CHECKLIST` | 자가 검증 (유일) |
| `UNTRANSLATABLE_HANDLING` | 번역 불가 처리 (유일) |

#### 제거 (7개) — 다른 모듈과 중복

| 제거 모듈 | 대체하는 곳 | 커버리지 |
|----------|-----------|---------|
| `SUBTITLE_FORMAT_RULES` | master prompt 섹션 2 (출력 포맷) | 100% — 동일 내용 |
| `POLITENESS_SYSTEM` | `UNIVERSAL_SPEECH_COMPACT` 6단계 + `ANTI_HONORIFIC_DEFAULT` | 100% (개선됨) |
| `CHARACTER_ARCHETYPES` | `personas` (전략 기획서에서 캐릭터별 직접 전달) | 100% |
| `TECHNICAL_TERMS` | `fixed_terms` (전략 기획서 고정 용어) | 100% |
| `INTERNET_SLANG_RULES` | 영화/드라마에서 등장 빈도 극히 낮음 | 영향 미미 |
| `MUSIC_AND_LYRICS` | master prompt 섹션 5-5 (♪ 기호 유지, 의역, 리듬감) | ~80% |
| `EMOTION_EXPRESSION` | `natural_korean_translation.py` EMOTION_NUANCE + `prompt_addon_v4.py` EMOTIONAL_RULES | ~80% |

**base_prompt에서 SPEECH_CONSISTENCY 제거**:
```python
# 변경 전:
base_prompt = BASIC_PRINCIPLES + SPEECH_CONSISTENCY + HONORIFIC_RULES + AVOID_LITERAL + TYPO_CORRECTION + genre_section

# 변경 후:
base_prompt = BASIC_PRINCIPLES + HONORIFIC_RULES + AVOID_LITERAL + TYPO_CORRECTION + genre_section
```
이유: `SPEECH_CONSISTENCY`는 `universal_speech_consistency.py`의 `UNIVERSAL_SPEECH_COMPACT`와 완전 중복.

---

### Phase 4: vertex_ai.py 개선

**파일**: `app/services/vertex_ai.py`

#### 4-1. 시놉시스 300→800자

```python
# 변경 전:
[시놉시스]: {synopsis[:300] if synopsis else '정보 없음'}

# 변경 후:
[시놉시스]: {synopsis[:800] if synopsis else '정보 없음'}
```

이유: 300자로는 영화 줄거리의 핵심 맥락이 잘림. 800자로 확대하여 캐릭터 관계/전개 파악 향상.

#### 4-2. thinking_budget 조건부 활성화

```python
# 변경 전:
def make_api_call():
    ... "thinking_config": {"thinking_budget": 0} ...

# 변경 후:
def make_api_call(attempt=0, max_retries=MAX_RETRIES):
    use_thinking = (attempt >= max_retries - 1)  # 마지막 시도에만
    thinking_config = {"thinking_budget": 1024} if use_thinking else {"thinking_budget": 0}
```

동작: 1차, 2차 시도 → thinking OFF (속도 우선). 마지막 3차 시도 → thinking ON (품질 우선).
`_retry_with_backoff`도 수정: `func(attempt=attempt, max_retries=max_retries)` 인자 전달.

#### 4-3. prev_context 백엔드 15→20

```python
# 변경 전:
for p in prev_context[-15:]

# 변경 후:
for p in prev_context[-20:]
```

이유: 더 많은 이전 번역 컨텍스트로 캐릭터 관계/말투 파악 향상.

---

### Phase 5: 품질 검증 연동

**파일**: `app/api/subtitles.py`

`/batch-translate` 엔드포인트에 품질 검사 추가:

```python
# 번역 결과 파싱 후, return 전에:
quality_summary = None
try:
    # 1. 번역 결과를 품질 검사 형식으로 변환
    quality_subs = [{"id": block["index"], "en": block["text"], "ko": trans_text} for ...]

    # 2. TranslationQualityChecker로 검사
    checker = TranslationQualityChecker()
    report = checker.check_quality(quality_subs)

    # 3. 슬래시 오류 자동 수정
    if report.slash_errors:
        fixed_subs, fix_count = checker.auto_fix_slash_errors(quality_subs)
        # parsed_translations에 수정 반영

    # 4. 요약 생성
    quality_summary = {
        "untranslated_count": ...,
        "untranslated_indices": [...],
        "translation_smell_count": ...,
    }
except Exception as qe:
    quality_summary = {"error": str(qe)}  # non-fatal
```

응답에 `"quality": quality_summary` 필드 추가 (기존 필드 유지, 하위호환).

---

### Phase 6: 프론트엔드 prev_context 5→10

**파일**: `lib/services/translation-service.ts` (rename 프로젝트)

```typescript
// 변경 전:
const contextSize = 5;

// 변경 후:
const contextSize = 10;
```

이유: 이전 배치 컨텍스트 5개 → 10개로 확대. 더 많은 이전 번역을 참조하여 말투/호칭/톤 연속성 향상.

---

## 3. 현재 번역 파이프라인 전체 구조

### system_instruction 조합 순서 (vertex_ai.py translate_batch)

```
1. "당신은 넷플릭스/디즈니+ 수준의 전문 영상 번역가입니다."

2. master_translation_prompt (COMPACT)
   └─ subtitle_translation_prompt.py → 포맷 + 고유명사 규칙

3. natural_korean_rules (COMPACT)
   └─ natural_korean_translation.py → 번역투 제거 + 구어체 변환

4. v4_addon_prompt (COMPACT)
   └─ prompt_addon_v4.py → 존댓말 과다 방지 + 자막 경제성 + 마침표 + 대명사

5. speech_enforcement (COMPACT)
   └─ universal_speech_consistency.py → 6단계 말투 결정 프로세스

6. character_relations_section (있으면)
   └─ 전략 기획서에서 직접 전달

7. confirmed_speech_section (있으면)
   └─ 이전 배치에서 확정된 말투

8. 작품 정보
   └─ 제목, 장르, 시놉시스(800자)

9. personas + fixed_terms + translation_rules

10. context_section
    └─ 이전 번역 20개 (백엔드) / 10개 (프론트에서 전송)

11. translation_rules_prompt
    └─ translation_rules.py → base_prompt + Deep-Dive 8개 모듈

12. 출력 형식 지시 (JSON 배열)
```

### Deep-Dive 8개 모듈 (translation_rules.py)

```
base_prompt:
  BASIC_PRINCIPLES
  + HONORIFIC_RULES
  + AVOID_LITERAL
  + TYPO_CORRECTION
  + genre_section

deep_dive (include_deep_dive=True):
  + BATCH_CONTEXT_RULES      — 배치 간 연속성
  + SIMULTANEOUS_SPEECH       — 동시대화/전화/속삭임
  + NONVERBAL_EXPRESSIONS     — 의성어/의태어
  + NUMBER_AND_UNIT_RULES     — 숫자/단위 한국화
  + FOREIGN_LANGUAGE_RULES    — 외국어/방언
  + ERROR_PREVENTION          — 오역 방지
  + QUALITY_CHECKLIST         — 자가 검증
  + UNTRANSLATABLE_HANDLING   — 번역 불가 처리
```

---

## 4. 검증 결과

```
Python py_compile: 5/5 파일 OK
  - app/core/universal_speech_consistency.py  ✅
  - app/core/subtitle_translation_prompt.py   ✅
  - app/services/translation_rules.py         ✅
  - app/services/vertex_ai.py                 ✅
  - app/api/subtitles.py                      ✅

TypeScript tsc --noEmit: 에러 0개              ✅
```

---

## 5. 품질 영향 평가

### 개선된 점
- 말투 기본값 충돌 해소 (존댓말 vs 반말 → "반말 기본" 통일)
- 6단계 말투 결정 프로세스로 체계화
- 시놉시스 800자로 맥락 파악 향상
- 마지막 재시도에 thinking 활성화 → 복잡한 번역 품질 향상
- prev_context 확대 → 연속성 향상
- 품질 검증 자동 연동 → 슬래시 오류 즉시 수정

### 미미한 디테일 손실 (2개)
- `MUSIC_AND_LYRICS`: 배경 음악 표기 세부 예시 빠짐 (master prompt 기본 커버)
- `EMOTION_EXPRESSION`: 감정 단계별 한국어 어휘 목록 빠짐 (natural_korean + addon_v4 커버)

### 토큰 절약
- COMPACT 중복 제거: ~200 토큰
- SPEECH_CONSISTENCY 제거: ~300 토큰
- Deep-Dive 7개 모듈 제거: ~5,000+ 토큰
- **총 예상: 30-40% system_instruction 토큰 절약**

---

## 6. 롤백 방법

문제 발생 시 git에서 각 파일 개별 롤백 가능:
```bash
git checkout HEAD~1 -- app/core/universal_speech_consistency.py
git checkout HEAD~1 -- app/core/subtitle_translation_prompt.py
git checkout HEAD~1 -- app/services/translation_rules.py
git checkout HEAD~1 -- app/services/vertex_ai.py
git checkout HEAD~1 -- app/api/subtitles.py
```

프론트엔드:
```bash
cd "C:\Vibe Coding\rename"
git checkout HEAD~1 -- lib/services/translation-service.ts
```
