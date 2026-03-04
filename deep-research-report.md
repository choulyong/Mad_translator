# SRT 단독 입력 기반 말투 잠금 평가·개선: 재현 가능한 분석 설계와 구현 절차

## 핵심 요약

본 보고서는 **최종 SRT 파일만**(화자/청자 메타데이터 없음) 제공되는 상황에서, 자막 번역 파이프라인의 **말투 잠금(존댓말/반말/권위 하향/피압박 격식)** 품질을 **정확하게 “측정 가능”**하게 만들고, 측정 결과를 이용해 **재번역·교정·후처리로 개선**하는 **비추정적(=근거 없는 원인 단정 금지), 재현 가능한 분석 계획**과 **구현 단계**를 제시한다.

핵심 구성은 다음 3축이다.

첫째, SRT 텍스트·타이밍만으로 **화자 후보(=speaker_candidate)와 청자 후보(=addressee_candidate)** 를 자동 추정한다. 이는 “정답 화자”를 맞히려는 목적이 아니라, **말투 잠금 평가를 위한 최소한의 대화 구조(대화쌍/장면/턴)** 를 복원하는 목적으로 설계한다. 이때 **호격·호칭(“OO야/OO님/서장님”)**과 **대화 인접쌍(질문→응답)**, **시간 갭 기반 장면 분할**을 결합하고, 각 판단에는 **정량적 신뢰도(confidence)** 를 부여한다. (다자 대화에서 addressee 추정은 언어적·상황적 특징을 사용하는 것이 일반적이라는 점을 참고해 설계한다. citeturn4search1turn4search24)

둘째, 각 블록을 **존대/반말/격식/중립**으로 분류하는 **블록 레지스터 분류기**를 구축한다. 한국어의 상대 높임(상대 높임법)은 종결 어미 선택으로 실현되며(해라체·하게체·하오체·하십시오체·해체·해요체 등), 따라서 종결부·종결어미가 핵심 피처가 된다. citeturn0search0turn0search4turn0search16 또한 문장 종결형은 **격식/비격식·공손성**을 표지한다는 언어학적 논의는 레지스터 분류의 타당성을 뒷받침한다. citeturn4search33

셋째, 분류 결과와 (추정된) 대화 구조를 결합해 **잠금 품질 지표**를 산출한다: (a) 화자(후보)별 잠금률, (b) 화자-청자 쌍별 일관성, (c) 장면 전환 후 드리프트율, (d) 단일 블록 내 혼합 레지스터 수, (e) 종합 SR 점수(가중치·임계치 포함). 결과는 **블록 단위 테이블 + 집계 테이블 + 차트**로 내보내며, 개선 단계에서는 **(1) 프롬프트 강제(REGISTER CONTRACT) (2) Self-Critique 레지스터 복구 (3) QC “정중화 금지” (4) 규칙 후처리(고신뢰 구간만)** 순으로 우선순위를 둔다.

자막 형식 처리(예: 두 화자 동시 발화는 하이픈 규칙)와 타이밍 기반 판단은 실무 가이드를 준수한다. 예를 들어 entity["company","Netflix","streaming platform"]의 한국어 타임드 텍스트 가이드에서는 **듀얼 스피커 표기 시 하이픈+공백 사용**, 라인당 16자 제한 등 형식·가독성 규칙을 제시한다. citeturn2view0turn6search3

## 데이터 가정과 입출력 스펙

### 입력

필수 입력은 **SRT 1개 파일**이다. SRT는 (1) 순번, (2) 시작/종료 타임코드, (3) 1~2줄 텍스트로 구성되는 것이 일반적이며, 본 분석은 이를 “블록(SubtitleBlock)” 단위로 정규화한다. (SRT 포맷이 흔히 두 줄까지 사용된다는 점은 플랫폼 가이드의 “최대 2줄” 원칙과도 정합적이다. citeturn2view1)

선택 입력으로는 “디버그 JSON(번역 런 로그)”를 권장한다. 이 선택 입력은 **정확도 개선**이 아니라, “평가의 검증 가능성(ground truth 근접)”을 크게 올린다. 아래 “권장 최소 메타데이터” 절을 참고하라.

### 출력

분석 파이프라인의 산출물은 다음 3종이다.

- 블록 단위 테이블(샘플/전체): `id,start,end,en,ko,speaker_candidate,addressee_candidate,register_label,confidence,issue_flag`
- 집계 테이블: 캐릭터 후보별/대화쌍별/장면별 지표
- 시각화: (a) 패스 타임라인(mermaid), (b) 시간축 lock-rate 차트, (c) 분류기 혼동행렬(수동 라벨 대비)

### 전처리 원칙

- “대사”와 “지문/효과음/노래표시”를 가능한 한 분리한다. (대사 레지스터 평가를 위해)
- 듀얼 스피커 블록은 라인별로 분해한다. **하이픈 표기 규칙**은 여러 가이드에서 다뤄지며, 특히 넷플릭스 한국어 가이드에 명시되어 있다. citeturn2view0turn6search3
- 말줄임표는 스마트 문자(…)로 정규화한다는 등, 형식 정규화는 플랫폼 스타일 가이드 권고를 따른다. citeturn2view0

## SRT에서 화자·청자 후보 자동 추출

