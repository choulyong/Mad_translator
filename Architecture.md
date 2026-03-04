# Cinema Engine V5 — Technical Architecture

> **최종 업데이트**: 2026-03-03
> 실제 구현 코드 기준으로 작성된 기술 명세서. 미구현 기능은 포함하지 않음.

---

## 0. 영화 정보 입력 파이프라인 (SRT 업로드 → 번역 시작 전)

번역 시작 전 사용자가 수행하는 준비 단계. 모든 영화 컨텍스트를 수집한다.

```
[SRT 파일 업로드]
    │
    ├── parseSrtContent()          # 프론트엔드에서 직접 파싱 (API 호출 없음)
    │       → SubtitleBlock[]      # {id, start, end, en} 배열 생성
    │
    ├── 파일명에서 영화 제목 추출  # "Movie.Name.2024.srt" → "Movie Name"
    │       → GET /metadata/search?title=...   # TMDB + OMDB + Wikipedia 통합 조회
    │       → metadata 자동 설정
    │
    ├── [선택] 메타데이터 수동 검색  # 제목 입력 → Enter
    │       → GET /metadata/search?title=...
    │
    ├── [선택] GET /subtitles/diagnose-srt
    │       → 블록 수, 복잡도, CPS 통계 진단
    │
    └── POST /subtitles/analyze-strategy
            payload: blocks + metadata (title/genre/synopsis/detailed_plot/wikipedia_plot)
            → AI(Gemini)가 전략 기획서 생성:
              {
                character_personas: [{name, role, personality, relationships, tone_archetype}]
                character_relationships: [{from_char, to_char, speech_level, honorific, note}]
                fixed_terms: [{original, translation}]
                translation_rules: [...]
                content_analysis: {genre, mood, setting, summary}
              }
            → strategyBlueprint에 저장 (Zustand)
```

### 메타데이터 구조 (`MovieMetadata`)

| 필드 | 출처 | 용도 |
|------|------|------|
| `title` | TMDB | 번역 프롬프트 작품 정보 |
| `genre` | TMDB | 장르 룰 선택 |
| `synopsis` | TMDB | 전략서 생성 컨텍스트 |
| `detailed_plot` | OMDB | Pass 1 번역 컨텍스트 |
| `omdb_full_plot` | OMDB | AI-SQA 컨텍스트 |
| `wikipedia_plot` | Wikipedia | 심층 스토리 컨텍스트 |
| `has_wikipedia` | - | wikipedia_plot 유무 플래그 |
| `characters` | TMDB | 등장인물 목록 |
| `director`, `actors` | TMDB/OMDB | 작품 크레딧 |

### 전략서 (`StrategyBlueprint`) → 번역 파이프라인 전체에 전달

```
strategyBlueprint
    ├── character_personas[]          # 캐릭터별 말투 + 관계 + Tone Archetype
    ├── character_relationships[]     # 양방향 관계 맵 {from_char, to_char, speech_level}
    ├── fixed_terms[]                 # 고유명사/고정 용어 {original, translation}
    ├── translation_rules[]           # 특수 번역 규칙
    ├── content_analysis              # 장르/무드/배경
    └── _auto_fixed_terms             # Pass 0.8 Auto-NER 결과 (실행 중 병합)
```

---

## 1. 시스템 개요

**Cinema Engine V5**는 영화 자막을 "번역"이 아닌 "한국어 각색(K-Cinematic Localization)"으로 처리하는 자막 전용 파이프라인입니다.

### 핵심 설계 원칙

| 원칙 | 설명 |
|------|------|
| **Frontend / Backend 역할 분리** | Pass 0~0.8은 프론트엔드, 이후 전체를 백엔드 `/translate-all`에 위임 |
| **Semantic Batching** | 장면 갭(2.5s) + 문장 경계 기반 동적 분할 (20~40블록) |
| **Speaker-Aware Translation** | 화자·청자 식별 후 말투 정책을 번역 프롬프트에 주입 |
| **Global Tone Memory** | 배치 간 톤 축적 → 후속 배치에 주입하여 말투 일관성 유지 |
| **CPS Compression** | 자막 표시 시간 × 14자/초 → 글자수 상한선 인라인 주입 |
| **Rule-Based Post-processing** | LLM 불필요한 규칙(마침표, 금기어, 서식)은 코드로 100% 보정 |
| **Multi-Layer Drift Defense** | 권위/피압박자 말투 잠금을 프롬프트 + 하드픽스 + 자동 감지 3중으로 방어 |

---

