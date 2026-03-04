import os
import json
import time
from typing import Optional, Tuple, Any
from google import genai
# V3: 핵심 3모듈만 로드 (k_cinematic + speech_enforcement + supplementary)
from app.core.k_cinematic_prompt import build_v3_cinema_prompt, get_v3_master_system_prompt
from app.core.universal_speech_consistency import (
    get_speech_enforcement_for_translation,
    format_confirmed_speech,
)
from app.core.v3_supplementary_rules import get_v3_supplementary_rules

# 재시도 설정
MAX_RETRIES = 3
INITIAL_BACKOFF_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 30.0


class VertexTranslator:
    """
    Subtitle OS: Gemini 3 Flash on Vertex AI
    150개 단위 배치 번역 및 문맥 보존 알고리즘.
    
    환경변수:
    - GCP_PROJECT_ID: GCP 프로젝트 ID (필수)
    - GOOGLE_APPLICATION_CREDENTIALS: 서비스 계정 JSON 키 경로 (필수)
    - GCP_REGION: Vertex AI 리전 (기본값: us-central1)
    - GEMINI_MODEL: Gemini 모델 버전 (기본값: gemini-3-flash)
    """
    
    def __init__(self, project_id: str = None, location: str = None):
        # 환경변수에서 설정 로드
        self.project_id = project_id or os.getenv("GCP_PROJECT_ID")
        self.location = location or os.getenv("GCP_REGION", "us-central1")
        self.model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
        
        # 필수 환경변수 검증
        if not self.project_id:
            raise ValueError(
                "GCP_PROJECT_ID 환경변수가 설정되지 않았습니다. "
                ".env 파일 또는 환경변수를 확인하세요."
            )
        
        credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        if not credentials_path:
            print("[WARN] GOOGLE_APPLICATION_CREDENTIALS가 설정되지 않았습니다. "
                  "gcloud auth가 설정되어 있어야 합니다.")
        elif not os.path.exists(credentials_path):
            raise ValueError(
                f"서비스 계정 키 파일을 찾을 수 없습니다: {credentials_path}"
            )
        
        # Gemini 클라이언트 초기화 (Vertex AI 모드)
        self.client = genai.Client(
            vertexai=True,
            project=self.project_id,
            location=self.location
        )
        
        print(f"[OK] Gemini on Vertex AI 초기화 완료")
        print(f"  - Project: {self.project_id}")
        print(f"  - Region: {self.location}")
        print(f"  - Model: {self.model}")

    def _get_genre_rules(self, genre: str) -> str:
        """장르별 번역 규칙 반환"""
        genre_lower = genre.lower() if genre else ""

        rules = {
            "액션": """• 짧고 강렬한 문장 유지 (긴장감 극대화)
• 전투/추격 장면: 동사 중심의 간결한 표현
• 욕설/비속어: 한국 관객에 맞게 자연스럽게 현지화
• 명령조와 단정적 어조 활용
• 예: "Get down!" → "엎드려!" / "Move!" → "움직여!"
• 긴박한 상황: 감탄사와 짧은 호흡 유지""",

            "로맨스": """• 감정의 섬세한 뉘앙스 보존
• 고백/이별 장면: 서정적이고 부드러운 표현
• 애칭과 호칭의 자연스러운 번역
• 예: "honey", "darling" → 상황에 맞게 "자기야", "여보", "오빠/언니"
• 로맨틱한 대사: 한국 정서에 맞는 표현으로 현지화
• 감정선 유지: 설렘, 그리움, 애틋함 등 미묘한 차이 구분""",

            "코미디": """• 유머 코드 현지화 (한국인이 웃을 수 있는 표현)
• 언어유희/말장난: 의미보다 웃음 우선 번역
• 예: 영어 펀(pun)은 한국식 말장난으로 대체
• 과장된 표현과 리듬감 유지
• 타이밍이 중요한 대사: 간결하게
• 슬랩스틱: 의성어/의태어 적극 활용""",

            "공포": """• 불안감과 긴장감 조성하는 어휘 선택
• 짧은 문장으로 공포 분위기 극대화
• 비명/신음: 한국식 감탄사로 ("으악!", "끄아악!")
• 저주/주문: 원문 분위기 유지하되 자연스럽게
• 속삭임/중얼거림: 불길한 느낌 살리기
• 반전 대사: 임팩트 있게""",

            "스릴러": """• 긴장감 유지하는 간결한 문체
• 복선/암시: 미묘하게 힌트 주는 표현
• 심문/대치 장면: 날카로운 대화체
• 반전 대사: 충격 효과 극대화
• 내면 독백: 불안과 의심 표현
• 추리 단서: 정확한 정보 전달""",

            "드라마": """• 감정의 깊이와 진정성 전달
• 세대/계층별 말투 구분 철저
• 가족 호칭: 한국 가족 문화에 맞게
• 갈등 장면: 감정의 고조 표현
• 화해/용서: 진심이 느껴지는 표현
• 삶의 통찰: 자연스러운 한국어로""",

            "sf": """• 전문 용어: 기존 번역 관례 따르기 (하이퍼드라이브, 워프 등)
• 새로운 개념: 직관적으로 이해 가능한 한국어 조어
• 과학 설명: 정확성 유지하되 자연스럽게
• 미래 세계관: 일관된 용어 사용
• AI/로봇 대화: 기계적 느낌 살리기 (선택적)""",

            "판타지": """• 판타지 용어: 기존 한국 판타지 문화 활용
• 주문/마법: 신비로운 느낌 유지
• 고대/중세 배경: 적절한 고어체 혼용
• 종족별 말투 차별화 (엘프: 우아, 드워프: 투박)
• 예언/신탁: 장엄하고 모호한 표현""",

            "애니메이션": """• 캐릭터 개성 살리는 특징적 말투
• 아동용: 쉽고 친근한 표현
• 성인용: 원작 톤 유지
• 감탄사/추임새: 한국 애니 문화 반영
• 특수 효과음: 한국식 의성어/의태어""",

            "다큐멘터리": """• 정보의 정확한 전달 최우선
• 전문 용어: 공인된 번역어 사용
• 내레이션: 격식체, 명료한 문장
• 인터뷰: 화자 특성에 맞는 말투
• 통계/수치: 정확하게 표기"""
        }

        # 장르 매칭 (부분 일치 허용)
        for key, value in rules.items():
            if key in genre_lower or genre_lower in key:
                return value

        # 영어 장르명 처리
        english_mapping = {
            "action": "액션",
            "romance": "로맨스",
            "comedy": "코미디",
            "horror": "공포",
            "thriller": "스릴러",
            "drama": "드라마",
            "sci-fi": "sf",
            "science fiction": "sf",
            "fantasy": "판타지",
            "animation": "애니메이션",
            "documentary": "다큐멘터리",
            "crime": "스릴러",
            "mystery": "스릴러"
        }

        for eng, kor in english_mapping.items():
            if eng in genre_lower:
                return rules.get(kor, "")

        # 기본 규칙
        return """• 원문의 톤과 분위기 유지
• 캐릭터별 말투 일관성
• 자연스러운 한국어 구사
• 문화적 맥락 고려한 현지화"""

    def _retry_with_backoff(self, func, max_retries: int = MAX_RETRIES) -> Tuple[Any, Optional[str]]:
        """
        지수 백오프로 함수 재시도.
        func는 attempt, max_retries 키워드 인자를 받을 수 있음.
        Returns: (result, error_message)
        """
        last_error = None

        for attempt in range(max_retries):
            try:
                result = func(attempt=attempt, max_retries=max_retries)
                return (result, None)
            except Exception as e:
                last_error = str(e)
                error_type = type(e).__name__
                print(f"[WARN] Attempt {attempt + 1}/{max_retries} failed: {error_type}: {last_error}")

                # 재시도 불가능한 에러 확인
                error_lower = str(e).lower()
                if "invalid" in error_lower or "permission" in error_lower or "authentication" in error_lower:
                    print(f"[ERROR] Non-retryable error detected, stopping retries")
                    break

                if attempt < max_retries - 1:
                    sleep_time = min(INITIAL_BACKOFF_SECONDS * (2 ** attempt), MAX_BACKOFF_SECONDS)
                    print(f"[INFO] Retrying in {sleep_time:.1f}s...")
                    time.sleep(sleep_time)

        return (None, last_error)

    def _validate_response(self, response_text: str, expected_count: int) -> dict:
        """
        API 응답의 완전성과 형식을 검증.
        """
        result = {
            "valid": False,
            "truncated": False,
            "count": 0,
            "error": None
        }

        if not response_text:
            result["error"] = "Empty response"
            return result

        # 마크다운 정리
        clean_text = response_text.replace("```json", "").replace("```", "").strip()

        # JSON 배열 찾기
        json_start = clean_text.find('[')
        json_end = clean_text.rfind(']')

        if json_start == -1:
            result["error"] = "No JSON array found"
            return result

        # 잘림 감지
        if json_end == -1 or json_end < json_start:
            result["truncated"] = True
            result["error"] = "JSON array appears truncated (no closing bracket)"
            return result

        # JSON 파싱 시도
        try:
            json_str = clean_text[json_start:json_end + 1]
            parsed = json.loads(json_str)

            if isinstance(parsed, list):
                result["valid"] = True
                result["count"] = len(parsed)

                # 예상보다 적은 항목 - 잘림 가능성
                if len(parsed) < expected_count * 0.9:  # 10% 마진 허용
                    result["truncated"] = True
                    print(f"[WARN] Response may be truncated: expected {expected_count}, got {len(parsed)}")

        except json.JSONDecodeError as e:
            # 잘림으로 인한 파싱 실패 확인
            if clean_text.rstrip()[-1] != ']':
                result["truncated"] = True
            result["error"] = f"JSON parse error: {str(e)}"

        return result

    async def translate_batch(self, lines: list, context_info: dict) -> dict:
        """
        lines: 자막 블록 리스트.
        context_info: 영화 정보, 장르, 페르소나, 이전 문맥 등.
        """
        # 영화 정보
        title = context_info.get('title', '')
        synopsis = context_info.get('synopsis', '')
        genre = context_info.get('genre', '일반')
        personas = context_info.get('personas', '')
        fixed_terms = context_info.get('fixed_terms', '')
        translation_rules = context_info.get('translation_rules', '')

        # 캐릭터 관계 정보 (말투 일관성의 핵심!)
        character_relations = context_info.get('character_relations', {})
        character_relations_section = ""
        if character_relations:
            relations_text = "\n".join([f"  • {k}: {v}" for k, v in character_relations.items()])
            character_relations_section = f"""
═══════════════════════════════════════
🔒 캐릭터 관계별 말투 (절대 변경 금지!)
═══════════════════════════════════════
{relations_text}

⚠️ 위 관계 설정은 전체 번역에서 일관되게 유지해야 합니다!
"""

        # 확정된 말투 정보 (이전 배치에서 결정된 말투)
        confirmed_speech = context_info.get('confirmed_speech_levels', {})
        confirmed_speech_section = ""
        if confirmed_speech:
            speech_text = "\n".join([
                f"  • {pair[0]} → {pair[1]}: {info.get('level', '미확정')} (#{info.get('confirmed_at', '?')}에서 확정)"
                for pair, info in confirmed_speech.items()
            ])
            confirmed_speech_section = f"""
═══════════════════════════════════════
📌 이전 배치에서 확정된 말투 (변경 금지!)
═══════════════════════════════════════
{speech_text}
"""

        # 이전 배치 컨텍스트 구성 (더 많은 컨텍스트 전달)
        prev_context = context_info.get('prev_context', [])
        context_section = ""
        if prev_context:
            context_lines = "\n".join([
                f"  {p['index']}: \"{p['original']}\" → \"{p['translated']}\""
                for p in prev_context[-20:]  # 마지막 20개로 확대
            ])
            context_section = f"""
[이전 번역 컨텍스트 — 참조 전용, 번역 금지!]
{context_lines}

⚠️ 위는 이미 번역된 이전 자막입니다. 말투·호칭·톤을 파악하여 일관성을 유지하세요.
🚫 절대 위 컨텍스트의 문장을 다시 번역하여 출력하지 마십시오! 새 블록만 번역하세요.
"""

        # 고정 용어 섹션
        fixed_terms_section = ""
        if fixed_terms:
            fixed_terms_section = f"""
[고정 용어 - 반드시 이 번역 사용]
{fixed_terms}
"""

        # 번역 규칙 섹션
        rules_section = ""
        if translation_rules:
            rules_section = f"""
[특별 번역 규칙]
{translation_rules}
"""

        # ═══════════════════════════════════════════════════════════
        # V3 통합 프롬프트 조립 (3모듈: k_cinematic + speech + supplementary)
        # ═══════════════════════════════════════════════════════════

        # 1. 말투 일관성 (speech_enforcement — 유일한 V2 생존 모듈)
        confirmed_speech_text = format_confirmed_speech(confirmed_speech) if confirmed_speech else ""
        speech_enforcement = get_speech_enforcement_for_translation(
            previous_context=confirmed_speech_text,
            use_compact=True
        )

        # 2. K-시네마틱 동적 프롬프트 (핵심 엔진)
        k_cinematic = build_v3_cinema_prompt(
            genre=genre,
            personas=personas,
            relation_map=character_relations,
            batch_mood=context_info.get('batch_mood', ''),
            content_rating=context_info.get('content_rating', ''),
        )

        # 3. V3 보충 규칙 (짧은 대사, 비언어, 숫자, 외국어, SRT 포맷, 노래)
        supplementary_rules = get_v3_supplementary_rules()

        # V3 Final: 마스터 시스템 프롬프트 (최상위) + 동적 보충 규칙
        master_prompt = get_v3_master_system_prompt()

        system_instruction = f"""{master_prompt}

═══════════════════════════════════════
📖 동적 보충 규칙 (장르·등급·관계·무드)
═══════════════════════════════════════
{k_cinematic}

{speech_enforcement}
{character_relations_section}{confirmed_speech_section}
{supplementary_rules}

═══════════════════════════════════════
✅ SPEECH LOCK & HUMANIZATION CORE (Pass 1 강화)
═══════════════════════════════════════

【목표】
영화 자막처럼 자연스럽게 번역하되, 말투(레지스터) 일관성을 절대 유지한다.

【SPEECH CONSISTENCY PRIORITY】
말투 결정 우선순위:

0) confirmed_speech_levels / locked tone (확정 말투 - 최우선)
1) character_relations A→B (관계 매트릭스)
2) tone_memory 최근 일관 톤
3) persona 기본 말투
4) 문장 유형

상위가 있으면 하위 무시.

【RELATIONSHIP STABILIZATION】
동일 화자→청자에서:
- 최근 블록들이 반말이면: 씬 전환/설명/보고/긴 문장에서도 반말 유지
- 반말→존대 전환 허용 조건:
  * 갈등
  * 위계 변화
  * 공식 상황
  * 처음 만남
없으면 전환 금지.

【NO MIXED REGISTER】
한 자막 블록 내부에서 존대/반말 혼용 금지.

【ADDRESSEE SAFE MODE】
청자 불명확 시:
- 말투 변경 금지
- 직전 확정 톤 유지

【HONORIFIC LOCAL RULE】
sir / officer 등은:
- 호칭만 반영
- 말투 트랙 변경 금지

【HUMANIZATION LAYER】
말투 잠금 유지 상태에서만 적용:

1) 직역보다 자연스러운 구어 우선
   I know → 알아
   What are you doing → 뭐 해?
2) 감정동사 한국어화
3) 불필요 주어 삭제
4) 구어 리듬 재배치
5) 캐릭터 어휘색 유지
6) 번역투 제거
7) 배우가 말할 것처럼 압축
   However → 하지만
   I am worried → 걱정이야

🎬 [CINEMATIC HUMANIZATION PRO]
목표: 자막을 실제 한국 영화 번역가가 쓴 것처럼 자연스럽고 감정적으로 살아있는 대사로 만든다.
(말투 잠금 절대 유지)

━━━━━━━━━━━━━━━━
CINEMATIC COMPRESSION
━━━━━━━━━━━━━━━━
영어 정보 중 맥락상 불필요한 요소 삭제:
- I / you / we 주어
- 시간 부사
- 설명어
- 중복 의미

예:
I need you to listen to me right now → 내 말 들어
We have to get out of here now → 지금 나가야 해

━━━━━━━━━━━━━━━━
CHARACTER LEXICON LOCK
━━━━━━━━━━━━━━━━
캐릭터는 고유 어휘를 반복한다.
tone_memory와 persona를 참고해 같은 캐릭터는 비슷한 표현 선택.

예:
냉소 캐릭터: 그러시겠지 / 참 좋겠다 / 그럼 그렇지
밝은 캐릭터: 긍정! / 진짜? / 와!
터프: 꺼져 / 당장 / 그만해

동일 캐릭터는 동일 감정에서 동일 어휘 선호.

━━━━━━━━━━━━━━━━
EMOTIONAL INTENT MAPPING
━━━━━━━━━━━━━━━━
영어 문장을 감정 의도에 따라 번역:

unbelievable
- 분노 → 말도 안 돼
- 감탄 → 대단하다
- 비꼼 → 참 잘났다

really?
- 놀람 → 진짜?
- 의심 → 정말?
- 비꼼 → 그래?

상황 감정 우선 선택.

━━━━━━━━━━━━━━━━
ACTED DIALOGUE RHYTHM
━━━━━━━━━━━━━━━━
배우가 말하는 호흡으로 재배치:

영어 직역: 나는 그것이 좋은 시간이 아니라고 생각한다
자막: 그거… 별로야

━━━━━━━━━━━━━━━━
KOREAN REACTION NATURALIZATION
━━━━━━━━━━━━━━━━
영어 반응을 한국 반응으로:

oh → 아 / 어
come on → 제발 / 좀
hey → 야 / 어이
wait → 잠깐

━━━━━━━━━━━━━━━━
SUBTEXT EXPRESSION
━━━━━━━━━━━━━━━━
영어의 태도/뉘앙스를 한국 감정으로:

That's great (비꼼) → 잘됐네
Sure (냉소) → 그러시겠지

━━━━━━━━━━━━━━━━
SAFETY
━━━━━━━━━━━━━━━━
다음 변경 금지:
- 말투 레벨
- 관계 레벨
- 캐릭터 성격
- 의미 핵심

자연화는 표현만 조정.

═══════════════════════════════════════
📽️ 작품 정보
═══════════════════════════════════════
[제목]: {title}
[장르]: {genre}
[시놉시스]: {synopsis[:3000] if synopsis else '정보 없음'}

═══════════════════════════════════════
🎭 등장인물 및 말투
═══════════════════════════════════════
{personas if personas else '일반 등장인물'}
{fixed_terms_section}{rules_section}{context_section}

⚠️ 출력: 오직 JSON 배열만. [index+text] 형식. 블록 수 정확히 일치.
📌 하이픈 대사 분리: "- 대사1\\n- 대사2" 유지. 슬래시(/) 합치기 금지."""

        # V3: 톤 메모리를 시스템 프롬프트에 주입
        tone_memory = context_info.get('tone_memory', [])
        if tone_memory:
            tone_lines = []
            for tm in tone_memory[-30:]:
                tone_lines.append(f"  • {tm.get('speaker','?')} → {tm.get('addressee','?')}: {tm.get('tone','?')}")
            system_instruction += f"""
═══════════════════════════════════════
🧠 글로벌 톤 메모리 (이전 배치 축적)
═══════════════════════════════════════
{chr(10).join(tone_lines)}

⚠️ 이 톤 패턴을 이어받아 일관성을 유지하세요!
"""
        # NOTE: 배치 무드 오버레이는 k_cinematic 내부에서 이미 주입됨 (이중 주입 제거)

        # V3: 자막 블록을 텍스트로 구성 (화자 + CPS + SIDE_TALK 인라인 주입)
        source_lines = []
        for l in lines:
            line_parts = [str(l['index'])]
            # 화자 태그
            if l.get('speaker'):
                line_parts.append(f"[{l['speaker']}]")
                if l.get('addressee'):
                    line_parts[-1] = f"[{l['speaker']} → {l['addressee']}]"
            line_parts.append(":")
            line_parts.append(l['text'])
            # CPS 경고
            if l.get('cps_warning'):
                line_parts.append(f" {l['cps_warning']}")
            # Side-Talk 태그 (방백/대상 전환)
            if l.get('side_talk'):
                st = l['side_talk']
                st_tag = f' [SIDE_TALK vocative="{st.get("vocative", "")}"'
                if st.get("vocative_target"):
                    st_tag += f' target="{st["vocative_target"]}"'
                if st.get("relation"):
                    st_tag += f' relation="{st["relation"]}"'
                st_tag += "]"
                line_parts.append(st_tag)
            source_lines.append(" ".join(line_parts))

        source_payload = "\n".join(source_lines)

        user_prompt = f"다음 자막을 한국어로 자연스럽게 번역하세요:\n\n{source_payload}"

        # API 호출 함수 정의 (마지막 재시도에서만 thinking 활성화)
        def make_api_call(attempt=0, max_retries=MAX_RETRIES):
            use_thinking = (attempt >= max_retries - 1)
            thinking_config = {"thinking_budget": 1024} if use_thinking else {"thinking_budget": 0}
            if use_thinking:
                print(f"[INFO] Enabling thinking (attempt {attempt + 1}/{max_retries})")
            return self.client.models.generate_content(
                model=self.model,
                contents=user_prompt,
                config={
                    "system_instruction": system_instruction,
                    "max_output_tokens": 32768,
                    "temperature": 0.2,
                    "thinking_config": thinking_config,
                }
            )

        # 재시도 로직으로 API 호출
        response, error = self._retry_with_backoff(make_api_call)

        if error:
            print(f"[ERROR] API call failed after retries: {error}")
            return {
                "success": False,
                "data": None,
                "error": error,
                "truncated": False,
                "expected_count": len(lines),
                "received_count": 0
            }

        result_text = response.text
        # Windows cp949 인코딩 문제 방지 - 안전한 로깅
        try:
            preview = str(result_text)[:200].encode('utf-8', errors='replace').decode('utf-8')
            print(f"[DEBUG] Gemini response type: {type(result_text)}")
            print(f"[DEBUG] Gemini response preview: {preview}")
        except Exception:
            print(f"[DEBUG] Gemini response received (length: {len(result_text) if result_text else 0})")

        # 응답 검증
        validation = self._validate_response(result_text, len(lines))

        return {
            "success": True,
            "data": result_text,
            "error": None,
            "truncated": validation.get("truncated", False),
            "expected_count": len(lines),
            "received_count": validation.get("count", 0)
        }
    
    def translate_batch_sync(self, lines: list, context_info: dict) -> str:
        """
        동기 버전의 배치 번역
        """
        system_instruction = f"""
당신은 세계 최고 수준의 자막 번역가입니다.

[장르]: {context_info.get('genre', '일반')}
[페르소나]: {context_info.get('personas', '기본')}

[번역 원칙]
1. 자연스러운 한국어로 번역
2. 초당 7~10자 이내로 압축
3. 캐릭터의 말투와 성격 유지
4. 문화적 맥락 고려
5. 전문 용어는 일관성 유지

[출력 형식]
반드시 JSON 배열로 출력하세요:
[
  {{"index": 1, "text": "번역된 텍스트"}},
  {{"index": 2, "text": "번역된 텍스트"}}
]
"""
        
        source_payload = "\n".join([f"{l['index']}: {l['text']}" for l in lines])
        user_prompt = f"다음 자막을 한국어로 번역하십시오:\n\n{source_payload}"
        
        response = self.client.models.generate_content(
            model=self.model,
            contents=user_prompt,
            config={
                "system_instruction": system_instruction,
                "max_output_tokens": 8192,
                "temperature": 0.3,
                "thinking_config": {"thinking_budget": 0},
            }
        )

        return response.text
    
    def health_check(self) -> dict:
        """
        Vertex AI Gemini 연결 상태 확인
        """
        try:
            # 간단한 테스트 호출
            response = self.client.models.generate_content(
                model=self.model,
                contents="Say 'OK' if you can hear me.",
                config={"max_output_tokens": 10}
            )
            return {
                "status": "connected",
                "project_id": self.project_id,
                "region": self.location,
                "model": self.model,
                "test_response": response.text[:50] if response.text else "OK"
            }
        except Exception as e:
            return {
                "status": "error",
                "project_id": self.project_id,
                "region": self.location,
                "model": self.model,
                "error": str(e)
            }