이 절은 “정답 화자 식별”이 아니라, **말투 잠금 평가가 가능한 정도의 대화 골격 복원**에 목표를 둔다. 따라서 산출물은 `speaker_candidate`이며, 실제 인물명과 같을 수도/아닐 수도 있다. 모든 추정은 **증거(feature) 기반**이며, 각 단계는 **신뢰도 점수**로 설명된다.

### 장면 분할과 턴 단위 구성

**장면(scene)** 은 시간 갭 기반으로 분할한다.

- `gap = next.start_sec - prev.end_sec`
- `gap >= SCENE_GAP_SEC`이면 scene break
- 기본값: `SCENE_GAP_SEC = 2.5` (튜닝 가능)

이 값은 “2초 이상 정지(pause)를 말줄임표로 표기”하는 자막 실무 규칙과도 정합되게 설계할 수 있다(예: pause≥2초는 발화 경계 후보). citeturn2view0

**턴(turn)** 은 다음 우선순위로 결정한다.

1) 듀얼 스피커(하이픈 라인) → 라인별 턴 분해  
2) 단일 블록 내 문장 2개 이상 → 문장 분해(아래 레지스터 분류기에서 사용하는 문장 분리기 재사용)

### 화자 후보 추출 알고리즘

#### 명시적 라벨 기반(고신뢰)

SRT에 `이름:` 또는 `[이름]` 같은 라벨이 남아 있는 경우(일부 파이프라인에서는 제거되지만, 남아 있는 경우도 많음), 이를 **speaker_candidate로 확정**한다.

권장 정규식(예시):

- `^\s*\[?(?P<name>[A-Za-z가-힣][A-Za-z가-힣0-9·.\- ]{0,20})\]?\s*[:：]\s*(?P<text>.+)$`
- `^\s*-\s*\[?(?P<name>[^:\]]{1,20})\]?\s*[:：]\s*(?P<text>.+)$`

신뢰도 부여:

- `speaker_conf = 1.00` (단, name이 “자막/번역/제작” 등 메타 문자열이면 0으로 폐기)

#### 대화 구조 기반(중신뢰, SRT-only 핵심)

라벨이 없을 때는 **장면 내 턴 시퀀스**로 화자 후보를 만든다. 목적은 “누가 말했는지”가 아니라 “같은 후보가 연속 발화하는 구간/교대 구간”을 안정적으로 만들기 위함이다.

**핵심 아이디어**: 장면 내 발화는 대체로 **턴 교대(turn-taking)** 구조를 가진다. 턴 타이밍만으로 화자 전환을 100% 판정하는 것은 불가능하지만, 최소한 다음 특징을 결합하면 “화자 후보 시퀀스”를 안정적으로 만들 수 있다. (턴 구조/대화 조직을 활용해 상호작용 구조를 모델링하는 접근은 멀티파티 대화 구조 이해에서도 핵심 문제로 다뤄진다. citeturn4search0turn4search27)

**발화 전환 점수(switch_score)** 를 정의한다(0~1). 값이 임계치 이상이면 새 화자 후보로 전환한다.

- 질문→응답 인접쌍: `prev`가 질문(물음표/의문 종결)이고 `curr`가 “응/네/아니/맞아/글쎄/몰라” 등 응답 토큰으로 시작하면 +0.35  
- 레지스터 급변: `prev.register != curr.register`이고 둘 다 고신뢰 분류(아래 절)면 +0.25  
- 호격 포함(“OO야/OO님,”): 화자 교대의 직접 증거는 아니지만, 대화 상호작용 신호이므로 +0.10  
- 장면 시작 첫 발화: +0.15(초기화 안정화)  
- 짧은 단답 연속(예: “응.” “그래.”): +0.10(교대 가능성)

임계치 예:

- `SWITCH_TH = 0.55`

이 규칙은 완전한 “화자 식별”이 아니라 **교대 가능성이 높은 구간을 분리**하여 후보 ID(A,B,C…)를 부여한다.

#### 스타일 클러스터링(보조, 저신뢰→중신뢰 승격용)

위 대화 구조 기반 후보가 “장면마다 A/B가 리셋되어” 전역 캐릭터 집계가 어려울 수 있다. 이를 보완하기 위해 **전역 스타일 클러스터링**으로 후보를 “글로벌 speaker_cluster”로 묶는다.

- 피처(결정적·재현 가능):
  - 문장 종결형 원-핫(합쇼체/해요체/해체/해라체/하오체/중립)
  - 종결부 n-gram(마지막 4~8자)
  - 기능어/감탄사 빈도(아/야/어/요/죠/네/거든/잖아 등)
- 알고리즘(결정적 권장):
  - Agglomerative Clustering(거리=코사인, linkage=average)
  - 또는 HDBSCAN(파라미터 고정 시 결정적에 가깝지만 구현 환경 차이를 줄이려면 계층 군집을 권장)

출력:

- `speaker_candidate_local`(장면 내 A/B/C) → `speaker_candidate_global`(G1,G2,…) 매핑
- 군집 품질을 사후에 평가(아래 “검증 절”의 혼동행렬/정밀도 활용)

### 청자 후보 추정 알고리즘

addressee는 다자 대화에서 복잡할 수 있으며, 연구에서도 언어적·비언어적·상황적 특징을 결합하는 모델이 논의되어 왔다. SRT-only는 비언어/상황 피처가 제한되므로 **언어적 단서+대화 구조 단서** 위주로 설계한다. citeturn4search1turn4search8

