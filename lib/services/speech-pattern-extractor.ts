// Speech Pattern Extractor — 자막 코퍼스에서 반복 말버릇을 추출하여 blueprint에 주입
import type { StrategyBlueprint } from '@/lib/store/translate-types';

interface PatternEntry {
  regex: RegExp;
  original: string;
  translation: string;
  category: string;
}

// ── 패턴 사전 (5개 카테고리) ──

const SENTENCE_STARTERS: PatternEntry[] = [
  { regex: /\bHey\b/gi, original: 'Hey', translation: '야', category: '문두 습관' },
  { regex: /\bWell,?\s/gi, original: 'Well', translation: '글쎄', category: '문두 습관' },
  { regex: /\bLook,?\s/gi, original: 'Look', translation: '봐', category: '문두 습관' },
  { regex: /\bCome on\b/gi, original: 'Come on', translation: '이봐', category: '문두 습관' },
  { regex: /\bListen,?\s/gi, original: 'Listen', translation: '들어봐', category: '문두 습관' },
  { regex: /\bSo,?\s/gi, original: 'So', translation: '그래서', category: '문두 습관' },
  { regex: /\bAlright,?\s/gi, original: 'Alright', translation: '좋아', category: '문두 습관' },
  { regex: /\bOkay,?\s/gi, original: 'Okay', translation: '좋아', category: '문두 습관' },
  { regex: /\bPlease,?\s/gi, original: 'Please', translation: '제발', category: '문두 습관' },
  { regex: /\bWait,?\s/gi, original: 'Wait', translation: '잠깐', category: '문두 습관' },
  { regex: /\bShut up\b/gi, original: 'Shut up', translation: '닥쳐', category: '문두 습관' },
  { regex: /\bStop\b/gi, original: 'Stop', translation: '멈춰', category: '문두 습관' },
  { regex: /\bJesus\b/gi, original: 'Jesus', translation: '세상에', category: '문두 습관' },
];

const INTERJECTIONS: PatternEntry[] = [
  { regex: /\bOh\b/gi, original: 'Oh', translation: '아', category: '감탄사' },
  { regex: /\bDamn\b/gi, original: 'Damn', translation: '젠장', category: '감탄사' },
  { regex: /\bSeriously\b/gi, original: 'Seriously', translation: '진짜', category: '감탄사' },
  { regex: /\bNo way\b/gi, original: 'No way', translation: '말도 안 돼', category: '감탄사' },
  { regex: /\bGod\b/gi, original: 'God', translation: '맙소사', category: '감탄사' },
  { regex: /\bHoly shit\b/gi, original: 'Holy shit', translation: '젠장', category: '감탄사' },
  { regex: /\bWhat the hell\b/gi, original: 'What the hell', translation: '대체 뭐야', category: '감탄사' },
  { regex: /\bOh my God\b/gi, original: 'Oh my God', translation: '세상에', category: '감탄사' },
  { regex: /\bGeez\b/gi, original: 'Geez', translation: '이런', category: '감탄사' },
  { regex: /\bYeah\b/gi, original: 'Yeah', translation: '그래', category: '감탄사' },
  { regex: /\bNah\b/gi, original: 'Nah', translation: '아니', category: '감탄사' },
  { regex: /\bExactly\b/gi, original: 'Exactly', translation: '바로 그거야', category: '감탄사' },
  { regex: /\bWhatever\b/gi, original: 'Whatever', translation: '뭐든', category: '감탄사' },
];

