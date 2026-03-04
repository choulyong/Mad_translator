# 🚀 Antigravity Aura V2: 신뢰 체인(Trust Chain) 아키텍처

## 1. 개요 (Vision)
본 프로젝트는 **"완벽한 일관성(Consistency)"**과 **"초고속 처리(Performance)"**를 양립시키는 세계 최고의 AI 번역 엔진 구축을 목표로 한다. '말투 드리프트'와 '직역체'의 근본 원인을 분석하고, 인과관계에 기반한 레이어별 해결책을 제시한다.

---

## 2. 인과관계 기반 문제 해결 전략

### 2.1 말투 드리프트 (Speech Drift)
- **원인:** 배치 간 독립적 처리로 인한 캐릭터 관계 및 톤 정보의 휘발.
- **해결 (Static Lock):** 번역 전 단계에서 전역 화자 관계도(Global Relation Matrix)를 확정하고, 모든 배치에 동일한 '말투 닻(Speech Anchor)'을 주입하여 물리적으로 드리프트를 차단한다.

### 2.2 직역체 및 번역투 (Literalism)
- **원인:** 말투 강제 규칙에 대한 AI의 과도한 순응 및 영어 문장 구조에 매몰된 단어 매핑.
- **해결 (Semantic Re-Composition):** 번역을 [의미 해석] -> [상황 매핑] -> [말투 코팅]의 3단계로 분리한다. 영어 구조를 완전히 파괴하고 한국어 정서에 맞는 '더빙 대본' 수준의 대사를 재창작한다.

### 2.3 처리 속도 저하 (Latency)
- **원인:** 순차적 패스(Pass) 구조와 병렬 처리 부재.
- **해결 (Parallel Execution):** 화자 관계가 사전에 확정(Locked)되었으므로, 배치 간 의존성을 제거하고 5개 이상의 배치를 동시 처리(Concurrency)하여 속도를 300% 이상 향상시킨다.

---

## 3. 핵심 기술 아키텍처

### Layer 1: Global Identity Discovery (GID)
- 전체 SRT 파일을 사전 스캔하여 모든 등장인물의 ID, 성격, 사회적 위계를 확정.
- **Output:** 캐릭터별 고정 프로필 및 화자 쌍별 말투 등급(1~5단계).

### Layer 2: Speech Anchor Locking (SAL)
- 각 관계에 맞는 전용 종결 어미 셋(Set)을 정의하여 프롬프트 최상단에 배치.
- **Output:** `{-어, -지, -야}` 등 캐릭터 고유의 말투 제약 조건.

### Layer 3: High-Context Concurrent Translation (HCCT)
- 40~50개 블록 단위의 대형 배치를 병렬로 처리.
- `Locked State`를 공유하여 배치 간 말투 불일치를 원천 방지.

### Layer 4: Semantic Localization Filter (SLF)
- "Birthday boy" -> "오늘의 주인공"과 같은 관용적 의역 데이터베이스 활용.
- 한국어 구어체에서 어색한 대명사(그, 그녀, 당신)를 이름이나 직함으로 강제 치환.

---

## 4. 구현 로드맵 (Causality Roadmap)

1. **상태 관리 엔진 개편:** `translate-store.ts`에 `LockedRelationMap`과 `SpeechAnchor` 필드 추가.
2. **사전 분석 모듈(GID) 구현:** `Pass 0`을 강화하여 번역 전 전체 관계도를 완성하는 로직 개발.
3. **병렬 번역 커널(HCCT) 개발:** `executeTranslation`을 `Promise.all` 기반의 동시성 제어 구조로 전환.
4. **의역 가이드라인(SLF) 고도화:** 프롬프트에 '더빙 대본 작가' 페르소나와 직역 방지 규칙 주입.

---

## 5. 절대 검증 및 품질 강제 원칙 (Strict Verification Protocol)

### 5.1 자만 금지 및 최종 리뷰 (Zero-Confidence Review)
- 모든 코드 수정 후에는 "내가 틀렸을 수 있다"는 전제하에 전체 로직을 최소 1회 전수 코드리뷰한다.
- 특히 괄호(`{}`), 세미콜론(`;`), `export` 누락 등 기초적인 구문 에러를 빌드 전 반드시 육안으로 재확인한다.

### 5.2 백엔드-프론트엔드 동기화 검증 (Full-Stack Sync Check)
- 백엔드(Server Actions/API)의 로직 변경이 프론트엔드 UI(Component/Store)에 실제 데이터로 반영되는지 로그를 통해 강제 확인한다.
- API 응답 구조가 변경될 경우, 이를 사용하는 모든 프론트엔드 호출부를 전수 조사하여 수정한다.

### 5.3 런타임 로그 모니터링 (Runtime Log Audit)
- 번역 프로세스 실행 중 발생하는 백엔드 로그(`console.log`)와 프론트엔드 로그(`addLog`)를 대조하여, 데이터 누수가 없는지 실시간으로 검증한다.
- 병렬 처리(HCCT) 시 각 세션의 성공/실패 여부를 개별 로그로 기록하여 추적 가능성을 확보한다.