우선순위는 다음과 같다.

1) **호격/호칭 기반(고신뢰)**  
2) **직전 턴 화자 기반(중신뢰)**: 대화 인접쌍 가정  
3) **세션 메인 페어(session main pair) 기반(중신뢰)**: 장면 내 주대화쌍 유지  
4) **불특정 청자(저신뢰/UNKNOWN)**: “여러분/다들/모두” 등 집합 지칭

호격 추정 정규식(예시, 한국어 이름/호칭 토큰을 자동 수집):

- 시작부 호격:  
  `^\s*(?P<voc>[가-힣A-Za-z]{1,12})(?P<part>아|야|씨|님|선배|형|오빠|누나|언니|서장님|경감님|형사님|선생님|교수님)\s*[,\!?\…]`
- 종결부 호격:  
  `[, ](?P<voc>[가-힣A-Za-z]{1,12})(아|야|씨|님)\s*[\!?\…]*$`

신뢰도:

- 호격 매치: `addr_conf = 0.85~0.95`
- 직전 화자: `addr_conf = 0.55` (질문→응답이면 0.70까지 가산)
- 메인 페어 복구: `addr_conf = 0.60` (장면 내 A↔B가 반복될수록 상승)

세션 메인 페어 규칙은 “장면 내 주요 대화쌍 유지”를 목적으로 하며, 대화 구조를 모델링하는 연구 흐름(발화 연결/클러스터링/역할 귀속)과 맞닿아 있다. citeturn4search0turn4search27

### 신뢰도 계산 방식(권장)

각 블록에 대해:

- `speaker_conf`는 (라벨/턴전환룰/클러스터링 품질) 가중 평균
- `addressee_conf`는 (호격/인접쌍/메인페어) 최대값 또는 가중 최대치
- `overall_conf = min(speaker_conf, addressee_conf, register_conf)`로 “잠금 평가에 쓰기 적합한 블록”을 선택

이렇게 하면 “확신 없는 블록”이 전체 지표를 오염시키는 것을 줄이고, **고신뢰 구간에 대해서만 잠금 위반을 강하게 주장**할 수 있다.

## 레지스터 분류기: 존대·반말·격식·중립 판정

### 분류 스키마 정의

본 보고서는 SRT-only 상황에서 실무적으로 유용한 4분류를 사용한다.

- `FORMAL` : 합쇼체/하십시오체(합니다, ~습니다, ~습니까, ~십시오, ~하겠습니다 등)
- `HONORIFIC` : 해요체(…요, …죠, …까요, …세요 등) — “격식은 아니지만 공손”
- `BANMAL` : 해체/해라체/하오체/하게체 계열의 비격식·친밀/하대 어미
- `NEUTRAL` : 종결형이 불명확한 파편/표지(감탄사 단독, 명사구, 지문/효과음 등)

한국어 상대 높임법이 **종결 어미 선택으로 실현**되며, 6개 대표 스타일(해라체·하게체·하오체·하십시오체·해체·해요체)이 언급된다는 점은 이 분류의 언어학적 기반이다. citeturn0search0turn0search8turn0search16 또한 하십시오체가 “상대편을 아주 높이는 종결형”으로 설명되는 점은 FORMAL 판정 규칙의 핵심 근거다. citeturn0search4

### 구현 선택지: 형태소 기반 우선, 정규식은 폴백

#### 문장 분리

자막 한 블록은 1~2문장 이상이 있을 수 있다. “블록 레지스터”는 보통 **마지막 문장 종결형**이 대표성을 갖지만, “혼합 레지스터”를 잡으려면 문장 단위 분해가 필요하다.

권장 도구:

- Kiwi(kiwipiepy): 형태소 분석 + 문장 분리 기능 제공(세종 태그 기반, EF=종결어미 등) citeturn1search20turn1search13turn1search1  
- kss: 한국어 문장 분리 유틸리티 citeturn1search6turn1search2  
- KoNLPy(품사 태깅 API, 여러 태거 래핑) citeturn1search19

SRT-only 분석에서는 **설치 난이도와 재현성** 관점에서 아래처럼 권장한다.

- 1순위: `kiwipiepy`(문장 분리+종결어미 탐지 일원화)
- 2순위: `kss`로 문장 분리 + 정규식 기반 종결형 탐지(외부 의존 최소)

#### 레지스터 판정 규칙(정확·재현 가능)

문장(또는 블록)에서 “가장 오른쪽(마지막) 종결형”을 우선 본다. 형태소 기반이라면 “마지막 EF”를 찾는다. 정규식 폴백이라면 아래 패턴으로 끝부분을 매칭한다.

**FORMAL(합쇼체/하십시오체) 고신뢰 패턴**

- `(?:습니다|습니까|습니다만|였습니다|였습니다만|합니다|합니까|하십시오|하십시오요|하시죠|하십시다|하겠습니다)\s*[.!?…]*$`

**HONORIFIC(해요체) 고신뢰 패턴**

- `(?:요|죠|지요|예요|이에요|네요|군요|거든요|잖아요|세요|까요)\s*[.!?…]*$`  
  (단, “조요/요요” 같은 소음 단어는 예외 처리)

**BANMAL(해체/해라체/명령/의문) 패턴**