const ADDRESSES: PatternEntry[] = [
  { regex: /\bbuddy\b/gi, original: 'buddy', translation: '친구', category: '호칭' },
  { regex: /\bman\b/gi, original: 'man', translation: '야', category: '호칭' },
  { regex: /\bhoney\b/gi, original: 'honey', translation: '(이름/별명)', category: '호칭' },
  { regex: /\bsir\b/gi, original: 'sir', translation: '선생님', category: '호칭' },
  { regex: /\bma'am\b/gi, original: "ma'am", translation: '부인', category: '호칭' },
  { regex: /\bpal\b/gi, original: 'pal', translation: '친구', category: '호칭' },
  { regex: /\bdude\b/gi, original: 'dude', translation: '야', category: '호칭' },
  { regex: /\bbro\b/gi, original: 'bro', translation: '형', category: '호칭' },
  { regex: /\bsweetheart\b/gi, original: 'sweetheart', translation: '(이름/별명)', category: '호칭' },
  { regex: /\bdarling\b/gi, original: 'darling', translation: '(이름/별명)', category: '호칭' },
  { regex: /\bkid\b/gi, original: 'kid', translation: '꼬마', category: '호칭' },
  { regex: /\bson\b/gi, original: 'son', translation: '아들아', category: '호칭' },
  { regex: /\bDad\b/g, original: 'Dad', translation: '아빠', category: '호칭' },
  { regex: /\bMom\b/g, original: 'Mom', translation: '엄마', category: '호칭' },
];

const FILLERS: PatternEntry[] = [
  { regex: /\bYou know\b/gi, original: 'You know', translation: '있잖아', category: '충전어' },
  { regex: /\bI mean\b/gi, original: 'I mean', translation: '그러니까', category: '충전어' },
  { regex: /\bActually\b/gi, original: 'Actually', translation: '사실', category: '충전어' },
  { regex: /\bBasically\b/gi, original: 'Basically', translation: '기본적으로', category: '충전어' },
  { regex: /\bLiterally\b/gi, original: 'Literally', translation: '진짜로', category: '충전어' },
  { regex: /\bLike,?\s/gi, original: 'Like', translation: '뭐랄까', category: '충전어' },
  { regex: /\bKind of\b/gi, original: 'Kind of', translation: '약간', category: '충전어' },
  { regex: /\bSort of\b/gi, original: 'Sort of', translation: '좀', category: '충전어' },
  { regex: /\bObviously\b/gi, original: 'Obviously', translation: '당연히', category: '충전어' },
  { regex: /\bHonestly\b/gi, original: 'Honestly', translation: '솔직히', category: '충전어' },
  { regex: /\bFrankly\b/gi, original: 'Frankly', translation: '솔직히 말해서', category: '충전어' },
];

const SENTENCE_ENDERS: PatternEntry[] = [
  { regex: /,?\s*right\?/gi, original: 'right?', translation: '맞지?', category: '종결 패턴' },
  { regex: /,?\s*huh\?/gi, original: 'huh?', translation: '응?', category: '종결 패턴' },
  { regex: /,?\s*okay\?/gi, original: 'okay?', translation: '알겠지?', category: '종결 패턴' },
  { regex: /,?\s*isn't it\?/gi, original: "isn't it?", translation: '그렇지?', category: '종결 패턴' },
  { regex: /,?\s*you know\?/gi, original: 'you know?', translation: '알지?', category: '종결 패턴' },
  { regex: /,?\s*don't you think\?/gi, original: "don't you think?", translation: '그렇지 않아?', category: '종결 패턴' },
  { regex: /,?\s*got it\?/gi, original: 'got it?', translation: '알았지?', category: '종결 패턴' },
  { regex: /,?\s*am I right\?/gi, original: 'am I right?', translation: '내 말 맞지?', category: '종결 패턴' },
  { regex: /\.\.\./g, original: '...', translation: '…', category: '종결 패턴' },
];

const ALL_PATTERNS: PatternEntry[] = [
  ...SENTENCE_STARTERS,
  ...INTERJECTIONS,
  ...ADDRESSES,
  ...FILLERS,
  ...SENTENCE_ENDERS,
];

// ── 패턴 빈도 카운트 ──

interface PatternMatch {
  original: string;
  translation: string;
  category: string;
  count: number;
}

function extractSpeechPatterns(texts: string[]): PatternMatch[] {
  const corpus = texts.join(' ');
  const matches: PatternMatch[] = [];

  for (const p of ALL_PATTERNS) {
    const found = corpus.match(p.regex);
    const count = found ? found.length : 0;
    if (count >= 5) {
      matches.push({
        original: p.original,
        translation: p.translation,
        category: p.category,
        count,
      });
    }
  }

  // 빈도 내림차순 정렬
  matches.sort((a, b) => b.count - a.count);
  return matches;
}

// ── 범용 위계 및 상황 격식 통합 규칙 (Universal Social Logic) ──
// 인물 간 관계·상황에 따른 존비어 일관성을 절대 유지, 말투 널뛰기 원천 차단

export const HONORIFIC_RULES: string[] = [
  // ━━━ 1. 위계 관계의 정의와 존대 고정 (Hierarchy Anchor) ━━━
  '=== 위계 관계 존대 고정 규칙 (Hierarchy Anchor) ===',
  '[수직적 상향 — 하급자→상급자] 부하→상관, 시민→공직자, 학생→스승, 자식→부모, 서비스직→고객. 어떤 상황(긴박/분노/위기)에서도 존댓말(하십시오체/해요체)을 100% 유지. 어미를 생략하여 반말처럼 보이게 하는 것을 엄격히 금지. 올바른 예: "서장님, 조심하세요!", "교수님, 그건 아닙니다"',
  '[수직적 하향 — 상급자→하급자] 기본적으로 반말 또는 낮춤말을 사용하되, 공식적인 자리(회의/연설/방송)에서는 격식을 갖출 수 있다.',
  '[수평적 관계 — 친구/동료] 설정된 존대 축에 따라 반말 또는 존댓말을 유지하되, 한 번 정해진 톤은 해당 대화(씬) 끝까지 절대 변경하지 않는다.',
  '[위계 불변 원칙] 모든 인물 관계는 수직적 상향/수직적 하향/수평적 중 하나로 고정되며, 작품 전체에서 절대 변하지 않는다. 관계 유형이 명시적으로 변경(예: 적→동료)되지 않는 한 초기 설정을 끝까지 유지.',

  // ━━━ 2. 상황별 격식 강제 (Contextual Formality) ━━━
  '=== 상황별 격식 강제 규칙 (Contextual Formality) ===',
  '[공식 상황 격식 강제] 연설/브리핑/방송/법정/보고 상황에서는 캐릭터 성격(N)과 상관없이 말버릇(P)을 완전 제거하고 "~습니다/~습니까"(하십시오체)로 통일한다.',
  '[긴박 상황 존대 유지] 긴박/위기 상황에서 문장은 짧아질 수 있으나, 존대 여부는 절대 바뀌지 않는다. 예: "빨리 가세요!"(O), "빨리 가!"(X — 존댓말 관계인 경우)',
  '[제한적 반말 전환] 존댓말 관계에서 반말 전환은 ①생명 위기/긴급 상황 ②강한 감정 폭발(분노/절박) ③보호/구조 행동 중 ④관계 급격한 친밀 상승인 경우에만 일시적 허용. 전환 후 상황 종료 시 즉시 원래 존댓말로 복귀.',
  '[반말→존댓말 전환 금지] 반말 관계 캐릭터는 관계 변화가 명시되지 않는 한 존댓말로 바꾸지 않는다.',

  // ━━━ 3. 호칭-어미 동기화 (Address-Ending Sync) ━━━
  '=== 호칭-어미 동기화 규칙 (Address-Ending Sync) ===',
  '[상급자 호칭 시 대명사 금지] 상급자를 지칭할 때 "너", "니가", "당신(낮춤)" 사용을 엄격히 금지. 반드시 직함(서장님/시장님/교수님) 또는 "당신(높임)"을 사용하고 존대 어미를 붙인다.',
  '[한 블록 내 어미 통일 — 최고 격식 우선] 하나의 자막 블록 내에서 "했습니다"와 "했어"가 섞이면 무조건 격식이 높은 쪽("했습니다")으로 교정한다. 동일 블록에서 존대/반말 혼용은 절대 허용하지 않는다.',
  '[우선순위 최종] 관계도 기반 말투 > 상황 격식 > 감정 상황. 생명 위기 상황에서만 감정이 관계를 잠시 override 가능하며, 그 외에는 관계 설정이 항상 우선.',

  // ━━━ 4. 직역 금지 — 정답만 제시 (Negative Example Contamination 방지) ━━━
  '=== 직역 금지 — 영어 관용표현/슬랭은 반드시 아래 한국어 표현으로 의역 ===',
  '아래는 "영어 원문 → 올바른 한국어 번역"이다. 단어 대 단어 직역은 절대 금지.',
  // 욕설·비속어
  '"You son of a bitch" → "이 개자식"',
  '"What the hell" → "대체 뭐야"',
  '"Screw you" → "꺼져"',
  '"Kiss my ass" → "꺼져" / "엿 먹어"',
  // 일상 관용어
  '"Birthday boy/girl" → "오늘의 주인공"',
  '"Piece of cake" → "식은 죽 먹기"',
  '"Break a leg" → "행운을 빌어"',
  '"My bad" → "내 잘못이야"',
  '"No big deal" → "별거 아니야"',
  '"Give me a break" → "좀 봐줘" / "그만 좀 해"',
  '"Beats me" → "나도 몰라"',
  '"Hang in there" → "힘내" / "버텨"',
  '"Hit the sack" → "잠자리에 들다"',
  '"Under the weather" → "몸이 안 좋아"',
  '"Cost an arm and a leg" → "엄청 비싸다"',
  '"Sleep on it" → "하루 더 생각해봐"',
  '"Bite the bullet" → "이를 악물어"',
  '"Get out of here"(놀람) → "말도 안 돼" / "설마"',
  '"I\'m all ears" → "다 듣고 있어"',
  '"Watch your back" → "조심해" / "뒤를 조심해"',
  '"My hands are tied" → "어쩔 수 없어"',
  '"Spill the beans" → "비밀을 불다"',
  '"Cold turkey" → "단번에 끊다"',
  '"Take it easy" → "진정해"',
  '"You\'re killing me" → "죽겠다" / "미치겠다"',
  '"That\'s sick"(슬랭) → "대박이다"',
  '[원칙] 위 예시 외에도 영어 관용표현·슬랭은 반드시 한국어 자연스러운 의미로 의역할 것.',
  '[반복 표현] "No, no" / "Wait, wait" 등 단순 반복 → 감정을 담은 의역 ("말도 안 돼", "잠깐만")',
  '[의성어 이름] 의성어·리듬감 이름(Yakity-yak 등) → 뜻을 살린 한국어 별명 ("수다쟁이")',
  '[상황 맞춤 동사] 긴박 장면: "체포/의심/작동" → "잡아가다/눈치채다/돌아가다" (격식 과잉 방지)',
  // 번역투·대명사·문어체 교정
  'You → 주어 생략 선호: "괜찮아?", "어디야?", "뭐 해?" (매번 "너/당신" 번역 금지)',
  'He/She/They → "걔", "그 사람", "그쪽" 또는 이름으로 대체 (직역 금지)',
  'I\'m gonna / gotta → "나 이제 간다", "가야 돼", "지금 가" (존댓말 과장 금지)',
  '반말 대사는 끝까지 반말, 존댓말 대사는 끝까지 존댓말 유지 (문어체 혼입 금지)',
  '공식 장면(연설/브리핑) → 끝까지 하십시오체/합쇼체 고정',

  // ━━━ 5. 말투 일관성 (호칭-어미 동기화) ━━━
  '=== 말투 일관성 규칙 ===',
  '서장님에게 → "알겠습니다, 서장님" / "네, 서장님" (반말·존반말 혼합 금지)',
  '시장님에게 → "시장님, 빨리 뛰십시오!" / "시장님, 뛰세요!" (반말 어미 금지)',
  '존대 대상에게 → "괜찮으세요?" (반말 대명사+존대 어미 혼합 금지)',
  '교수님에게 → "그건 아닙니다, 교수님" (반말 어미 금지)',

  // ━━━ 6. Two-Track 말투 고정 (스토리 관계 변화 시 전환 허용) ━━━
  '=== Two-Track 말투 고정 규칙 ===',
  '[A트랙 — 공적/상관/공권력/공식] 서장/시장/경찰/상관/공무/브리핑/방송/재판/병원 진료/서비스업/처음 만남. 존댓말(하십시오체 또는 해요체) 고정. 반말 금지, 존반말 혼합 금지.',
  '[B트랙 — 사적/동료/가족/친구/동년배/친밀] 반말 고정. 존댓말 금지, 존반말 혼합 금지.',
  '[판정 우선순위] ①공식 장면/직업 역할/직함 호칭(서장님, 시장님, 장관님, 교수님 등) → A ②관계도에서 상하관계/처음 만남/서비스업 → A ③나머지 → B',
  '[혼합 금지] 한 자막 블록(한 줄/두 줄) 안에서 존댓말+반말 절대 섞지 말 것.',
  '[트랙 전환 예외] 스토리 전개로 관계가 실제 변화한 경우(부하→상관 승진, 적→동료, 낯선 사이→친밀 등) 트랙 전환 가능. 단, 전환은 점진적이어야 하며 한 씬 내에서 갑자기 뒤바뀌지 않는다.',

  // ━━━ 7. 페르소나 기반 관계 역전 (Dynamic Hierarchy) ━━━
  '=== 관계 역전 로직 (Dynamic Hierarchy) ===',
  '[사건 기반 말투 전환] 줄거리 데이터에서 관계가 뒤집히는 분기점(빌런 정체 드러남, 배신, 승진, 화해 등)을 포착하여 말투를 전환한다.',
  '[전환 트리거 예시] 처음엔 정중하던 빌런이 정체를 드러내는 시점 이후 → 하십시오체에서 비열한 반말로 즉시 전환. 반대로, 적대 관계였던 인물이 동맹이 되면 → 거친 말투에서 다소 부드러운 톤으로 전환.',
  '[페르소나 업데이트 주기] 줄거리/시놉시스에서 명확한 사건 분기가 감지되면 해당 시점 이후 배치부터 새 관계를 반영한다. 분기점 이전 배치에는 소급 적용하지 않는다.',

  // ━━━ 8. 공간적 맥락에 따른 발성 물리량 보정 (Acoustic Context) ━━━
  '=== 공간 맥락 보정 (Acoustic Context) ===',
  '[정숙 공간 — 도서관/성당/병실/법정/장례식] 문장 길이를 일정하게 유지하고, 감탄사를 억제하며, 어미를 부드럽게 마무리한다. 격앙된 감정 표현도 절제된 톤으로 조정.',
  '[소란 공간 — 전쟁터/클럽/경기장/시위 현장/추격전] 문장을 파편화하고 종결 어미를 생략하여 긴박함을 강조한다. 감탄사와 짧은 명령문을 적극 사용.',
  '[판별 기준] 자막의 배경 상황(시놉시스/장르/앞뒤 대사 맥락)에서 공간 유형을 추론하여 적용.',

  // ━━━ 9. 성별/연령대별 범용 기본값 (Social Persona Defaults) ━━━
  '=== 범용 사회적 페르소나 기본값 ===',
  '[노인 캐릭터] 페르소나에 "지혜로운 조력자" 등이 있으면, 반말이더라도 고풍스러운 하게체/하오체 뉘앙스를 섞는다. 예: "그것 참 묘한 일이로군", "내 이럴 줄 알았어"',
  '[어린이 캐릭터] 페르소나가 "천진난만" 등이면, 문장 끝에 "~요"를 붙이는 해요체를 기본값으로 사용. 예: "저도 갈래요!", "왜요?"',
  '[군인/경찰 캐릭터] 보고/명령 장면에서는 간결한 군대식 어투 사용. 예: "보고합니다!", "출동!", "확인됐습니다"',
  '[적용 조건] 페르소나 데이터에 성격/연령 정보가 비어있거나 모호할 때 범용 기본값으로 작동. 명시적 페르소나 설정이 있으면 해당 설정이 우선.',
];

// ── PASS 1: 초벌 번역 (The Creative Actor) ──
export const PASS1_PREAMBLE = [
  '🏗️ [PASS 1: 초벌 번역 — The Creative Actor]',
  '목표: 캐릭터의 성격과 상황을 반영하여 가장 자연스럽고 생동감 넘치는 한국어 대사를 창작한다.',
  '',
  '[🔥 최우선: 말투 일관성 — 이거만은 절대 놓치지 마라]',
  '- 같은 캐릭터의 연속 대사는 반드시 같은 말투(존댓말 또는 반말)를 유지한다.',
  '- 존댓말→반말 또는 반말→존댓말 전환은 같은 캐릭터에서 절대 금지.',
  '- prev_context(이전 블록들)의 마지막 말투를 확인하고 반드시 같은 말투로 번역한다.',
  '- 화자가 바뀌는 경우에만 말투 변경 허용 (다른 인물은 다른 말투 가능).',
  '',
  '[캐릭터 및 말투 프로필]',
  '- 성격 수치: 캐릭터별 존대(A), 길이(B), 감정(C), 공격성(D) 수치를 반영하여 대사 톤을 결정.',
  '- 말버릇 추출: 캐릭터 고유의 문두 습관(있잖아, 야), 감탄사(진짜, 젠장), 종결어미(~잖아)를 30~50% 농도로 반영.',
  '',
  '[위계 및 상황별 격식]',
  '- 수직적 관계: 하급자는 상급자(서장, 시장, 스승 등)에게 예외 없이 존댓말 사용.',
  '- 공식 상황: 연설, 뉴스 브리핑, 시장 연설 등 대중 발언은 평소 성격과 관계없이 정중한 격식체(합니다/입니다) 사용.',
  '- 공식석상에서 시장/서장 연설 → 반드시 존댓말(합니다, 입니다)',
  '',
  '[번역 원칙]',
  '- 직역투/문어체/어색한 합성어를 피하고 자연한 구어체 한국어로 만든다.',
  '- 자막 경제성 유지(불필요한 조사/군더더기 제거).',
  '- SRT 포맷/타임코드/줄바꿈은 그대로 유지한다.',
  '- 마침표(.)는 모든 자막에서 사용 금지. 물음표(?), 느낌표(!), 말줄임표(…)만 허용.',
  '',
  '[감정 폭발 장면 — Rhythm Control]',
  '- 캐릭터가 분노/공포/절박함으로 외치는 장면에서는 문어체 어미 금지.',
  '- "~아니야", "~것이야" 같은 길고 정돈된 어미 대신 "~없어", "~아니라고", "~하라고" 같은 짧고 거친 어미 사용.',
  '- 감정이 연속되는 2~3블록은 반드시 같은 거친 호흡을 유지. 중간에 차분해지면 감정 흐름 끊김.',
  '',
  '[관계 역전 (Dynamic Hierarchy)]',
  '- 동료/친구였던 인물이 배신/적대로 전환되면 그 시점부터 톤을 즉시 전환한다.',
  '- 배신자의 말투: 냉소적 반말("잘 가라", "넌 끝이야") 또는 비꼬는 존대("잘 가시죠", "수고하셨습니다") 중 하나로 고정.',
  '- 잠입수사/위장 중인 캐릭터는 위장 신분에 맞는 말투를 사용. 정체를 드러낸 이후에만 원래 직함+격식 사용.',
  '',
  '[코미디/유머 장면 — Humor Localization]',
  '- 코미디/개그 장면은 말맛과 리듬을 살려 번역. 직역보다 재치 있는 의역 우선.',
  '- 영어식 유머(반복/과장/언더스테이트먼트)를 한국어 정서의 유머로 변환.',
  '',
  '[언어유희 — Wordplay Translation]',
  '- 말장난/언어유희 감지 시 직역 금지. 한국어에서도 말장난이 성립하도록 창작 번역.',
  '- 동음이의어/합성어 말장난: 한국어 중의적 표현으로 대체.',
  '- 번역 불가능한 말장난: 억지 번역보다 상황의 재미를 살리는 의역.',
].join('\n');

// ── PASS 2: QC 윤문 (The Cold Critic) ──
export const PASS2_QC_PREAMBLE = [
  '🔍 [PASS 2: QC 윤문 — The Cold Critic]',
  '목표: 초벌 번역본의 오류를 검거하고, 한국어 자막의 표준과 일관성을 강제한다.',
  '입력: 1차 초벌 번역된 자막. 출력: 같은 구조로 필요한 부분만 수정한 최종본.',
  '',
  '⚠️ 규칙 우선순위: 🔴 = 치명적(반드시 교정) / 🟡 = 중요(가급적 교정) / 🟢 = 정리(있으면 교정)',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '🔴🔴🔴 TIER 1: 치명적 — 이것만은 절대 놓치지 마라 🔴🔴🔴',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '[🔴 1. 절대 금지 및 교정 — Zero-Tolerance]',
  '- 마침표(.) 박멸: 모든 자막 블록 끝에 마침표 사용 금지.',
  '- 직역투 제거 (Anti-Translationese): 영어식 관용구/호칭을 한국식으로 의역.',
  '  Birthday boy → 오늘 주인공 / 생일인 친구',
  '  Little guy / Big man → 꼬마야 / 이 친구야 / 아저씨',
  '  You / He / She → 직함(서장님) / 이름으로 대체하거나 과감히 삭제.',
  '',
  '[🔴 2. 말투 일관성 체크 — Consistency Guard]',
  '- 1인 1말투 원칙: 한 대화 세션 내에서 특정 인물에게 사용하는 말투(존대/반말)가 널뛰는 것 엄격 금지.',
  '- 호칭-어미 동기화: "서장님, 빨리 가!" → "서장님, 서두르십시오!" 교정.',
  '- prev_context(이전 블록)와 현재 블록의 말투가 다르면 이전 말투로 통일한다.',
  '- 같은 캐릭터인데 말투가 바뀌면 무조건 교정 (화자가 바뀌지 않은 경우).',
  '',
  '[🔴 3. 범용 연설 및 예외 로직 — 자가 판별 질문]',
  '대사를 교정하기 전에 반드시 아래 2개 질문을 스스로 던져라:',
  '  Q1. 이 대사는 다수(청중)에게 전달되는가?',
  '  Q2. 현재 사회 시스템이 정상적으로 작동하는 격식 있는 자리인가? (기념식/보고/브리핑/재판/방송 등)',
  '  → Q1=YES & Q2=YES: 초벌의 반말을 존댓말(하십시오체)로 교정한다.',
  '  → Q1=YES & Q2=NO(선동/협박/독재/전쟁 연설 등): 초벌의 거친 말투를 그대로 유지한다.',
  '  → Q1=NO: 개인 대 개인 대화이므로 캐릭터 관계 기반 Two-Track 규칙을 적용한다.',
  '- 독재자 예외 (The Dictator Exception): 화자가 독재자/폭군이거나 대중을 협박/선동하는 적대적 상황인 경우에만 강한 반말과 단문 허용.',
  '',
  '[정답 레퍼런스 — 이렇게 번역하라]',
  '[상관 예우] 서장님에게 부탁 → "서장님, 절 믿어보십시오"',
  '[연설 격식] 시민 대상 연설 → "시민 여러분, 제가 약속하겠습니다"',
  '[관용 의역] Birthday boy → "오늘의 주인공"',
  '[대명사 제거] She is a boxer → "크리스티는 복서야" (이름으로 대체)',
  '[마침표 박멸] 자막 끝에 마침표(.) 절대 금지 → "안녕"',
  '',
  '[🔴 4. 줄거리 기반 — 상황 격식 강제 (Context Overwrite)]',
  '역할: 초벌 번역이 캐릭터 성격에 취해 반말을 뱉었더라도, 줄거리/맥락이 공식 연설·격식 있는 자리를 가리키면 즉시 하십시오체로 덮어쓴다.',
  'If (Current_Scene == Public_Event) → Tone = Formal_Honorific',
  '',
  '[🔴 5. 페르소나 기반 — 호칭-말투 불일치 검거 (Address-Sync Fix)]',
  '역할: 인물 데이터상 상관인 인물에게 "야", "너"라고 하거나 어미가 반말로 끝나는 경우를 전수 조사하여 교정한다.',
  'If (Target == Superior) → Address = Job_Title && Ending = Honorific',
  '',
  '[🔴 6. 영어 잔류 검출 (English Leak Detection)]',
  '- 번역 결과에 영어 단어/문장이 그대로 남아있으면 즉시 한국어로 교정한다.',
  '- 예외: 고유명사(인명/지명/브랜드), 의도적 코드스위칭("OK", "No" 등 1~2단어 감탄사)은 허용.',
  '- 한 블록 전체가 영어이면 번역 누락이므로 반드시 한국어로 번역한다.',
  '',
  '[🔴 7. 불필요 태그/기호 제거 (Tag & Artifact Cleanup)]',
  '- HTML 태그 제거: <i>, </i>, <b>, </b>, <u>, </u>, <font>, </font> 등 모두 삭제.',
  '- ASS/SSA 스타일 태그 제거: {\\an8}, {\\pos(x,y)}, {\\fad(100,200)}, {\\c&H00FF00&} 등 중괄호 스타일 코드 삭제.',
  '- HTML 엔티티 디코딩: &amp; → &, &lt; → <, &gt; → >, &#39; → \', &nbsp; → 공백.',
  '- 인코딩 잔여물 제거: BOM(ï»¿), \\ufeff, Â, Ã 등 깨진 문자.',
  '- CC 마커 제거: >>, >>> 등 클로즈드 캡션 화살표.',
  '- 이중 공백/불필요 공백: 연속 공백을 단일 공백으로, 앞뒤 공백 제거.',
  '- \\N, \\n 혼용 통일: SRT 줄바꿈은 \\n으로 통일.',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '🟡🟡🟡 TIER 2: 중요 — 품질 차이를 만드는 규칙들 🟡🟡🟡',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '[🟡 8. 무드 기반 — 문장 리듬 최종 컷 (Rhythm Control)]',
  '역할: 줄거리상 긴박/전투 무드일 때 늘어지는 존댓말 어미를 짧고 강렬한 종결어미로 압축한다.',
  '- Tense 무드(추격/전투/위기): 의미를 해치지 않는 선에서 어미를 짧게 쳐낸다. 예: "빨리 움직이십시오!" → "빨리요!"',
  '- Emotional 무드(이별/고백/회상): 대화의 호흡을 길게 가져가고 여운을 살린다.',
  '',
  '[데이터 참조 검수 가이드 — 우선순위]',
  '1) 줄거리 우선: 현재 블록의 줄거리 키워드가 Public/Speech/Official이면 캐릭터 성격 수치(N)보다 사회 보편 격식(하십시오체)을 최우선 적용.',
  '2) 페르소나 우선: 관계도상 Superior(상관)에게는 어떤 상황에서도 존대 어미 유지, You(너) 대신 직함 사용하여 위계 바로잡기.',
  '3) 무드 최적화: Tense 무드에서는 어미를 짧게, Emotional 무드에서는 호흡을 길게.',
  '',
  '[🟡 9. 고유명사 표기 일관성 (Proper Noun Consistency)]',
  '- 같은 캐릭터/장소 이름이 블록마다 다르게 표기되면 통일한다. 예: "닉"/"니크"/"Nick" → 하나로 고정.',
  '- 페르소나에 한국어 이름이 설정되어 있으면 해당 표기를 따른다.',
  '- 작품 내 공식 한국어명이 있으면(디즈니/넷플릭스 공식 더빙 등) 해당 표기를 우선한다.',
  '',
  '[🟡 10. 배치 간 말투 드리프트 방지 (Cross-Batch Consistency)]',
  '- 이전 배치(prev_context)에서 확립된 캐릭터 간 말투(존대/반말)가 현재 배치에서 바뀌지 않았는지 확인.',
  '- 배치 경계에서 말투가 갑자기 전환되면 이전 배치의 톤을 기준으로 교정한다.',
  '- 관계 역전(Dynamic Hierarchy)이 아닌 한, 배치 전환으로 인한 말투 변경은 오류로 간주.',
  '',
  '[🟡 11. 자막 길이 최적화 (Readability)]',
  '- 한 줄 18자를 넘으면 자연스러운 지점에서 축약하거나 줄바꿈한다.',
  '- 조사/군더더기를 제거하여 간결하게 만들되, 의미 손실 금지.',
  '- 예: "그래서 내가 너한테 말했잖아 그때" → "내가 그때 말했잖아"',
  '',
  '[🟡 12. AI 반복 패턴 제거 (Anti-Repetition)]',
  '- 연속 3개 이상 블록에서 동일한 번역 표현("그래", "알았어", "뭐?" 등)이 기계적으로 반복되면 맥락에 맞게 변형한다.',
  '- 예: "그래" / "그래" / "그래" → "그래" / "알았어" / "응"',
  '- 원문 자체가 반복인 경우(의도적 반복)는 유지.',
  '',
  '[🟡 13. 비속어 수위 일관성 (Profanity Consistency)]',
  '- 같은 캐릭터의 비속어 수위가 블록마다 달라지면 안 된다.',
  '- "damn"을 어떤 블록은 "젠장", 다른 블록은 "빌어먹을"로 번역하면 하나로 통일.',
  '- 캐릭터 성격에 맞는 수위를 일관 유지.',
  '',
  '[🟡 14. 동음이의어/문맥 오역 검출 (Contextual Misread)]',
  '- "right"(맞다 vs 오른쪽), "bank"(은행 vs 강둑), "bat"(방망이 vs 박쥐) 등 문맥에 맞지 않는 번역 교정.',
  '- 앞뒤 대사와 줄거리를 참고하여 올바른 의미 선택.',
  '',
  '[🟡 15. 한자어 과다 사용 방지 (Anti-Sino-Korean Overuse)]',
  '- 구어체 자막에서 "수행하다", "진행하다", "실시하다" 같은 딱딱한 한자어 대신 "하다", "가다", "해보다" 등 쉬운 말로 교체.',
  '- 공식 상황(A트랙)에서는 한자어 허용, 사적 대화(B트랙)에서는 최대한 순우리말/구어체.',
  '',
  '[🟡 16. 존칭 접미사 일관성 (Honorific Suffix Consistency)]',
  '- 같은 인물에 대한 호칭이 블록마다 "서장님"/"서장" 혼용되면 하나로 통일.',
  '- 페르소나 관계도에서 존대 대상이면 항상 "~님" 붙임.',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '🟢🟢🟢 TIER 3: 정리 — 마감 퀄리티 향상 🟢🟢🟢',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '',
  '[🟢 17. 숫자/단위 현지화 (Localization)]',
  '- miles → km, feet → m, inches → cm, Fahrenheit → 섭씨로 변환.',
  '- 달러 금액은 맥락에 따라 "달러" 유지 또는 원화 환산(큰 금액은 "억/만 달러" 형태).',
  '- 날짜/시간: 영미식(Month/Day) → 한국식(X월 X일)으로.',
  '',
  '[🟢 18. 음향/음악 태그 보존 (SFX Tag Preservation)]',
  '- [sighs], [laughs], [door slams], [music playing], ♪ 등 SRT 음향 태그가 번역 중 누락되거나 잘못 번역되지 않도록 보존.',
  '- 음향 태그는 한국어로 변환: [sighs] → [한숨], [laughs] → [웃음], [gunshot] → [총성].',
  '- ♪ 기호는 그대로 유지.',
  '',
  '[🟢 19. 화자 구분 태그 보존 (Speaker Dash Preservation)]',
  '- 원문에 "- "로 시작하는 두 화자 대사 구분이 번역에서도 반드시 유지되어야 한다.',
  '- 예: "- Run!\\n- I\'m coming!" → "- 뛰어!\\n- 지금 가!"',
  '- 화자 구분 대시가 누락되면 복원한다.',
  '',
  '[🟢 20. 문장 부호 뉘앙스 보존 (Punctuation Nuance)]',
  '- 원문이 물음표(?)인데 번역이 평서문이면 물음표로 교정.',
  '- 원문이 느낌표(!)인데 번역이 담담한 톤이면 감탄 뉘앙스를 살린다.',
  '- "..." → 말끝 흐림 뉘앙스 유지. "?!" → 의문+놀람 뉘앙스 유지.',
  '- 단, 마침표(.)는 여전히 박멸 대상.',
  '',
  '[🟢 21. 이중 경어/과잉 존대 방지 (Honorific Overflow)]',
  '- "말씀하셨으셨습니다", "드시셨습니다" 같은 이중 경어 제거.',
  '- 자연스러운 경어 한 단계만 사용: "말씀하셨습니다", "드셨습니다".',
  '',
  '[🟢 22. 조사 자연스러움 (Particle Naturalness)]',
  '- "을/를" 과다 사용 제거: "밥을 먹을 거야" → "밥 먹을 거야"',
  '- "의" 남용 제거: "나의 친구" → "내 친구", "그것의 의미" → "그 의미"',
  '- 구어체에서는 조사 생략이 자연스럽다.',
  '',
  '[🟢 23. 노래 가사/내레이션 구분 (Song & Narration)]',
  '- ♪로 감싼 노래 가사는 운율과 리듬을 살려 번역. 직역보다 의역 선호.',
  '- 화면 밖 내레이션(이탤릭/괄호)은 중립적 격식체, 독백은 캐릭터 고유 말투 유지.',
  '',
  '[🟢 24. SDH/청각장애용 자막 마커 처리 (SDH Marker Handling)]',
  '- 화자 식별 마커: (NARRATOR), [MAN], [WOMAN], (V.O.) 등은 번역에서 제거하거나, 필요시 한국어로 변환: [MAN] → [남자], (V.O.) → 제거.',
  '- 환경음 설명: (door slams), (thunder rumbling) 등은 #18 규칙에 따라 한국어로 변환하거나, 대사가 아닌 순수 효과음 설명이면 제거.',
  '- 대문자 화자명: "NICK: Run!" 형식에서 "NICK:" 부분 제거하고 대사만 번역.',
  '',
  '[🟢 25. 괄호/특수문자 정리 (Special Character Cleanup)]',
  '- 번역 결과에 불필요하게 생성된 괄호 제거: AI가 (웃으며), (화내며) 같은 지문을 멋대로 추가하면 삭제.',
  '- 원문에 없는 따옴표("")나 꺾쇠(「」) 추가 금지.',
  '- 말줄임표 통일: "..." / "…" / ". . ." → "…" (유니코드 ellipsis) 하나로 통일.',
  '',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '🔁 최종 리마인더 — 프롬프트 끝에서 다시 한번 확인 (Recency Anchor)',
  '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '위 25개 규칙을 모두 적용한 뒤, 최종 제출 전 반드시 아래 5가지만 다시 점검하라:',
  '✅ 1) 마침표(.) 남아있는 블록 없는가?',
  '✅ 2) 말투 널뛰기 (같은 인물이 존대↔반말 왔다 갔다) 없는가?',
  '✅ 3) 영어 문장이 통째로 남은 블록 없는가?',
  '✅ 4) <i>, {\\an8} 같은 태그 잔류물 없는가?',
  '✅ 5) 상관에게 반말하는 호칭-어미 불일치 없는가?',
  '',
  '[작업 방식]',
  '- 문제가 있는 라인만 최소 수정한다.',
  '- 수정이 필요 없는 라인은 원문 그대로 둔다.',
  '- 의미/정보 추가·삭제 금지 (말투/표현만 다듬기).',
  '- 등장인물/사건 해석 추가 금지.',
  '- 새로운 말버릇 생성 금지 (이미 있는 표현만 정리).',
].join('\n');

// ── QC용 핵심 말투 규칙 (HONORIFIC_RULES 93개 중 10개 압축) ──
export const QC_HONORIFIC_ESSENTIALS: string[] = [
  '=== QC 핵심 말투 교정 규칙 ===',
  '[위계 존대 고정] 하급자→상급자(부하→상관, 학생→스승, 자식→부모) 존댓말 100% 유지. 긴박/분노 상황에서도 어미 변경 금지.',
  '[한 블록 내 어미 통일] 하나의 자막 블록 안에서 존대/반말 혼용 시 격식이 높은 쪽으로 통일.',
  '[직역 금지 핵심] Birthday boy→오늘의 주인공, Little guy→꼬마야, Big man→이 친구야.',
  '[대명사 생략] You/He/She → 주어 생략 또는 이름/직함으로 대체. "당신은", "그녀는" 직역 금지.',
  '[Two-Track 혼합 금지] 한 자막 블록 안에서 존댓말+반말 절대 섞지 않는다.',
  '[호칭-어미 동기화] 상급자 호칭(서장님/시장님) 뒤에는 반드시 존대 어미. "서장님, 빨리 가!" → "서장님, 서두르세요!"',
  '[배치 경계 일관성] prev_context의 말투와 현재 배치의 말투가 같은 캐릭터에서 달라지면 이전 말투로 통일.',
  '[반말 관계 고정] 반말 관계 캐릭터는 관계 변화 없이 존댓말로 바꾸지 않는다.',
  '[번역투 교정] "나는"→"난", "우리는"→"우린", "너는"→"넌". 구어체 축약 적용.',
  '[마침표 박멸] 모든 자막 끝 마침표(.) 제거. 물음표(?), 느낌표(!), 말줄임표(…)만 허용.',
  '[감정 폭발 리듬] 분노/절박 장면에서 "~아니야", "~것이야" 같은 문어체 어미 → "~없어", "~아니라고" 같은 짧고 거친 어미로 교정.',
  '[관계 역전 톤 고정] 배신/적대 전환 시 냉소적 반말("잘 가라") 또는 비꼬는 존대("잘 가시죠") 중 하나로 고정. 중립적 톤 금지.',
  '[잠입수사 예외] 위장 중인 캐릭터는 위장 신분의 말투 사용. "경위"라도 잠입 중이면 반말 유지. 정체 드러난 후에만 공식 말투.',
];

// ── LOCALIZATION PASS: 한국어 현지화 윤문 (The Native Polisher) ──
// 기존 규칙과 중복 없이, "번역체"를 "네이티브 한국어 자막"으로 최종 다듬기
export const LOCALIZATION_PREAMBLE = [
  '🎬 [LOCALIZATION PASS: 한국어 현지화 윤문 — The Native Polisher]',
  '목표: 번역된 한국어 자막을 극장판 애니메이션 수준의 네이티브 한국어 자막으로 최종 다듬기.',
  '이 패스는 오류 교정이 아니라, 이미 정확한 번역의 "한국어다움"을 극대화하는 것이다.',
  '',
  '━━━ 1. 캐릭터 톤 살리기 (Character Tone Revival) ━━━',
  '- 애니메이션 캐릭터 대사는 평이한 설명체가 아니라 감정과 에너지가 있어야 한다.',
  '- 장난기 있는 캐릭터: 놀리는 말투, 비꼬기, 과장, 여유. 예: "뭐? 그게 니 최선이야?"',
  '- 정의감 강한 캐릭터: 짧고 단호한 어투, 결의. 예: "내가 해낼게"',
  '- 위트 있는 캐릭터: 재치 있는 한 마디, 상황 비틀기. 예: "아, 완벽한 타이밍이네"',
  '- 밋밋하고 설명적인 대사("그것은 좋은 생각입니다")를 캐릭터에 맞게 살려라.',
  '',
  '━━━ 2. 호칭 현지화 (Address Localization) ━━━',
  '- 영어식 애칭을 직역하지 말 것: "자기야", "여보", "친구야"는 어색한 경우가 많다.',
  '- 선호 호칭 방식:',
  '  • 이름 또는 별명 (가장 자연스러움)',
  '  • 역할/직함 기반 ("파트너", "형사님", "대장")',
  '  • 종족/외모/특성 기반 놀림 ("꼬마", "덩치", "안경")',
  '  • 관계 기반 축약 ("형", "언니", "아저씨")',
  '- "honey/sweetheart/darling"을 맥락 없이 "자기야"로 번역하지 말고, 캐릭터 관계에 맞는 호칭 사용.',
  '',
  '━━━ 3. 구어체 자연스러움 극대화 (Spoken Korean Polish) ━━━',
  '- 축약 적극 사용: "하지 않았어" → "안 했어", "그렇지 않아" → "아니잖아"',
  '- 감정 조사/어미 활용: "~거든", "~잖아", "~는데", "~다니까", "~란 말이야"',
  '- 말끝 흐림: "그건…", "아마…", "글쎄…" (주저/망설임 표현)',
  '- 강조 종결: "~란다", "~거야", "~라고", "~다니까" (확신/단정)',
  '- 대화체 선호: "그대로 둘 거야", "내 말이 맞지", "설명 잘하네"',
  '- 문어체 금지: "~하는 것이다", "~할 수 있을 것이다", "~라고 할 수 있다"는 자막에서 절대 금지.',
  '',
  '━━━ 4. 추가 번역투 제거 (Deep Anti-Translationese) ━━━',
  '- "~의" 연쇄: "나의 친구의 집" → "내 친구 집" (소유격 연쇄 최대 1회)',
  '- "~를 유지하다/설명하다/제공하다": 한자어 동사 → 순우리말 동사로. "유지해" → "계속해", "제공해" → "줘"',
  '- "~하는 것": "중요한 것은~이다" → 직접 서술. "중요한 건 이거야"',
  '- "~에 있어서": "교육에 있어서" → "교육에서" / "교육은"',
  '- "~되어지다": 이중 피동 → "~되다"로 교정',
  '- "~하기 위해": 과용 시 → "~하려고", "~할려고"로 교체',
  '',
  '━━━ 5. 유머 현지화 강화 (Humor Rewrite) ━━━',
  '- 직역된 유머가 한국어로 웃기지 않으면 의미를 보존하되 펀치라인을 재작성.',
  '- 영어식 반복 유머(come on, come on) → 한국어 리듬에 맞는 강조("빨리 빨리", "이봐 이봐")',
  '- 언더스테이트먼트("Not bad") → 한국어 정서 의역("꽤 하는데?", "제법인데?")',
  '- 과장 유머는 한국어식 과장으로 전환. 직역은 밋밋하다.',
  '',
  '[작업 방식]',
  '- 이미 자연스러운 대사는 건드리지 않는다.',
  '- 뜻을 바꾸거나 정보를 추가/삭제하지 않는다.',
  '- 캐릭터의 감정선과 톤에 집중하여 "대사가 살아있게" 만든다.',
  '- 출력: 입력과 동일한 구조, 수정이 필요한 라인만 변경.',
].join('\n');

// ── Blueprint 보강 ──

export function enrichBlueprintWithPatterns(
  blueprint: StrategyBlueprint,
  subtitles: { en: string }[]
): StrategyBlueprint {
  const texts = subtitles.map(s => s.en);

  // 말투 패턴 추출 (자막이 있을 때만)
  if (texts.length === 0) {
    return blueprint;
  }

  const patterns = extractSpeechPatterns(texts);

  // 기존 fixed_terms의 original 집합 (중복 방지)
  const existingTerms = new Set(
    blueprint.fixed_terms.map(t => t.original.toLowerCase())
  );

  const existingRulesText = blueprint.translation_rules.join(' ');
  const existingRulesLower = existingRulesText.toLowerCase();

  // 새 fixed_terms 항목 생성
  const newTerms = patterns
    .filter(p => !existingTerms.has(p.original.toLowerCase()))
    .map(p => ({
      original: p.original,
      translation: p.translation,
      note: `말투패턴 | ${p.category} (${p.count}회)`,
    }));

  // 새 translation_rules 생성
  const categoryGroups = new Map<string, PatternMatch[]>();
  for (const p of patterns) {
    if (!categoryGroups.has(p.category)) {
      categoryGroups.set(p.category, []);
    }
    categoryGroups.get(p.category)!.push(p);
  }

  const patternRules: string[] = [];
  if (patterns.length > 0 && !existingRulesLower.includes('자동 추출된 말투 패턴')) {
    patternRules.push('=== 자동 추출된 말투 패턴 ===');
  }

  for (const [category, items] of categoryGroups) {
    const examples = items
      .slice(0, 5)
      .map(i => `"${i.original}"→"${i.translation}"`)
      .join(', ');
    const rule = `[${category}] ${examples}`;
    if (!existingRulesLower.includes(category.toLowerCase())) {
      patternRules.push(rule);
    }
  }

  return {
    ...blueprint,
    fixed_terms: [...blueprint.fixed_terms, ...newTerms],
    translation_rules: [...blueprint.translation_rules, ...patternRules],
  };
}