## 2. Multi-Pass 파이프라인

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Cinema Engine V5 Pass Flow                          │
└─────────────────────────────────────────────────────────────────────────┘

  ┌─ FRONTEND (translation-service.ts) ────────────────────────────────┐
  │                                                                     │
  │  Pass 0   ── Speaker Identification  → /identify-speakers          │
  │      │       50블록 배치, 화자 태그 + 관계 맵 생성                  │
  │      ▼                                                              │
  │  Pass 0.2 ── Viterbi-like Speaker Sequence Smoothing               │
  │      │       연속 결측 화자 체인 스무딩 (이전/이후 화자 맥락 기반)  │
  │      ▼                                                              │
  │  Pass 0.5 ── Tone Archetype + Addressee + Speech Policy            │
  │      │       ① Tone Archetype(A/B/C/D) 할당                        │
  │      │       ② 청자 추정 (Session Buffer, Main Pair 복구)           │
  │      │       ③ 전략서 + LLM 관계 맵 병합 → 말투 정책 빌드          │
  │      ▼                                                              │
  │  Pass 0.7 ── Context-Aware Filtering                                │
  │      │       영어 공적 호칭(sir/ma'am) → 존대 트랙 강제             │
  │      ▼                                                              │
  │  Pass 0.8 ── Auto-NER (고유명사 자동 추출 + 임시 용어집 병합)       │
  │      │       대문자 연속 단어 스캔 → 3회↑ 등장 Top5 추출            │
  │      │       → strategyBlueprint._auto_fixed_terms에 병합           │
  │      ▼                                                              │
  │  ── POST /subtitles/translate-all ────────────────────────────────  │
  │     payload: blocks + metadata + strategy +                         │
  │              character_relations + confirmed_speech_levels          │
  │     polling: GET /subtitles/translate-status/{job_id}              │
  │              → { status, progress, current_pass, logs, result }    │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ BACKEND (subtitles.py: _run_translation_job) ─────────────────────┐
  │                                                                     │
  │  Pass 0   ── Speaker Identification (필요 시 백엔드 재실행)         │
  │      │       화자 미식별 블록만 선택적 재실행                        │
  │      ▼                                                              │
  │  Pass 0.5 ── Relationship Matrix Extraction (LLM)                  │
  │      │       전략서 없으면 자막에서 직접 관계 추출                  │
  │      ▼                                                              │
  │  A2    ── Emotion Marker Injection                                  │
  │      │       블록별 감정 태그 삽입 (긴장/로맨스/유머 등)            │
  │      ▼                                                              │
  │  Pass 1  ── Semantic Batch Translation  ⚡ Group-Parallel (×5)     │
  │      │       동적 20~40블록, Hard Binding 적용 후 배칭              │
  │      │       실패 배치 자동 재시도 (최대 3회)                        │
  │      ▼                                                              │
  │  Pass 1.5 ── Untranslated Block Recovery (미번역 구제)              │
  │      │       ko 필드 없는 블록 감지 → 소배치 재번역                 │
  │      ▼                                                              │
  │  Pass 2  ── LLM QC 교정  ⚡ 병렬 (×5)                              │
  │      │       40블록 배치, AI-SQA 5축 기준 적용                      │
  │      │       연속 중복 감지 → 재번역 포함                           │
  │      ▼                                                              │
  │  B2.5  ── Tone Consistency Validation                               │
  │      │       화자별 톤 일관성 최종 검증 + 패턴 기반 교정            │
  │      ▼                                                              │
  │  Pass 3  ── Final Hard-Fix + Lexicon + Post-processing             │
  │      │       번역투 어미·명사 교정 + 고정 용어 강제 + 규칙 후처리   │
  │      ▼                                                              │
  │  Pass 4  ── Wordplay Localization                                   │
  │      │       관용구·슬랭·문화 참조 한국어 재창조                    │
  │      ▼                                                              │
  │  AI-SQA  ── 자동 품질 점수                                          │
  │             번역 샘플 20개 → 5축 100점 평가                         │
  │                                                                     │
  └─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 진행률 구간

| Pass | 위치 | 진행률 | 설명 |
|------|------|--------|------|
| Pass 0 | Frontend | 0% → 10% | 화자 식별 (50블록 배치) |
| Pass 0.2 | Frontend | 10% | Viterbi 화자 체인 스무딩 |
| Pass 0.5 | Frontend | 10% → 12% | 청자 추정 + 말투 정책 |
| Pass 0.7 | Frontend | 12% | 공적 호칭 감지 → 양방향 Lock |
| Pass 0.8 | Frontend | 12% | Auto-NER |
| — | Frontend→Backend | 12% | `/translate-all` 호출 |
| Pass 0 (재실행) | Backend | 12% | 화자 미식별 블록 재실행 (조건부) |
| Pass 0.5 | Backend | 12% | 관계 매트릭스 추출 |
| A2 | Backend | 12% | 감정 마커 주입 |
| Pass 1 | Backend | 12% → 80% | 메인 번역 (배치별 비례) |
| Pass 1.5 | Backend | 80% | 미번역 구제 |
| — | Backend | 85% | Pass 1 완료 마커 |
| Pass 2 | Backend | 85% → 95% | QC 교정 (배치별 비례) |
| B2.5 | Backend | 95% | 톤 일관성 검증 |
| Pass 3 | Backend | 96% | 하드픽스 + Lexicon + 후처리 |
| Pass 4 | Backend | 98% | 워드플레이 현지화 |
| AI-SQA | Backend | 99% | 품질 점수 측정 |
| 완료 | Backend | 100% | job["status"] = "complete" |

---

## 4. Frontend Passes

### 4.1 Pass 0: Speaker Identification
**파일**: `lib/services/translation-service.ts` → `POST /subtitles/identify-speakers`

- 전체 자막을 50블록 단위로 분할하여 백엔드에 전송
- 백엔드(Gemini)가 화자를 추론, `speaker` + `speakerConfidence` 반환
- 마지막 배치에서 `generate_relationships: true` → 전체 관계 맵 생성
- 이전 배치 식별 결과(`prev_identified`)를 다음 배치에 전달 (연속성 유지)

```
입력: [블록50개] + 시놉시스 + 페르소나 목록 + prev_identified
출력: { speakers: [{index, speaker, confidence}], relationships: {...} }
```

### 4.2 Pass 0.2: Viterbi-like Speaker Sequence Smoothing
**파일**: `lib/services/translation-service.ts` (Pass 0 직후 실행)

Pass 0에서 AI가 식별하지 못한 연속 결측 화자를 규칙 기반으로 복구한다.

**알고리즘**:
1. `speaker === ""` 또는 `speakerConfidence < 0.3` 인 블록 탐지
2. 앞뒤 블록의 화자 패턴으로 연속성 추론
3. 타임스탬프 갭이 2.5초 미만 + 동일 씬으로 판단 → 이전/다음 화자로 보간
4. 완전히 고립된 결측치 → "UNKNOWN" 유지

```
전후 화자: A → [?] → A  →  [?] = A (단독 화자 단순 보간)
전후 화자: A → [?][?] → B  →  [?] = A, [?] = B (교대 보간)
입력/출력: SubtitleBlock[] (speaker 필드 인플레이스 수정)
완료 로그: "[Pass 0.2] Viterbi 스무딩 완료 (N개 결측 화자 복구됨)"
```

### 4.3 Pass 0.5: Tone Archetype + Addressee + Speech Policy
**파일**: `lib/services/translation-service.ts` (프론트엔드 전용, API 호출 없음)

#### Tone Archetype 할당 (`assignToneArchetypes`)

| Type | 성격 | 선호 어미 | 키워드 |
|------|------|----------|-------|
| **A** | 능청/비꼼/여유 | ~거든, ~지, ~잖아, ~ㄹ걸 | sly, sarcastic, witty |
| **B** | 열정/직설/단호 | ~어, ~야, ~자, ~니? | passionate, direct, brave |
| **C** | 차분/지적/격식 | ~요, ~군요, ~네요, ~습니까 | calm, intellectual, formal |
| **D** | 거침/반항/날것 | ~냐, ~다, ~마, ~라고 | rough, rebellious, villain |

#### 청자 추정 (`estimateAddressees`) — Session Buffer
- `sessionMainPair { a, b }` — 현재 장면의 주요 대화 쌍 추적
- Scene Break 감지(갭 > 2.5초) → `sessionMainPair` 리셋
- **Rule 3 (복구)**: 청자 미정인 화자가 Main Pair 멤버이면 상대방 자동 복구

#### 말투 정책 (`buildSpeechPolicies`)
- Strategy Source (conf 1.0): 전략서 `character_relationships[].speech_level`
- LLM Source (conf 0.8): Pass 0에서 생성된 관계 맵
- 정책 유형: `CASUAL_LOCK` | `HONORIFIC_LOCK` | `UNDETERMINED`
- 결과: `confirmedSpeechLevels` Zustand Store에 저장 → 백엔드에 전달

### 4.4 Pass 0.7: Context-Aware Filtering
**파일**: `lib/services/translation-service.ts`

영어 원문의 호칭(Vocative) 패턴을 감지하여 양방향 말투 Lock을 체결한다.

**감지 패턴**:
```
submissiveVocative:   "yes, sir" / "sorry, captain" → 화자=존댓말, 청자=반말
absoluteSubmissive:   "Sir, ..." / "Captain, ..." → 동일 적용
authoritativeVocative: "listen, prisoner" / "hey, inmate" → 화자=반말, 청자=존댓말
```

- `AUTHORITATIVE_LOCK`: 화자가 권위 캐릭터 → `banmal` + 역방향 `honorific` 자동 잠금
- `SUBMISSIVE_LOCK`: 화자가 피압박자 → `honorific` + 역방향 `banmal` 자동 잠금
- 이미 locked 상태인 pair는 덮어쓰지 않음 (오탐지 방지)

### 4.5 Pass 0.8: Auto-NER
**파일**: `lib/services/translation-service.ts`

```
알고리즘:
1. 전체 자막 블록 순회
2. 문장 중간에 등장하는 대문자 연속 단어 추출 (예: "the Stark Resilient")
   → 정규식: /(?<=[a-z]\s+)([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/g
3. 3회 이상 등장한 Top 5 고유명사 선별
4. "EntityName → EntityName (고유명사 원어 유지)" 형식으로 용어집 생성
5. strategyBlueprint.fixed_terms + auto_fixed_terms 병합
```

백엔드 전달 시 `strategy._auto_fixed_terms` 필드로 포함 → Pass 3 고유명사 표기 통일에 사용

---

## 5. Backend Passes

### 5.1 Pass 0: Speaker Identification (백엔드 재실행)
**파일**: `backend/app/api/subtitles.py:_run_translation_job()`

- **조건**: 전달받은 `blocks` 중 `speaker` 없는 블록이 있을 때만 실행
- 프론트엔드 Pass 0와 동일 로직으로 백엔드에서 보완

### 5.2 Pass 0.5: Relationship Matrix Extraction
**파일**: `backend/app/api/subtitles.py`

- **조건**: `character_relations` 딕셔너리가 비어있을 때만 LLM 추출 실행
- 전략서(`strategy`) 있으면: `character_relationships` 파싱 (즉시 적용)
- 없으면: LLM으로 자막 내용에서 직접 관계 추출
- 결과: `char_relations` dict → 이후 모든 Pass에 주입

```python
char_relations = {
    "TONY → PEPPER": "연인 관계, 서로 반말",
    "TONY → FRIDAY": "상하관계, Tony 반말 Friday 격식체",
    ...
}
```

### 5.3 A2: Emotion Marker Injection
**파일**: `backend/app/api/subtitles.py:_inject_emotion_markers()`

- 블록별 감정 키워드 스캔 → 감정 태그 삽입 (긴장/로맨스/유머/슬픔 등)
- 태그는 Pass 1 번역 프롬프트에서 무드 컬러링에 활용
- 조건부 실행: `A2_ENABLED = True` (기본)

### 5.4 Pass 1: Semantic Batch Translation
**파일**: `backend/app/api/subtitles.py`

#### Hard Binding (Pass 1 전처리)
- `...`나 접속사(and/but/because 등)로 끝나는 분절 자막을 결합하여 배치 경계 오류 방지

#### Semantic Batching
| 조건 | 동작 |
|------|------|
| 블록 간 갭 > 2.5초 AND 현재 배치 ≥ 20 | 장면 전환 분할 |
| 배치 ≥ 40 | 문장 종결점 5개 이내 역탐색 분할 |
| 잔여 ≤ 3개 | 이전 배치에 병합 |

#### 그룹 병렬 실행 (×5)
- 최대 5배치 동시 실행 (`CONCURRENCY = 5`)
- 각 배치에 앞쪽 완료 블록 5개를 `prev_context`로 주입 (배치 경계 단절 방지)
- 실패 배치: `failed_batches` set에 수집 → 자동 재시도 (최대 3회)

#### 말투 메모리 축적 (`_update_confirmed_speech_levels`)
- Pass 1 각 배치 완료 후 실행
- `speaker → addressee` 쌍별로 반말/존댓말 사용 횟수 누적
- **잠금 조건**: 샘플 ≥ 5 + 동일 톤 비율 ≥ 70% → `locked: true`
- 잠긴 레벨은 다음 배치 프롬프트에 강제 주입

```python
progress = 12 + int((completed_batches / total_batches) * 68)  # 12%~80%
```

### 5.5 Pass 1.5: Untranslated Block Recovery (미번역 구제)
**파일**: `backend/app/api/subtitles.py:_run_translation_job()`

Pass 1 완료 직후 실행. Pass 2(QC) 전에 위치하여 구제된 블록도 QC를 거치도록 한다.

```
실행 조건: Pass 1 후 ko 필드가 없거나 공백인 블록 존재 시
감지 기준:
  - block.get("ko", "").strip() == ""
  - 원본 영어(en)가 있는 블록만 대상

구제 방식:
  1. 미번역 블록 수집
  2. 10블록 단위 소배치로 재번역 요청
  3. 동일 프롬프트 구조 사용 (character_relations + confirmed_levels 주입)
  4. 성공 시 blocks[idx]["ko"] 업데이트

로그: "[Pass 1.5] 구제 완료 — N/M개 복구"
```

### 5.6 Pass 2: LLM QC
**파일**: `backend/app/engine/passes/pass_2_qc.py`

#### [번역 실패] 블록 분류 처리 (2026-03-03 추가)
Pass 2 시작 시 `[번역 실패: ...]` 패턴 블록을 자동 분류:

| 분류 | 판정 기준 | 처리 |
|------|----------|------|
| **커버됨** | 앞 1~2개 블록 중 번역 완료 블록 존재 | `ko = ""` (빈 자막 — 앞 블록이 이미 2행 내용 포함 번역) |
| **진짜 실패** | 앞 블록도 번역 실패 또는 없음 | `translate_single_batch()` 재번역 |

**근거**: 2행 자막에서 Pass 1이 1행에 전체 내용을 번역 → 2행은 번역할 내용 없어서 실패 표시 (전체 실패의 ~74%)

- 항상 실행 (V5 정책: 의미오류·번역투 검수 목적)
- 연속 중복 감지 (`curr.ko == prev.ko` AND `curr.en != prev.en`) → 재번역
- 30블록 배치, 최대 7동시 병렬
- `character_relations` + **`confirmed_speech_levels`** 주입 → QC가 캐릭터 관계 + 확정 말투 인지 후 교정

#### AI-SQA 5축 품질 기준 (QC 프롬프트)
| 코드 | 기준 | 배점 |
|------|------|------|
| TI | 번역 의도 & 관용구 보존 | 25점 |
| LS | 언어 스타일 & 번역투 제거 | 25점 |
| RE | 레지스터 동등성 | 20점 |
| SI | 의미 무결성 | 15점 |
| SR | 발화 레지스터 | 15점 |

- **70점 이하**: 교정 제안 필수 / **50점 이하**: 전면 재번역 권고

#### REGISTER CONTRACT (2026-03-03 추가)
`get_v5_qc_prompt()`에 `confirmed_speech_levels` 주입 → QC 시스템 프롬프트 최상단에 말투 잠금 블록 삽입:
```
## [0] REGISTER CONTRACT — 말투 잠금 (최우선 규칙)
  - Nick → Judy: 반말 (절대 변경 금지)
  - Judy → Bogo: 존댓말 (절대 변경 금지)
  ...
```

#### QC 후보정 (규칙 기반)
```python
_remove_translationese()   # 그녀가/그녀의 등 100% 제거
remove_periods()           # 반말 어미 마침표 100% 제거
```

#### 최종 안전망 — srt_generator.py
`generate_srt()` 내 `[번역 실패: ...]` 최종 필터: 이 패턴이 남아있으면 빈 문자열로 출력

### 5.7 B2.5: Tone Consistency Validation (패턴 기반 강화 v2)
**파일**: `backend/app/api/subtitles.py`

- **`_detect_tone_inconsistency()`**: locked pair 전체 스캔 → `_detect_tone_from_korean()`으로 반말/격식 판별 → 불일치 인덱스 수집
- **`_fix_tone_inconsistency_with_patterns()`** (구 `_fix_tone_inconsistency_simple`):
  - 기존(v1): 단순 어미 잘라서 "해요"/"해" 붙이기 → **잘못된 어미 처리** 문제
  - 신규(v2): 모듈 레벨 `_FORMAL_TO_BANMAL_EXT` / `_BANMAL_TO_JONDAEMAL_EXT` **패턴 테이블 직접 재사용** → Pass 3와 동일 정확도
  - pair_key 우선순위: 구체적(`speaker → addressee`) → 일반(`speaker → ?`, `speaker → general`)
  - expected_tone 매핑: `banmal/casual/informal` → 반말 패턴 | `formal/jondaemal/honorific` → 존댓말 패턴
  - **마침표 처리**: 패턴 `$` anchor 대응 — 마침표 임시 제거 → 패턴 적용 → 반말은 마침표 제거, 존댓말은 마침표 복원
- **패턴 테이블 모듈 레벨 상수화**: `_FORMAL_TO_BANMAL_EXT` / `_BANMAL_TO_JONDAEMAL_EXT`를 `_apply_postprocess()` 밖으로 이동 → B2.5와 Pass 3가 동일 패턴 공유

### 5.8 Pass 3: Hard-Fix + Lexicon + Post-processing
**파일**: `backend/app/engine/passes/pass_3_fix.py` + `subtitles.py`

Pass 3는 다음 4단계로 구성된다:

**3-1. Register Stabilizer (Final Hard-Fix)**
`stabilize_register_blocks()` — `confirmed_levels` + `char_relations` 기반으로 전수 어미 교정

**3-2. Lexicon 고정 용어 적용**
`_apply_lexicon_lookup()` — 전역 용어 사전 기반 번역 통일

**3-3. strategy.fixed_terms 고유명사 표기 통일**
`strategy.fixed_terms[]` + `_auto_fixed_terms` 기반 전체 블록 교정
```python
# 영어 포함 고유명사만 대상 (한국어 전용 용어는 건너뜀)
if re.search(r'[A-Za-z]', original):
    blocks[idx]["ko"] = pat.sub(translation, ko)
```

**3-4. 하드코딩 후처리 (`_apply_postprocess()`)**

| 교정 항목 | 설명 |
|-----------|------|
| 반말 마침표 제거 | 반말 어미 뒤 `.` 100% 제거 |
| 금기어 치환 | "생일소년/소녀" 등 패턴 → 자연스러운 한국어 |
| 서식 정규화 | 이중 공백, 앞뒤 공백 제거 |
| Authority Drift Fix | confirmed banmal 화자 → 격식체 사용 시 반말 어미로 교정 |
| Submissive Formal | confirmed honorific 화자 → 반말 사용 시 격식체 교정 |
| 이름표 삭제 | "철수: ..." 형식 이름 태그 제거 |
| 당신 치환 | "당신" → 자연스러운 호칭으로 변환 |

### 5.9 Pass 4: Wordplay Localization
**파일**: `backend/app/engine/passes/pass_4_wp.py`

- 영어 관용구/슬랭/문화 참조를 한국 관객에게 동일한 감정/유머/임팩트로 재창조
- `_detect_wordplay_blocks()` → 후보 인덱스 → 20블록 배치 → LLM 교정
- `changed=true` 블록만 업데이트 (수정 범위 최소화)

### 5.10 AI-SQA: 자동 품질 점수
**파일**: `backend/app/api/subtitles.py:_run_translation_job()`

Pass 4 완료 직후 실행. 전체 번역 결과의 종합 품질을 자동 평가한다.

```python
# 평가 방식
sqa_pool = [번역 완료 블록 전체]
sqa_sample = random.sample(sqa_pool, min(20, len(sqa_pool)))

# 5축 점수 프롬프트 구성
prompt = f"작품: {title}, 장르: {genre}\n{sample_lines}\n\n5축 평가..."

# 응답 구조
{"TI": 23, "LS": 22, "RE": 18, "SI": 14, "SR": 14, "total": 91, "comment": "..."}

# 결과 저장
job["quality_score"] = total_score  # 폴링 응답에 포함
```

---

## 6. 프롬프트 아키텍처

### 6.1 V3 Master System Prompt
**파일**: `backend/app/core/k_cinematic_prompt.py:get_v3_master_system_prompt()`

| 섹션 | 내용 |
|------|------|
| 최우선 목표 | 말투 뒤틀림 제로 + 환각/오역 제로 |
| 출력 형식 | JSON 배열 `[{id, ko}]` 엄격 준수 |
| 환각 방지 | 정보 추가/맥락 추측/고유명사 변형/농담 창작 금지 |
| 말투 우선순위 | ①잠금 → ②정책 → ③Archetype → ④문장신호 → ⑤해요체 |
| 뒤틀림 교정 | 당신 금지, 영어식 주어, 존반 혼용, 번역투 어미 |
| 어미 변주 | 3회 연속 반복 금지, Type별 전환 어미 |
| CPS | 글자수 제한 내 축약 |
| Glossary | 고정 용어 100% 준수 |
| 톤 메모리 | 참조하되 ①~③이 상위 |
| 자기 검증 | 7개 체크리스트 통과 후 출력 |

### 6.2 K-Cinematic Prompt Builder
**파일**: `backend/app/core/k_cinematic_prompt.py:build_v3_cinema_prompt()`

```
build_v3_cinema_prompt()
  ├── get_base_korean_prompt()           # 핵심 번역 원칙
  ├── inject_korean_flavor_rules()       # 어미 변주 (3회 연속 반복 금지)
  ├── get_contextual_adaptation_rules()  # 5축 판단 체계
  ├── get_content_rating_rules()         # 연령 등급별 어휘 수위
  ├── get_genre_override()               # 장르별 룰 (액션/로맨스/법정/시대극)
  ├── format_relationship_titles()       # K-호칭/서열 매핑
  ├── get_slang_localization_rules()     # 관용구/욕설 현지화
  ├── get_glossary_enforcement_rules()   # 고정 용어집 강제
  ├── get_speech_distortion_correction_rules()  # 말투 뒤틀림 교정 (7개 규칙)
  ├── get_tone_archetype_rules()         # Tone Archetype 종결 어미 가중치
  ├── get_lyric_and_visual_rules()       # 가사 입말화 + 독백 시각화
  ├── get_micro_context_switching_rules() # [SIDE_TALK] 방백 톤 스위칭
  ├── get_authoritative_downward_rules() # 하향식 권위 톤 잠금
  ├── get_submissive_formal_rules()      # 피압박자 격식체 강제
  ├── get_vocative_restraint_rules()     # 호칭 과잉 억제
  └── get_mood_overlay()                 # 배치 무드 오버레이
```

### 6.3 메인 번역 프롬프트 구성
```
시스템 프롬프트 =
  ★ V3 Master System Prompt (최상위)
  + k_cinematic (동적 장르·관계·무드 보충)
  + speech_enforcement (화자별 말투 강제)
  + character_relations + confirmed_speech (관계 맵 + 확정 말투)
  + supplementary_rules (짧은 대사, 비언어, 숫자, SRT 포맷)
  + 작품 정보 (제목/장르/시놉시스)
  + 등장인물 및 말투 (페르소나 + <Type X> 태그)
  + 고정 용어 + 번역 규칙
  + 출력 형식 (JSON 배열)
  + 톤 메모리 (이전 배치 축적, 최근 30개)
```

---

## 7. 말투 잠금 시스템

### 7.1 Tone Archetype (9K-1)
| Type | 성격 | 선호 어미 | 전환 어미 |
|------|------|----------|---------|
| A | 능청/비꼼 | ~거든, ~지, ~잖아 | ~든가, ~려나, ~겠지 |
| B | 열정/직설 | ~어, ~야, ~자 | ~잖아, ~라고, ~거야 |
| C | 차분/격식 | ~요, ~군요, ~네요 | ~겠군요, ~인 셈이죠 |
| D | 거침/반항 | ~냐, ~다, ~마 | ~거든, ~든가, ~쯤이야 |

동일 어미 연속 2회 초과 → 전환 어미로 강제 교체.

### 7.2 하향식 권위 톤 잠금 (9K-4) — Drift Defense
- `[AUTHORITATIVE_DOWNWARD]` 잠금 시 반말 트랙 유지
- "습니까/인가요/세요" 등 존대 어미 사용 금지
- **3중 방어**: ①프롬프트(9K-4) + ②Pass 3 하드픽스 + ③Pass 0.7 자동 감지

### 7.3 피압박자 격식체 강제 (9K-5) — Submissive Formal
- 화자가 죄수/포로/피의자 등일 때 해요체 금지, 하십시오체 강제
- **3중 방어**: ①프롬프트(9K-5) + ②Pass 3 하드픽스 + ③Pass 0.7 자동 감지

### 7.4 말투 잠금 자동화 (`_update_confirmed_speech_levels` — Pass 1 중)
- **잠금 조건**: 샘플 ≥ 5 + 동일 톤 비율 ≥ 70% → `locked: true`
- **배치마다 실행**: Pass 1 각 그룹(5배치) 완료 후 호출
- **전략서 잠금**: `strategy.character_relationships.speech_level` → 즉시 locked

### 7.5 ★ 확장 어미 변환 테이블 v2 (Pass 3, 2026-03-03)
**파일**: `backend/app/api/subtitles.py` — 모듈 레벨 상수 `_FORMAL_TO_BANMAL_EXT`, `_BANMAL_TO_JONDAEMAL_EXT`

| 잠금 레벨 | 방향 | 패턴 수 | 처리 방식 |
|-----------|------|---------|---------|
| `banmal` / `casual` | 격식체/해요체 → 반말 | 100개+ | 첫 매칭 패턴 적용, 긴 패턴 우선 |
| `jondaemal` / `honorific` | 반말 → 해요체 | 30개+ | 첫 매칭 패턴 적용 |
| `authoritative_downward` | 격식 의문형 → 반말 | 10개 | 전체 매칭 적용 |
| `submissive_formal` | 해요체 → 합쇼체 | 15개 | 전체 매칭 적용 |

**커버 범위**:
- 의지/제안형: `하겠습니다` → `할게`, `해줄게` 등
- 의무형: `어야 합니다` → `어야 해`
- 과거완료형: `했습니다/봤습니다/갔습니다/먹었습니다` 등 → `~어` 계열
- 미래형: `할 것입니다/할 겁니다` → `할 거야`
- 의문형: `습니까?/했나요?/할까요?` → 반말 의문형
- ㅂ니다 불규칙: `갑니다/봅니다/옵니다/줍니다` → `가/봐/와/줘`
- 해요체 전반: `어요/아요/네요/거든요/잖아요` 등 → 반말 어미
- **미매칭 로그**: 패턴에 없는 어미 감지 시 `⚠ [Pass 3] 말투미매칭` 로그 기록

---

## 8. JSON 파싱 복원력

**파일**: `backend/app/api/subtitles.py:34-170`

Gemini API가 JSON 문자열 내부에 raw 제어 문자를 반환할 경우 6단계 폴백으로 복원:

```
1단계: _sanitize_json() + json.loads()
2단계: json.JSONDecoder(strict=False) — 제어 문자 허용
3단계: 잘린 JSON 복원 → 닫히지 않은 괄호 보정 후 파싱
4단계: 잘린 JSON + strict=False
5단계: (strategy.py) 제어 문자 이스케이프, trailing comma 제거
6단계: (strategy.py) Missing comma 삽입 + 괄호 밸런싱
```

---

## 9. 상태 관리 (Zustand Store)

**파일**: `lib/store/translate-store.ts`

| 상태 | 타입 | 용도 |
|------|------|------|
| `subtitles` | `SubtitleBlock[]` | 전체 자막 배열 |
| `metadata` | `MovieMetadata` | TMDB/OMDB/Wikipedia 통합 메타데이터 |
| `strategyBlueprint` | `StrategyBlueprint` | AI 전략 기획서 |
| `characterRelations` | `Record<string, string>` | Pass 0에서 생성된 관계 맵 |
| `confirmedSpeechLevels` | `Record<string, ConfirmedSpeechLevel>` | 화자→청자 확정 말투 |
| `speakerIdentified` | `boolean` | Pass 0 완료 플래그 |
| `globalToneMemory` | `ToneMemoryEntry[]` | 배치 간 축적 톤 기록 |
| `translationRunning` | `boolean` | 번역 실행 중 플래그 |
| `processingProgress` | `number` | 0~100% 진행률 |

---

## 10. API 엔드포인트

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/metadata/search` | GET | `?title=` TMDB+OMDB+Wikipedia 통합 메타데이터 검색 |
| `/subtitles/diagnose-srt` | POST | SRT 진단 (블록 수, 복잡도) |
| `/subtitles/analyze-strategy` | POST | AI 전략 기획서 생성 |
| `/subtitles/identify-speakers` | POST | Pass 0: 화자 식별 + 관계 맵 생성 |
| `/subtitles/translate-all` | POST | 전체 파이프라인 비동기 실행, `job_id` 반환 |
| `/subtitles/translate-status/{job_id}` | GET | status / progress / current_pass / logs / result |
| `/subtitles/translate-cancel/{job_id}` | DELETE | 진행 중인 번역 취소 |
| `/subtitles/active-job` | GET | 현재 실행 중인 job 조회 |
| `/subtitles/save-translation` | POST | 번역 결과 SRT 파일 저장 |
| `/subtitles/batch-translate` | POST | 단일 배치 번역 (내부용) |

---

## 11. 파일 구조

### 프론트엔드 (`rename/`)

```
lib/
├── services/
│   ├── translation-service.ts    # V5 메인 엔진 (Pass 0~0.8 + /translate-all 위임)
│   └── translation-utils.ts      # 유틸리티 (타임코드, CPS, 무드, 톤 감지)
└── store/
    ├── translate-store.ts        # Zustand 글로벌 스토어
    └── translate-types.ts        # 공유 타입 정의

app/translate/page.tsx            # UI 컴포넌트 (SRT 업로드, 메타데이터, 전략서, 번역 시작)
```

### 백엔드 (`rename/backend/`)

```
app/
├── api/
│   └── subtitles.py              # API 라우터 + _run_translation_job() 오케스트레이터
├── core/
│   └── k_cinematic_prompt.py     # 동적 프롬프트 빌더 (V3 Master + 9A~9K)
├── engine/
│   └── passes/
│       ├── pass_2_qc.py          # LLM QC 교정
│       ├── pass_3_fix.py         # Hard-Fix + Lexicon + 후처리
│       └── pass_4_wp.py          # Wordplay 현지화
└── services/
    ├── vertex_ai.py              # Gemini API 클라이언트
    └── speaker_identifier.py     # 화자 식별 서비스
```

---

## 12. 전체 데이터 흐름 (영화 정보 입력 → 번역 완료)

```
┌──────────────────────────────────────────────────────────────────────┐
│  STEP 1: 영화 정보 입력 (UI: app/translate/page.tsx)                  │
└──────────────────────────────────────────────────────────────────────┘

[SRT 파일 업로드]
    │ parseSrtContent()
    ▼
[SubtitleBlock[] 생성]  ← {id, start, end, en}
    │ 파일명 → 영화 제목 추출
    ▼
[GET /metadata/search?title=...]  ← TMDB + OMDB + Wikipedia
    │
    ▼
[MovieMetadata 저장] → Zustand (title, genre, synopsis, detailed_plot, wikipedia_plot)
    │
    ├── [선택] GET /subtitles/diagnose-srt  → 블록 수/복잡도 확인
    │
    ▼
[POST /subtitles/analyze-strategy]
    payload: blocks (일부) + metadata
    → Gemini: 전략 기획서 생성
    ▼
[StrategyBlueprint 저장] → Zustand
    {character_personas, character_relationships, fixed_terms, translation_rules, content_analysis}


┌──────────────────────────────────────────────────────────────────────┐
│  STEP 2: Frontend Passes (lib/services/translation-service.ts)        │
└──────────────────────────────────────────────────────────────────────┘

[executeTranslation() 호출]
    │
    ├── Pass 0 [0%→10%]: POST /identify-speakers
    │       → 50블록 배치 × N회 → speaker + speakerConfidence
    │       → 마지막 배치: generate_relationships → characterRelations 저장
    │
    ├── Pass 0.2 [10%]: Viterbi Speaker Smoothing
    │       → 결측 화자 체인 보간 (이전/이후 화자 컨텍스트 기반)
    │
    ├── Pass 0.5 [10%→12%]: Archetype + Addressee + Policy (API 없음)
    │       ① assignToneArchetypes() → 페르소나별 A/B/C/D 할당
    │       ② estimateAddressees() → 청자 추정 (Session Buffer)
    │       ③ buildSpeechPolicies() → CASUAL_LOCK / HONORIFIC_LOCK
    │       → confirmedSpeechLevels Zustand 저장
    │
    ├── Pass 0.7 [12%]: Context-Aware Filtering (API 없음)
    │       → "yes, sir" 패턴 감지 → 양방향 말투 Lock 체결
    │
    └── Pass 0.8 [12%]: Auto-NER (API 없음)
            → 대문자 연속 단어 3회↑ Top5 → _auto_fixed_terms 병합


┌──────────────────────────────────────────────────────────────────────┐
│  STEP 3: 백엔드 위임 (POST /subtitles/translate-all)                  │
└──────────────────────────────────────────────────────────────────────┘

payload = {
    blocks: [{id, start, end, en, speaker, addressee}],
    metadata: {title, genre, synopsis, detailed_plot, omdb_full_plot, wikipedia_plot},
    strategy: {character_personas, fixed_terms, translation_rules, _auto_fixed_terms},
    character_relations: {...},          ← Pass 0 LLM 관계 맵
    confirmed_speech_levels: {...},      ← Pass 0.5~0.7 말투 잠금
    options: {include_qc: true}
}
    │
    ▼
응답: {job_id: "abc123def456"}


┌──────────────────────────────────────────────────────────────────────┐
│  STEP 4: Backend 파이프라인 (_run_translation_job)                    │
└──────────────────────────────────────────────────────────────────────┘

job = {status: "running", progress: 0, logs: [], current_pass: "초기화"}
    │
    ├── [조건부] Pass 0: 화자 미식별 블록 재실행
    │
    ├── [조건부] Pass 0.5: 관계 매트릭스 추출
    │       → character_relations 비어있으면 LLM 추출
    │       → 있으면 strategy.character_relationships 파싱
    │
    ├── A2: 감정 마커 주입
    │       → 블록별 긴장/로맨스/유머 태그 삽입
    │
    ├── Pass 1: 시맨틱 배치 번역 [12%→80%]
    │       → Semantic Batching (20~40블록)
    │       → Group-Parallel ×5 동시 번역
    │       → 배치마다 _update_confirmed_speech_levels() → 잠금 누적
    │       → 실패 배치 자동 재시도 (최대 3회)
    │       → partial_subtitles 실시간 폴링으로 프론트엔드 전달
    │
    ├── Pass 1.5: 미번역 구제 [80%]
    │       → ko="" 블록 → 10블록 소배치 재번역
    │
    ├── Pass 2: LLM QC 교정 [85%→95%]
    │       → 연속 중복 감지 → 재번역
    │       → 40블록 배치 ×5 병렬
    │       → character_relations 주입
    │
    ├── B2.5: 톤 일관성 검증 [95%]
    │       → locked pair 전수 스캔 → 불일치 패턴 교정
    │
    ├── Pass 3: Final Hard-Fix [96%]
    │       ① stabilize_register_blocks() — 어미 교정
    │       ② _apply_lexicon_lookup() — 용어 사전
    │       ③ strategy.fixed_terms + _auto_fixed_terms — 고유명사 통일
    │       ④ _apply_postprocess() — 마침표/금기어/서식/권위톤/격식체
    │
    ├── Pass 4: Wordplay 현지화 [98%]
    │       → 관용구/슬랭 감지 → LLM 재창조
    │
    ├── AI-SQA: 품질 점수 [99%]
    │       → 20개 랜덤 샘플 → 5축 100점 평가
    │       → job["quality_score"] 저장
    │
    └── 완료 [100%]
            job["status"] = "complete"
            job["result"] = {subtitles: [{id, ko}], stats: {total, translated, failed}}


┌──────────────────────────────────────────────────────────────────────┐
│  STEP 5: Polling & 결과 수신 (프론트엔드)                             │
└──────────────────────────────────────────────────────────────────────┘

GET /subtitles/translate-status/{job_id}  (800ms 간격)
응답: {
    status: "running" | "complete" | "failed",
    progress: 0~100,
    current_pass: "Pass 1: 메인 번역",
    logs: ["> [Pass 1] ...", ...],
    partial_subtitles: [{id, ko}],   ← 번역 중간 결과
    result: {subtitles, stats},      ← 완료 시에만
    quality_score: 91                ← AI-SQA 결과
}

프론트엔드 처리:
    → progress → store.setProcessingProgress(12 + progress * 0.87)
    → 새 로그 → addLog()
    → partial_subtitles → store.setSubtitles(merged)
    → status === "complete" → result.subtitles로 최종 업데이트


┌──────────────────────────────────────────────────────────────────────┐
│  STEP 6: 저장 (POST /subtitles/save-translation)                      │
└──────────────────────────────────────────────────────────────────────┘

payload: {subtitles, srtFileName, metadata}
    → storage/translations/{srtFileName} SRT 파일 저장
    → 완료 로그 기록
```

---

## 13. Job Store & Polling 메커니즘

### Job Store (인메모리 + DB)

```python
_jobs: dict[str, dict] = {}  # 인메모리 Job Store

job = {
    "status":       "running" | "complete" | "failed",
    "progress":     0~100,
    "current_pass": "Pass 1: 메인 번역",
    "logs":         ["> [Pass 0] ...", ...]    # 누적 로그 배열
    "partial_subtitles": [{id, ko}],           # 번역 중간 결과
    "result":       {subtitles, stats},        # 완료 시 설정
    "quality_score": 91,                       # AI-SQA 결과
    "error":        "...",                     # 실패 시만
    "created_at":   time.time()
}
```

**Job 수명주기**:
- `running`: 번역 진행 중 (제한 없음)
- `complete` / `failed`: 생성 후 60초 → 자동 메모리 삭제 (`_cleanup_old_jobs`)
- 30초마다 `_periodic_cleanup()` 실행
- DB 저장: `save_job_to_db()` 호출 (DB 미가용 시 인메모리 유지)

### WebSocket 브로드캐스트

```python
async def _broadcast_job_update(job_id, job):
    if ws_manager:
        await ws_manager.broadcast(job_id, {job 상태 딕셔너리})
```

- 각 Pass 전환 시점에 호출
- 클라이언트가 WebSocket 연결 시 실시간 수신 가능
- 연결 없어도 polling으로 동일 데이터 조회 가능

### Polling 오류 허용 (프론트엔드)

```typescript
let pollFailed = 0;
// HTTP 오류 시 최대 5회 연속 실패까지 허용
// 5회 초과 → 예외 발생 → 번역 중단
```

---

## 14. 서버 환경

| 항목 | 값 |
|------|-----|
| 프론트엔드 포트 | 3033 (Next.js 프로덕션 빌드) |
| 백엔드 포트 | 8033 (FastAPI + Uvicorn) |
| 백엔드 프로세스 | PM2 `rename-backend` (ecosystem.config.cjs) |
| 백엔드 경로 | `C:/Vibe Coding/rename/backend/` |
| 가상환경 | `venv2\Scripts\python.exe` |
| AI 모델 | Google Vertex AI Gemini (번역/QC/SQA) |