- `(?:다|냐|니|지|야|거야|거든|잖아|라|마|자|해|해라|해봐|해봐라|가|가자)\s*[.!?…]*$`

**NEUTRAL(중립) 판정 조건**

- 종결형 탐지가 실패하거나,
- 텍스트가 효과음/지문 표기 위주(예: 괄호/대괄호/기호만)거나,
- “…” 단독, 감탄사 단독(“아…”, “헉!”) 등으로 레지스터 비결정적일 때

문장 종결형이 **formality·politeness** 등 정보를 인코딩한다는 점은 문장 종결형 기반 분류의 원리(왜 되는가)를 지지한다. citeturn4search33

### 블록 레벨 라벨·신뢰도 산정

한 블록에 문장이 여러 개면:

- 각 문장에 라벨·신뢰도 부여
- 블록 라벨은 기본적으로 **마지막 문장 라벨**
- 단, 블록 내에서 서로 다른 레지스터가 동시에 감지되면:
  - 듀얼 스피커(하이픈 라인) → “혼합”이 아니라 “다중 화자”로 처리
  - 단일 화자에서 혼합 → `issue_flag="MIXED_REGISTER"`(잠금 실패의 강력 증거)

신뢰도 예시(0~1):

- 형태소 EF 기반 + 강한 패턴: 0.90~0.98
- 정규식 기반 + 약한 패턴(예: “지” 단독): 0.60~0.75
- NEUTRAL: 0.30 (지문이면 0.10)

### 예시와 엣지 케이스(합성 SRT 예)

아래 예시는 **저작권 대사**가 아니라 “테스트용 합성 예문”이다.

| 텍스트(ko) | 기대 라벨 | 이유/엣지 |
|---|---|---|
| “보고 드리겠습니다.” | FORMAL | “겠습니다” 계열, 격식/복종 톤 |
| “죄송합니다, 서장님.” | FORMAL | “합니다” 종결 + 호칭 단서 |
| “오늘 갈래?” | BANMAL | “~래?” 의문(비격식) |
| “지금 가요?” | HONORIFIC | “요” 의문 |
| “야, 잠깐.” | BANMAL 또는 NEUTRAL | 종결형 약함(“잠깐” 단독) → 규칙상 NEUTRAL 가능 |
| “- 그만해요! / - 싫어!” | (라인별) HONORIFIC, BANMAL | 듀얼 스피커 처리 필요(하이픈 규칙) citeturn2view0 |

## 말투 잠금 품질 지표와 SR 점수 체계

이 절의 목표는 “자가평가”가 아니라 **지표가 곧 재현 가능**하도록 수식·임계치를 고정하는 것이다. 또한 “SRT-only 추정”의 한계를 반영하여, 모든 지표는 **(a) 전체 기준**과 **(b) 고신뢰 구간 기준**을 함께 산출하도록 설계한다.

### 핵심 지표 정의

#### 블록 집합 정의

- 전체 블록 집합: `B`
- 대사 블록 집합: `D ⊂ B` (지문/효과음/노래표시 제거 후)
- 잠금 평가 가능 블록 집합(고신뢰):  
  `H = { b ∈ D | overall_conf(b) ≥ 0.70 }`

#### 단일 블록 혼합 레지스터 개수

`mixed_count = |{ b ∈ D : single_speaker(b)=true ∧ detects_multiple_registers(b)=true }|`

- 듀얼 스피커 블록은 Netflix 하이픈 규칙에 따라 라인별 분해 후 평가(혼합이 아니라 “다중 화자”). citeturn6search3

#### 화자(후보)별 잠금률

화자 후보 `s`에 대해:

- `dominant_register(s)` = s의 고신뢰 발화 중 최빈 레지스터
- `lock_rate(s) = (# {b ∈ H : speaker(b)=s ∧ register(b)=dominant_register(s)} ) / (# {b ∈ H : speaker(b)=s})`

주의: 이는 “캐릭터 말투 일관성”의 **하한(lower bound)** 이다. 전역 클러스터링이 “실제 서로 다른 인물”을 합쳐버리면 lock_rate가 과대평가될 수 있으므로, 검증 절의 false positive 테스트를 필수로 둔다.

#### 화자-청자 쌍별 일관성

쌍 `p=(s,a)`에 대해:

- `dominant_register(p)` = 해당 쌍의 최빈 레지스터
- `pair_consistency(p) = match_count / total_count` (고신뢰 H에서)

추가로 “잠금”의 의미를 반영하기 위해, 다음을 도입한다.

- `LOCK_MIN_SAMPLES = 5`
- `LOCK_DOMINANCE = 0.95`

`total_count(p) ≥ LOCK_MIN_SAMPLES`이고 `pair_consistency(p) ≥ LOCK_DOMINANCE`이면 `p`를 “잠금 성립(pair_locked=true)”으로 간주한다. 이는 한국어 상대 높임이 종결형에 의해 비교적 명확히 표지된다는 점을 활용해 “강한 일관성”을 잠금으로 보는 규칙이다. citeturn0search0turn4search33

#### 장면 드리프트율

잠금 성립된 쌍 `p`에 대해, 동일 장면 내에서 레지스터가 바뀌는 이벤트를 드리프트로 센다.

- 장면 `scene_k` 내에서 `p`의 레지스터 시퀀스가  
  `R = [r1, r2, …]`일 때, `#changes = Σ I(ri != r(i-1))`
