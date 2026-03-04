# 🎬 Cinema Engine V5: K-Cinematic Translation Pipeline 명세서

본 문서는 **Cinema Engine V5 (movie-rename)** 프로젝트의 핵심인 한국어 번역 파이프라인의 전체 흐름과 제어 로직을 집대성한 단일 명세서입니다. "기계적인 치환"을 넘어, "극장에서 보는 듯한 생생한 각색(Creative Localization)"을 구현하기 위해 설계된 다층적 시스템 구조를 설명합니다.

---

## 1. 파이프라인 철학 (Core Philosophies)

1. **상황과 맥락의 지배 (Contextual Dominance)**: 단어(Word)가 아닌 화자의 의도, 감정, 상대방과의 관계를 기준으로 번역한다.
2. **절대 제어 시스템 (Global Hard-Lock)**: LLM의 변덕스러운 추론에 의존하지 않고, 엔진의 설정(정규식, 룰셋)이 최종 결정권을 가진다.
3. **직역 완전 박멸 (Zero Translationese)**: 모든 영어식 대명사, 수동태, 맹목적인 관용구 직역을 물리적인 필터링망을 통해 제거한다.

---

## 2. 번역 오케스트레이션 단계 (The 6-Pass Pipeline)

번역은 `backend/app/api/subtitles.py` 내의 `_run_translation_job` 오케스트레이터를 중심으로 **6단계(Pass)**를 거쳐 완성됩니다.

### 📍 [Pass 0 & 0.5] Strategy & Matrix (전략 및 관계 맵핑)

파일: `strategy.py`, `subtitles.py`

- 영화의 메타데이터(제목, 줄거리, TMDB 배우 등)를 수집하여 넷플릭스/디즈니+ 수석 번역가 수준의 **번역 전략 기획서(Strategy Blueprint)** 도출.
- 각 화자의 **페르소나(성별, 직업, 말투 아키타입 특징)**를 정의.
- 화자 간의 1:1 **관계 매트릭스 파악** (예: Nick → Judy: 초면 존대 → 후반부 친근한 반말).

### 📍 [Pass 1] Semantic Batching & Base Translation (베이직 번역)

파일: `pass_1.py`, `k_cinematic_prompt.py`

- 타임스탬프 기준으로 단순 분할하지 않고, 문맥 덩어리(15블록 단위)로 묶어서 LLM에 제공 (`Semantic Batching`).
- **베이스 프롬프트(V3 Master System Prompt)** 제어:
  1. 기계적 직역 차단 (대명사 금지, 수동태 지양).
  2. 다의어 문맥 인지 (Contextual Disambiguation): 'Page'가 상황상 종이인지 시종(수행원)인지 앞뒤 문맥 스캔 강제.
  3. 문화적 오마주의 감정선 보존 (예: "That'll do, pig" -> "수고했어, 꼬마 친구").

### 📍 [Pass 2 & 2.5] Tone Memory & Stabilization (말투 잠금 및 보정)

파일: `subtitles.py` -> `_update_confirmed_speech_levels()` & `_FORMAL_TO_BANMAL_EXT`

- **Global Hard-Lock 매커니즘**: Strategy 상에 정의된 화자 관계 쌍은 `hard_locked: True`로 묶여, LLM의 일시적 오류나 씬 전환에도 불구하고 **말투(존댓말/반말)가 영구적으로 고정**됨.
- **능청/비꼼 아키타입 방어망**: 확장 정규식을 통해 `~거예요`, `~할게요`, `~했어요` 등 반존대 혼용을 초래하는 주요 어미들을 강제로 제단. 단, 닉 와일드 같은 매력적인 캐릭터의 특징인 `~잖아요`, `~거든요`, `~지요` 등은 최상단 규칙으로 보호됨.

### 📍 [Pass 3] Hard-Fix & NER Overriding (물리적 교정 및 고유명사 강제)

파일: `pass_3_fix.py`

- **영어식 번역투 물리적 박멸**: 문맥 불문 튀어나온 "그는", "그녀는", "당신", "나의" 등을 빈 문자열로 완전히 삭제하거나 덜어냄.
- **NER (고유명사) 영구 락인**: "Gary the Snake", "치타우저" 등 명칭 변경을 차단하고 띄어쓰기 여부 무관하게 하드코딩된 규칙에 따라 일괄 교정 (`_apply_lexicon_lookup`).