- `scene_drift_rate(p) = #drift_events / (#eligible_transitions)`

전체 드리프트율은 pair volume 가중 평균으로 요약한다.

### SR 종합 점수 공식(가중치·임계치 포함)

SRT-only 평가에서는 “정답 화자/청자”가 불완전할 수 있으므로, SR 점수는 **고신뢰 구간(H) 기준**으로 정의한다.

정의:

- `M = mixed_count / |D|` (혼합 레지스터 비율)
- `P = 1 - Σ_p w_p * pair_consistency(p)`  
  (w_p = total_count(p)/Σ total_count)
- `D = Σ_p w_p * scene_drift_rate(p)`
- `U = (# {b ∈ D : register(b)=NEUTRAL}) / |D|`  
  (단, 지문 제거 후에도 중립이 많으면 “레지스터 판정 불능 → 잠금 평가 어려움”으로 패널티)

가중치(합=1):

- `wM=0.20, wP=0.45, wD=0.25, wU=0.10`

최종 점수:

- `SR = clip( 100 * (1 - (wM*M + wP*P + wD*D + wU*U)), 0, 100 )`

임계치(권장 운영 기준):

- `SR ≥ 92`: 잠금 매우 안정(교정은 국소)
- `85 ≤ SR < 92`: 실무 가능(드리프트 자동 수정 권장)
- `75 ≤ SR < 85`: 잠금 불안정(패스 레벨 재번역/강제 필요)
- `< 75`: 구조적 문제(프롬프트/정책/후처리 전면 점검)

이 임계치는 “품질 운영용”으로서 합리적 기준을 제공하는 것이 목적이며, 프로젝트/장르에 따라 튜닝 가능하다. (자막 품질이 가이드·규정 준수에 의해 운영되는 맥락은 플랫폼 가이드 및 번역 연구에서 반복적으로 논의된다. citeturn2view1turn0search9turn5search2)

### 산출 테이블 예시

#### 블록 샘플 테이블 예시

실제 파일을 그대로 인용하지 않고 합성 데이터로 “열 정의”와 “기대 출력”을 보여준다.

| id | start | end | en | ko | speaker_candidate | addressee_candidate | register_label | confidence | issue_flag |
|---:|---|---|---|---|---|---|---|---:|---|
| 101 | 00:10:12,000 | 00:10:14,000 | (null) | “보고 드리겠습니다.” | G3 | “서장님” | FORMAL | 0.93 | (none) |
| 102 | 00:10:14,200 | 00:10:15,500 | (null) | “그래, 가.” | G1 | G3 | BANMAL | 0.78 | (none) |
| 103 | 00:10:16,000 | 00:10:18,000 | (null) | “- 그만해요! / - 싫어!” | (split) | (split) | (split) | (split) | DUAL_SPEAKER |
| 104 | 00:10:19,000 | 00:10:21,000 | (null) | “어… 잠깐.” | G2 | UNKNOWN | NEUTRAL | 0.35 | LOW_CONF |

#### 집계 테이블 예시

| speaker_candidate_global | n_blocks(H) | dominant_register | lock_rate | top_pair | pair_consistency(top_pair) | drift_rate(top_pair) |
|---|---:|---|---:|---|---:|---:|
| G1 | 420 | BANMAL | 0.94 | (G1→G3) | 0.96 | 0.03 |
| G3 | 380 | FORMAL | 0.91 | (G3→G1) | 0.95 | 0.05 |

## 구현 절차: 스크립트·의사코드·시각화

이 절에서는 “바로 구현 가능한” 형태로 Python/TypeScript 중심 스텝을 제시한다. 코드 스니펫은 간결성을 위해 핵심만 포함한다.

### 파스 흐름 타임라인(분석 관점)

```mermaid
flowchart LR
  A[SRT 파싱/정규화] --> B[대사/지문 분리 + 듀얼 스피커 분해]
  B --> C[문장 분리 + 레지스터 분류]
  C --> D[장면 분할(타이밍 갭 기반)]
  D --> E[화자 후보 추정(턴/클러스터)]
  E --> F[청자 후보 추정(호격/인접쌍/메인페어)]
  F --> G[잠금 지표 계산(캐릭터/쌍/장면)]
  G --> H[리포트/CSV/차트 + 문제 블록 목록]
```

### Python 구현 스케치