### 📍 [Pass 4] Wordplay Re-creation (언어유희 및 관용구 재창조)

파일: `pass_4_wp.py`, `k_cinematic_prompt.py` (`get_wordplay_localization_prompt`)

- **Wordplay 감지**: 영어 원문의 관용구/슬랭 패턴(`_IDIOM_PATTERNS`)이나, 한국어 번역상의 직역 자국(`_KO_DIRECT_TRANSLATE` 예: "이웃의 말", "다리를 부러뜨려")을 탐지.
- **MAX 가중치 재창조**: 발음이나 특수 소리(동물 소리: neigh, baa, purr)를 활용한 동음이의어 말장난이 나올 경우, 단순 단어 번역을 금지시키고 한국어의 발음/문화를 활용해 아예 **새로운 신조어 급 말장난(예: '반대하-마!')을 창조(Re-Creation)** 하도록 최고 가중치(MAX) 부여.

### 📍 [Pass 5] Final Polish (미세 번역투 윤문 및 리듬감 튜닝)

파일: `pass_5_polish.py`, `k_cinematic_prompt.py`

- 이전 단계에서 확립된 워드플레이나 캐릭터 말투(하드락)를 유지하면서, 잔존하는 미세한 번역투(수동태, 대명사 등)와 리듬감을 다듬는 단계.
- **ABSOLUTE IMMUTABLE 규칙 적용**: LLM의 과잉 교정(Over-correction)을 엄격히 금지하여 창조적 산출물을 보존함.

### 📍 [Pass 5.5] Final Shield (물리적 방어막 재실행)

파일: `subtitles.py`

- Pass 5 윤문 과정에서 LLM이 혹시라도 훼손했을지 모르는 하드락 룰을 다시 한 번 강위치로 덮어씌움.
- 말투 하드락(`stabilize_register_blocks`), 사전/고유명사 강제 적용(`_apply_lexicon_lookup`), 기호 후처리(`_apply_postprocess`)를 재실행하여 100% 번역 무결성을 확보함.

---

## 3. 핵심 방어 룰셋 (Ironclad Defenses)

로컬라이제이션 품질을 보장하기 위한 엔진 내 3대 특별 룰입니다.

### 🛡️ Iron Rule 1: Family-Friendly 무관용 룰 (Content Rating Wall)

- **발동 조건**: 가족영화, 애니메이션, 전체(G)/12세(PG) 등급.
- **기능**: 어떠한 상황과 맥락, 화자의 감정 고조 하에서도 **"뇬", "놈", "새끼" 같은 자극적이거나 모욕적인 표현을 100% 원천 차단**함. (가족이 극장에서 보는 환경 기준 확립).

### 🛡️ Iron Rule 2: Tone Archetype Protection (톤 아키타입 보호막)

- 반말 강제화 과정에서, 캐릭터의 매력적인 말투(비아냥, 능청)가 무미건조한 "~어", "~야"로 마모되지 않도록 변환 정규식 리스트의 우선순위 최상류에 방벽(`잖아요`, `거든요`, `지요`)을 세움.

### 🛡️ Iron Rule 3: Context & Intent Focus (직역 페널티제)

- 단순 직역이 내부 품질 평가에서 강한 페널티를 받음. 'choo-choo train engineer'를 칙칙폭폭 기관사가 아닌 '기차 기장님/승무원'으로 각색하는 "맥락 단위 로컬라이제이션"을 강제.

---

## 4. 백엔드 아키텍처 및 동기화 (Tech Stack)

- **Worker**: Python `FastAPI` + `PM2`를 활용하여 비동기 처리 (`asyncio`, 8033 포트 독립 구동: `rename-backend`).
- **LLM Engine**: Google Cloud `Vertex AI (Gemini 2.5 Flash / Pro)` 탑재 및 시맨틱 배칭 파이프라인.
- **DB Persistence**: 서버 재시작 시에도 터지지 않고 이어지도록, 중간 처리 상태를 `SQLite`에 연속 체크포인팅 (`jobs` 캐시).
- **Communication**: Frontend(3033 포트)-Backend(8033 포트) 간 HTTP(REST) 구조 기반 동기화.