```python
import re
from dataclasses import dataclass
from typing import List, Optional, Dict, Tuple

TIME_RE = re.compile(r"(\d{2}):(\d{2}):(\d{2}),(\d{3})")

def to_seconds(ts: str) -> float:
    h, m, s, ms = map(int, TIME_RE.match(ts).groups())
    return h*3600 + m*60 + s + ms/1000.0

@dataclass
class Block:
    id: int
    start: str
    end: str
    text: str
    # derived
    start_sec: float = 0.0
    end_sec: float = 0.0
    scene_id: int = 0
    speaker_cand: str = "UNKNOWN"
    speaker_conf: float = 0.0
    addr_cand: str = "UNKNOWN"
    addr_conf: float = 0.0
    register: str = "NEUTRAL"
    reg_conf: float = 0.0
    issue: str = ""

def parse_srt(path: str) -> List[Block]:
    # 최소 의존성 파서 (pysrt 대체 가능)
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    chunks = re.split(r"\n\s*\n", raw.strip())
    blocks = []
    for ch in chunks:
        lines = ch.splitlines()
        if len(lines) < 3:
            continue
        idx = int(lines[0].strip())
        times = lines[1].split("-->")
        start = times[0].strip()
        end = times[1].strip().split()[0]
        text = "\n".join(lines[2:]).strip()
        b = Block(id=idx, start=start, end=end, text=text)
        b.start_sec = to_seconds(start)
        b.end_sec = to_seconds(end)
        blocks.append(b)
    return blocks

DUAL_LINE_RE = re.compile(r"^\s*-\s+")
def split_dual_speaker(block: Block) -> List[Block]:
    lines = block.text.splitlines()
    if sum(1 for l in lines if DUAL_LINE_RE.match(l)) >= 2:
        out = []
        for i, l in enumerate(lines):
            if DUAL_LINE_RE.match(l):
                nb = Block(
                    id=int(f"{block.id}{i+1}"),  # 유니크 ID (분석용)
                    start=block.start, end=block.end,
                    text=DUAL_LINE_RE.sub("", l).strip()
                )
                nb.start_sec, nb.end_sec = block.start_sec, block.end_sec
                nb.issue = "DUAL_SPEAKER_LINE"
                out.append(nb)
        return out
    return [block]
```

레지스터 분류(정규식 폴백 버전):

```python
FORMAL_RE = re.compile(r"(습니다|습니까|합니다|합니까|하십시오|하겠습니다)\s*[\.\!\?…]*$")
HONORIFIC_RE = re.compile(r"(요|죠|지요|예요|이에요|네요|군요|세요|까요)\s*[\.\!\?…]*$")
BANMAL_RE = re.compile(r"(다|냐|니|지|야|거야|거든|잖아|라|마|자|해|가)\s*[\.\!\?…]*$")

def classify_register(text: str) -> Tuple[str, float]:
    t = text.strip()
    # 지문/효과음(간단 휴리스틱)
    if re.fullmatch(r"[\(\[\{<].*[\)\]\}>]", t) or re.fullmatch(r"[♪♫]+.*", t):
        return "NEUTRAL", 0.10

    # 마지막 행/문장 기준(간단)
    last = t.splitlines()[-1].strip()

    if FORMAL_RE.search(last):   return "FORMAL", 0.92
    if HONORIFIC_RE.search(last):return "HONORIFIC", 0.85
    if BANMAL_RE.search(last):   return "BANMAL", 0.75

    # 파편/명사구/감탄사 등
    if len(last) <= 3:
        return "NEUTRAL", 0.30
    return "NEUTRAL", 0.40
```

장면 분할 + 간단 addressee 추정(호격 우선):

```python
VOC_RE = re.compile(r"^\s*([가-힣A-Za-z]{1,12})(아|야|씨|님|서장님|경감님|형사님)\s*[,!?\…]")

def segment_scenes(blocks: List[Block], scene_gap=2.5) -> None:
    scene_id = 0
    prev_end = None
    for b in blocks:
        if prev_end is None or (b.start_sec - prev_end) >= scene_gap:
            scene_id += 1
        b.scene_id = scene_id
        prev_end = b.end_sec

def infer_addressee(blocks: List[Block]) -> None:
    last_speaker_in_scene: Dict[int, str] = {}
    for b in blocks:
        m = VOC_RE.match(b.text)
        if m:
            b.addr_cand = m.group(1)
            b.addr_conf = 0.90
        else:
            # 인접쌍 가정: 직전 화자(후보)를 청자로
            b.addr_cand = last_speaker_in_scene.get(b.scene_id, "UNKNOWN")
            b.addr_conf = 0.55 if b.addr_cand != "UNKNOWN" else 0.20

        # speaker 후보는 별도 루틴(턴전환 점수)로 채우되,
        # 여기선 placeholder로 scene 내 순번 기반 A/B를 넣는 정도부터 시작 가능
        # last_speaker_in_scene[b.scene_id] = b.speaker_cand
```

### TypeScript 구현 포인트

TypeScript에서는 SRT 파서를 직접 구현하거나 `subtitle` 관련 npm 패키지를 쓸 수 있으나, 재현성을 위해 “정규식 파서 + 엄격 테스트”를 권장한다. (아래는 구조만)

```ts
type Register = "FORMAL" | "HONORIFIC" | "BANMAL" | "NEUTRAL";

interface Block {
  id: number|string;
  start: string;
  end: string;
  text: string;
  startSec: number;
  endSec: number;
  sceneId: number;
  speakerCand: string;
  speakerConf: number;
  addrCand: string;
  addrConf: number;
  register: Register;
  regConf: number;
  issue?: string;
}

const FORMAL = /(습니다|습니까|합니다|합니까|하십시오|하겠습니다)\s*[.!?…]*$/;
const HON = /(요|죠|지요|예요|이에요|네요|군요|세요|까요)\s*[.!?…]*$/;
const BAN = /(다|냐|니|지|야|거야|거든|잖아|라|마|자|해|가)\s*[.!?…]*$/;

export function classifyRegister(text: string): {label: Register, conf: number} {
  const last = text.trim().split(/\n+/).pop()!.trim();
  if (FORMAL.test(last)) return {label:"FORMAL", conf:0.92};
  if (HON.test(last)) return {label:"HONORIFIC", conf:0.85};
  if (BAN.test(last)) return {label:"BANMAL", conf:0.75};
  return {label:"NEUTRAL", conf:last.length <= 3 ? 0.30 : 0.40};
}
```

### 리포팅·차트·혼동행렬(평가/검증용)

잠금률 시간추세(롤링 윈도우) 차트 예(python/matplotlib):

```python
import pandas as pd
import matplotlib.pyplot as plt

def plot_lock_rate_over_time(df: pd.DataFrame, window=200):
    # df: block_id 순서대로 정렬, columns: is_lock_ok (0/1)
    s = df["is_lock_ok"].rolling(window, min_periods=50).mean()
    plt.figure()
    plt.plot(df["block_index"], s)
    plt.xlabel("block_index")
    plt.ylabel(f"rolling_lock_ok@{window}")
    plt.title("Lock-rate over time")
    plt.show()
```

혼동행렬(수동 라벨 vs 자동 분류):

```python
from sklearn.metrics import confusion_matrix, ConfusionMatrixDisplay

def plot_confusion(y_true, y_pred, labels):
    cm = confusion_matrix(y_true, y_pred, labels=labels)
    disp = ConfusionMatrixDisplay(cm, display_labels=labels)
    disp.plot()
    plt.title("Register classifier confusion matrix")
    plt.show()
```

## 검증, 합성 테스트, 런타임 메타데이터, 개선 액션

### 검증 절차(거짓양성/거짓음성 측정)

SRT-only 분석은 “추정 기반”이므로, **검증 설계가 곧 신뢰도**다. 아래 2단계를 최소로 수행하라.

1) **레지스터 분류기 검증(필수)**  
   - 랜덤 샘플 200~500문장(대사만) 수동 라벨링: FORMAL/HONORIFIC/BANMAL/NEUTRAL  
   - 자동 분류와 비교: 정확도 + 클래스별 F1 + 혼동행렬  
   - “종결형이 공손성/격식을 표지한다”는 언어학적 근거가 있더라도, 실제 자막에는 파편 문장/구어 탈락이 많아 오차가 생긴다. citeturn4search33

2) **화자/청자 후보 검증(권장)**  
   - vocative가 명확한 구간(“OO야/OO님,”)만 골라 addressee 추정 정확도 평가  
   - 듀얼 스피커(하이픈) 구간은 라인 분해가 올바른지 테스트(플랫폼 가이드 준수 확인) citeturn6search3

정량 기준(권장):

- 레지스터 분류기: 대사 블록 기준 macro-F1 ≥ 0.90을 1차 목표(형태소 기반일 때 현실적인 상한)
- addressee(호격 기반) 정확도: ≥ 0.95(호격 패턴이 명확한 샘플에 한함)

### 합성 테스트 케이스(자동 회귀 테스트용)

아래는 “잠금 실패를 유발하는 전형 패턴”을 합성 SRT로 만들고, 기대 출력(라벨/issue)을 고정해 회귀 테스트를 구성하는 방법이다.

- 단일 화자 혼합: “알겠습니다. 가.” → `MIXED_REGISTER`가 잡혀야 함  
- 듀얼 스피커: `- 그만해요!` / `- 싫어!` → 라인 분해 후 혼합으로 잡히면 실패(정상은 DUAL_SPEAKER 처리) citeturn2view0  
- 파편 문장: “왜?” “진짜.” “어…” → NEUTRAL 또는 BANMAL(저신뢰)로 처리되며, “잠금 평가 제외”가 되어야 함  
- 권위/복종 템플릿: “즉시 보고해.” vs “보고 드리겠습니다.” → BANMAL(권위) vs FORMAL(복종)  
- 호격 기반 청자 추정: “서장님, …” → addressee_candidate=서장님(고신뢰)

### 분석/개선을 위해 런타임에 수집할 최소 메타데이터(권장)

SRT-only 평가를 “좋은 휴리스틱” 수준에서 “정확한 잠금 검증” 수준으로 올리려면, 번역 런에서 아래를 최소로 수집하라(블록별 one-line JSON 권장).

필수에 가까운 최소 항목:

- `block_id`
- `speaker` + `speaker_confidence`
- `addressee` + `addressee_confidence`
- `speech_level_pred`(FORMAL/HONORIFIC/BANMAL/NEUTRAL)
- `lock_state`(locked 여부, lock_type: honorific/banmal/authoritative/submissive)
- `lock_evidence`(honorific_count, banmal_count, samples)

이 메타데이터는 “품질 리포트”뿐 아니라 **재번역 타겟팅(잠금 위반 블록만 다시 번역)** 에 직접 쓰인다. 번역자/번역 정책 불일치로 인해 존댓말/반말 혼용이 발생할 수 있다는 점은 자막 번역 연구에서도 사례로 논의되어 왔다. citeturn5search2turn0search9

### 개선 액션 우선순위: 프롬프트·패스 체크·후처리

SRT-only 평가 결과로 “잠금이 깨진 구간”을 찾았다면, 개선은 **가장 비용 대비 효과가 큰 순서**로 진행한다.

#### 패스 레벨 체크 추가(가장 먼저)

- 규칙: `pair_locked=true`인 (speaker, addressee)에서 레지스터가 이탈하면 `LOCK_VIOLATION` 플래그  
- 액션: 위반 블록만 **재번역/재교정**(전체 재번역 금지)

이 방식은 “QC가 전체를 건드려서 캐릭터가 평균화”되는 부작용을 크게 줄인다.

#### 범용 프롬프트 스니펫: REGISTER CONTRACT

(엔진/작품 불문 범용. SRT-only 평가에서 “잠금 위반 패턴”이 확인되면 이 스니펫을 번역/교정 프롬프트 상단에 넣는다.)

- 핵심은 “tone_memory 참고”가 아니라 **lock을 ‘법’으로 승격**하는 것

프롬프트(복사해 사용):

```text
[REGISTER CONTRACT — UNIVERSAL, ABSOLUTE]
목표: 말투(존대/반말/격식) 트랙을 관계별로 고정하고, 장면 전체에서 흔들림을 0에 가깝게 만든다.

우선순위(절대):
1) lock_state(locked=true): honorific/banmal/authoritative_downward/submissive_formal
2) relationship policy (CASUAL_LOCK/HONORIFIC_LOCK 등)
3) persona / typical expressions (있다면)
4) 어미 변주 규칙
5) tone memory(참고)

금지:
- 한 블록 내 존대/반말 혼용(예외: DUAL SPEAKER나 SIDE_TALK로 명시된 경우만)
- lock_state를 깨면서 문장을 "더 정중하게" 만드는 행위
- 번역투 종결(…것입니다/…하도록 하겠습니다)

출력 전 점검:
RE(관계 레지스터)와 SR(캐릭터 말투 일관성)이 하나라도 깨지면 의미가 맞아도 실패로 간주하고 즉시 수정하라.
```

#### Self-Critique(레지스터 복구 모드) 스니펫

```text
[SELF-CRITIQUE — REGISTER REPAIR MODE]
EN↔KO 의미는 유지하되, 우선순위는 다음과 같다:
(1) lock_state / 관계 정책 위반(존대↔반말, 권위↔복종)을 먼저 복구
(2) 동일 speaker→동일 addressee에서 말투 트랙이 흔들리면 반드시 통일
(3) 문장을 고급스럽게 만들려고 정중화하지 말 것

수정은 어미/리듬/어휘로만 수행하고 정보 추가는 금지.
```

#### QC 스니펫: 정중화(평준화) 금지

QC 단계가 “다듬기” 과정에서 무의식적으로 `~요/~죠`로 평균화하면 SR이 급락한다. QC에 아래를 명시한다.

```text
[QC — DO NOT NEUTRALIZE CHARACTER VOICE]
QC의 목적은 문장을 더 공손하게 만드는 것이 아니다.
관계별 lock_state를 최우선으로 유지하고,
반말 관계를 임의로 존대로 바꾸거나, 격식을 임의로 낮추지 마라.
SR/RE 위반을 발견하면 먼저 말투 트랙부터 복구하고,
그 외 수정은 최소화하라.
```

이 “평준화 금지”는 스타일 전환/형식성 변환이 의미 보존과 함께 관리돼야 한다는 연구적 논의(형식/비형식 변환, 공손성/높임의 중요성)와도 정합된다. citeturn2view3

#### 후처리 정규식(가장 마지막, 고신뢰 구간만)

후처리는 강력하지만 위험하다. 따라서 조건을 엄격히 둔다.

- 조건: `pair_locked=true` AND `overall_conf ≥ 0.85` AND `issue_flag=LOCK_VIOLATION`
- 예: BANMAL 잠금인데 문장 끝이 `요/죠/까요`로 끝나는 경우만 제한적으로 변환

이때도 “의미/화행 변형”이 일어날 수 있으므로, 후처리는 “재번역 실패 시 최후 수단”으로 두는 것이 안전하다.

### 참고·우선순위 소스 목록

본 작업에서 우선순위로 참고해야 할 1차/공식·학술 소스는 다음이다.

- 한국어 자막 형식·표기 실무: entity["company","Netflix","streaming platform"] Timed Text Style Guide(한국어/General Requirements), 듀얼 스피커 하이픈 규칙 등 citeturn2view0turn2view1turn6search3  
- 한국어 높임/상대 높임 분류(종결형 기반): entity["organization","국립국어원","seoul, south korea"] 온라인가나다/표준국어대사전 인용(해라체·하게체·하오체·하십시오체·해체·해요체 등) citeturn0search0turn0search4turn0search16  
- 레지스터(문장 종결형) 언어학 근거: SRT-only 분류의 이론적 기반(종결형이 formality/politeness 등을 인코딩) citeturn4search33  
- 형식성/공손성 변환(데이터·평가 관점): StyleKQC(형식/비형식 변환을 의미 보존과 함께 다룸) citeturn2view3  
- addressee 추정(대화 역할 귀속 문제): 언어적·상황적 특징 기반 addressee identification 연구(텍스트-only에서는 언어적 특징 중심으로 제한) citeturn4search1turn4search8  
- 번역 실무에서 말투/호칭 불일치가 문제 되는 사례 연구: 번역자 간 호칭·어투 불일치로 존대/반말 혼용이 초래될 수 있다는 논의 citeturn5search2turn0search9  
- 일반 번역/자막 가이드: entity["organization","TED","talks platform"] 번역 가이드(톤·자연스러움 중심) citeturn6search2turn6search14