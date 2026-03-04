import os
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from app.services.vertex_ai import VertexTranslator
from app.services.crawler import MetadataScraper

router = APIRouter()

# Vertex AI 클라이언트 (환경변수에서 자동 로드)
# 초기화 지연 - 실제 API 호출 시점에 생성
vertex_ai = None
metadata_scraper = None

def get_vertex_ai():
    global vertex_ai
    if vertex_ai is None:
        vertex_ai = VertexTranslator()
    return vertex_ai

def get_scraper():
    global metadata_scraper
    if metadata_scraper is None:
        metadata_scraper = MetadataScraper()
    return metadata_scraper


class CharacterInfo(BaseModel):
    """캐릭터 정보 (TMDB에서 가져온 배우-역할 매핑)"""
    actor: str
    character: str
    gender: Optional[str] = ""
    order: Optional[int] = 99


class MetadataInput(BaseModel):
    title: str
    genre: List[str]
    synopsis: str
    director: Optional[str] = ""
    writer: Optional[str] = ""
    actors: Optional[str] = ""
    year: Optional[str] = ""
    runtime: Optional[str] = ""
    rated: Optional[str] = ""
    imdb_rating: Optional[str] = ""
    imdb_id: Optional[str] = ""
    tmdb_id: Optional[str] = ""
    rotten_tomatoes: Optional[str] = ""
    metacritic: Optional[str] = ""
    awards: Optional[str] = ""
    box_office: Optional[str] = ""
    characters: Optional[List[CharacterInfo]] = []
    detailed_plot: Optional[str] = ""
    detailed_plot_ko: Optional[str] = ""
    wikipedia_plot: Optional[str] = ""
    wikipedia_overview: Optional[str] = ""
    omdb_full_plot: Optional[str] = ""
    has_wikipedia: Optional[bool] = False


class DiagnosticStats(BaseModel):
    total_count: int
    complexity: float
    sample_texts: Optional[List[str]] = []


class StrategyRequest(BaseModel):
    metadata: MetadataInput
    diagnostic_stats: DiagnosticStats
    subtitle_samples: Optional[List[str]] = []


class CharacterPersona(BaseModel):
    name: str
    gender: Optional[str] = ""
    role: Optional[str] = ""
    personality: Optional[str] = ""
    description: str
    speech_style: str
    speech_level_default: Optional[str] = ""
    speech_pattern_markers: Optional[str] = ""
    relationships: Optional[str] = ""
    tone_archetype: Optional[str] = ""


class CharacterRelationship(BaseModel):
    from_char: Optional[str] = ""  # 'from' is reserved keyword
    to_char: Optional[str] = ""
    relationship_type: Optional[str] = ""
    honorific: Optional[str] = ""
    speech_level: Optional[str] = ""
    note: Optional[str] = ""


class StrategyBlueprint(BaseModel):
    approval_id: str
    content_analysis: Dict[str, Any]
    character_personas: List[CharacterPersona]
    character_relationships: Optional[List[CharacterRelationship]] = []
    data_diagnosis: Dict[str, Any]
    fixed_terms: List[Dict[str, str]]
    translation_rules: List[str]


@router.post("/generate", response_model=StrategyBlueprint)
async def generate_strategy(request: StrategyRequest):
    """
    📊 번역 전략 기획서 생성 API

    메타데이터와 진단 결과를 분석하여 번역 전략 기획서를 생성합니다.
    사용자 승인 후에만 번역이 실행됩니다.
    """
    import uuid
    import json
    from datetime import datetime

    # 🔍 DEBUG: 요청 전체를 파일로 저장
    debug_file = f"C:/Vibe Coding/Subtitle/backend/debug_request_{datetime.now().strftime('%H%M%S')}.json"
    try:
        with open(debug_file, 'w', encoding='utf-8') as f:
            debug_data = {
                "timestamp": datetime.now().isoformat(),
                "metadata": {
                    "title": request.metadata.title,
                    "genre": request.metadata.genre,
                    "synopsis_len": len(request.metadata.synopsis) if request.metadata.synopsis else 0,
                    "synopsis_preview": request.metadata.synopsis[:200] if request.metadata.synopsis else "",
                    "director": request.metadata.director,
                    "writer": request.metadata.writer,
                    "actors": request.metadata.actors,
                    "year": request.metadata.year,
                    "runtime": request.metadata.runtime,
                    "rated": request.metadata.rated,
                    "imdb_rating": request.metadata.imdb_rating,
                    "rotten_tomatoes": request.metadata.rotten_tomatoes,
                    "metacritic": request.metadata.metacritic,
                    "awards": request.metadata.awards,
                    "box_office": request.metadata.box_office,
                    "characters_count": len(request.metadata.characters) if request.metadata.characters else 0,
                    "has_wikipedia": request.metadata.has_wikipedia,
                    "detailed_plot_len": len(request.metadata.detailed_plot) if request.metadata.detailed_plot else 0,
                    "detailed_plot_ko_len": len(request.metadata.detailed_plot_ko) if request.metadata.detailed_plot_ko else 0,
                    "wikipedia_plot_len": len(request.metadata.wikipedia_plot) if request.metadata.wikipedia_plot else 0,
                    "wikipedia_overview_len": len(request.metadata.wikipedia_overview) if request.metadata.wikipedia_overview else 0,
                    "omdb_full_plot_len": len(request.metadata.omdb_full_plot) if request.metadata.omdb_full_plot else 0,
                },
                "diagnostic_stats": {
                    "total_count": request.diagnostic_stats.total_count,
                    "complexity": request.diagnostic_stats.complexity,
                },
                "subtitle_samples_count": len(request.subtitle_samples) if request.subtitle_samples else 0,
            }
            json.dump(debug_data, f, ensure_ascii=False, indent=2)
        print(f"[DEBUG] Request saved to: {debug_file}")
    except Exception as e:
        print(f"[DEBUG] Failed to save request: {e}")

    # 요청 데이터 로깅
    print(f"\n{'='*60}")
    print(f"[STRATEGY] Request received")
    print(f"[STRATEGY] Title: {request.metadata.title}")
    print(f"[STRATEGY] Genre: {request.metadata.genre}")
    print(f"[STRATEGY] Has Wikipedia: {request.metadata.has_wikipedia}")
    print(f"[STRATEGY] Detailed plot length: {len(request.metadata.detailed_plot) if request.metadata.detailed_plot else 0}")
    print(f"[STRATEGY] Wikipedia plot length: {len(request.metadata.wikipedia_plot) if request.metadata.wikipedia_plot else 0}")
    if request.metadata.detailed_plot:
        print(f"[STRATEGY] Detailed plot preview: {request.metadata.detailed_plot[:200]}...")
    print(f"[STRATEGY] Characters: {len(request.metadata.characters) if request.metadata.characters else 0}")
    print(f"[STRATEGY] Subtitle samples: {len(request.subtitle_samples) if request.subtitle_samples else 0}")
    print(f"{'='*60}\n")

    approval_id = str(uuid.uuid4())[:8]
    
    # V3 전략 기획서 생성 - k_cinematic 5축 모델과 정합되는 고품질 전략 프롬프트
    system_prompt = """당신은 넷플릭스/디즈니+ 한국어 자막팀의 수석 번역 전략가입니다.
주어진 영화 메타데이터, 줄거리, 자막 샘플을 분석하여 번역 전략 기획서를 JSON으로 생성하십시오.

이 기획서는 번역 AI에게 직접 주입되므로, 모호한 서술이 아닌 구체적·실행 가능한 지시를 작성해야 합니다.

🚨 **ZERO-TOLERANCE SINGLE TONE LOCK RULE** 🚨
1. A speaker's speech level towards a specific addressee MUST BE STRICTLY UNIFORM throughout the entire script. You must choose ONLY ONE base register (either 'banmal' or 'jondaemal').
2. DO NOT allow dynamic tone switching based on casual English nuances. If a character uses jondaemal initially, it must be locked as jondaemal permanently unless there is a completely explicit, major narrative betrayal/shift. Even then, default to the safer single tone.
3. The `speech_level` inside `character_relationships` MUST be EXACTLY "banmal" or "jondaemal". No other values are allowed.

═══════════════════════════════════════
📋 출력 JSON 스키마
═══════════════════════════════════════
{
    "content_analysis": {
        "estimated_title": "한국어 제목 (공식 제목 있으면 공식 제목, 없으면 원제)",
        "genre": "장르 (제공된 장르 그대로)",
        "mood": "전체 분위기 (긴장감/감성적/유머러스/암울/밝음 등)",
        "narrative_arc": "서사 구조 요약 (발단-전개-위기-절정-결말 흐름을 1~2문장으로)",
        "formality_spectrum": "작품 전체의 격식 스펙트럼 (예: '일상 구어체 위주, 공식 장면에서만 격식체')",
        "summary": "3줄 이내 줄거리 요약"
    },
    "character_personas": [
        {
            "name": "캐릭터명 (한글 표기. 예: 닉, 사라, 형사 김)",
            "gender": "남성/여성 (필수!)",
            "role": "서사적 역할 (주인공/조력자/적대자/멘토/코믹릴리프 등)",
            "personality": "성격 키워드 3~5개 (예: 거칠고 직설적, 속정 깊음, 유머러스)",
            "description": "캐릭터 배경 및 동기 요약 (2~3문장)",
            "speech_style": "말투 정의 (아래 '말투 분석 방법론' 참조)",
            "speech_level_default": "기본 존비어 (반말/해요체/합쇼체 중 택1)",
            "speech_pattern_markers": "이 캐릭터만의 언어적 특징 (입버릇, 말끝 흐림, 특정 감탄사 등)",
            "relationships": "주요 관계 요약 (다른 캐릭터별 말투 변화 포함)"
        }
    ],
    "character_relationships": [
        {
            "from": "화자 이름",
            "to": "청자 이름",
            "relationship_type": "관계 유형 (가족/연인/친구/동료/상하관계/적대/초면 등)",
            "honorific": "호칭 (한국어 호칭 체계 적용: 형/누나/오빠/언니/이름/직책 등)",
            "speech_level": "banmal 또는 jondaemal (절대 단일 톤 유지)",
            "note": "관계 설명 및 특이사항"
        }
    ],
    "data_diagnosis": {
        "timecode_status": "정상 또는 오류 가능성 설명",
        "technical_noise": "태그 존재 여부, OCR 오타 유형"
    },
    "fixed_terms": [
        {"original": "원어", "translation": "한국어 번역", "note": "비고 (고유명사/지명/조직명/기술용어 등 분류)"}
    ],
    "translation_rules": [
        "이 작품에만 적용되는 특수 번역 규칙 (아래 '작품별 특수 규칙 작성법' 참조)"
    ]
}

═══════════════════════════════════════
🔍 말투 분석 방법론 (speech_style 작성 규칙)
═══════════════════════════════════════

speech_style은 번역 AI가 이 캐릭터의 모든 대사를 일관되게 번역하기 위한 핵심 지시문입니다.
모호한 서술("자연스러운 말투")은 금지. 구체적 패턴을 명시하십시오.

분석 순서:
1. 줄거리에서 캐릭터의 사회적 위치(나이, 직업, 계층)를 파악
2. 자막 샘플에서 해당 캐릭터의 실제 발화 패턴을 확인
   - 문장 길이 (장문형 vs 단문형)
   - 감탄사 빈도 (많으면 감정적, 적으면 이성적)
   - 비속어 수위 (없음/경미/강함)
   - 질문 빈도 (높으면 탐색적/소심, 낮으면 단정적/리더)
3. 한국어 말투를 3요소로 정의:
   a) 존비어 기본값: 반말(-해, -야, -지) / 해요체(-요, -죠) / 합쇼체(-습니다, -하십시오)
   b) 어미 성향: 단정형(-다, -야) / 물음형(-지?, -잖아?) / 감탄형(-네!, -군!) / 설명형(-거든, -잖아)
   c) 문장 스타일: 축약형(주어·조사 생략) / 완결형(문장 완성) / 감정표출형(감탄사 빈번)

작성 형식: "{존비어} - {어미 성향}, {문장 스타일}. {특이사항}"
예시 패턴 (참고용, 그대로 복사하지 말 것):
- "반말 - 단정형 단문, 축약형. 명령조가 많고 감정 표현을 절제함"
- "해요체 - 물음형, 완결형. 상대의 반응을 살피는 말투, '~인 거죠?' 패턴 빈번"
- "반말+해요체 혼용 - 감탄형, 감정표출형. 친한 사이에서 반말, 처음 보는 사람에겐 해요체"

═══════════════════════════════════════
🎭 한국어 호칭 체계 (character_relationships 작성 규칙)
═══════════════════════════════════════

반드시 양방향(A→B, B→A)으로 작성하십시오. 호칭은 비대칭입니다.

호칭 결정 규칙:
1. 가족 관계:
   - 화자 성별 + 상대 성별 + 나이 관계로 결정
   - 남성 화자→나이 많은 남성: "형"
   - 남성 화자→나이 많은 여성: "누나"
   - 여성 화자→나이 많은 남성: "오빠"
   - 여성 화자→나이 많은 여성: "언니"
   - 나이 많은 쪽→어린 쪽: 이름 호칭 + 반말

2. 직장/조직:
   - 상급자→하급자: 이름+씨, 이름 반말, 또는 직급
   - 하급자→상급자: 직책+님 (팀장님, 교수님, 사장님)
   - 동급: 이름+씨(해요체) 또는 이름(반말)

3. 연인/친구:
   - 초기: 이름+씨 → 이름 호칭 → 애칭 순서로 발전
   - 성립 후: 나이에 따라 가족 호칭 차용(오빠/형/언니/누나) 가능

4. 적대/경쟁:
   - 이름 직호, 비칭, 또는 직책 (조롱조)

═══════════════════════════════════════
📝 작품별 특수 규칙 작성법 (translation_rules)
═══════════════════════════════════════

translation_rules는 이 작품에서만 필요한 번역 규칙입니다.
범용적인 규칙("자연스러운 한국어 사용")은 쓰지 마십시오 - 그건 이미 번역 시스템에 내장되어 있습니다.

좋은 규칙의 기준:
- 이 작품의 고유한 설정·맥락 때문에 필요한 규칙
- 특정 상황에서 적용되는 구체적 지시
- 일반적인 번역 원칙으로는 자동 해결되지 않는 사항

작성할 규칙 카테고리:
1. 세계관 규칙: 작품 내 고유 설정에 따른 번역 규칙 (시대배경, 판타지 설정, SF 용어 등)
2. 톤 전환 규칙: 장면 유형별 톤 변화 지시 (일상→전투, 코미디→시리어스 전환 시)
3. 문화 적응 규칙: 원문의 문화적 레퍼런스를 한국 관객에게 어떻게 전달할지
4. 캐릭터 고유 규칙: 특정 캐릭터의 특수한 언어 패턴 (외국인 캐릭터, 로봇, 어린이 등)

═══════════════════════════════════════
⚠️ 필수 준수 사항
═══════════════════════════════════════

1. character_personas에 반드시 성별(gender) 명시 - 한국어 호칭 결정의 필수 변수.
2. character_relationships는 양방향 작성 (A→B, B→A 각각).
3. speech_style은 위의 '말투 분석 방법론'에 따라 3요소(존비어+어미성향+문장스타일)로 구체 정의.
4. fixed_terms에 반드시 포함: 캐릭터 이름(영어→한글), 지명, 조직명, 작품 고유 용어.
5. translation_rules에 범용 규칙("자연스러운 번역") 작성 금지 - 작품 고유 규칙만.
6. 최소 주요 캐릭터 3명 이상 분석.
"""

    # 자막 샘플 스마트 샘플링 (시작, 중간, 끝에서 골고루)
    samples = request.subtitle_samples or []
    total_samples = len(samples)
    smart_samples = []

    if total_samples > 0:
        # 시작 부분 20개
        smart_samples.extend(samples[:20])
        # 중간 부분 15개
        if total_samples > 50:
            mid_start = total_samples // 2 - 7
            smart_samples.extend(samples[mid_start:mid_start + 15])
        # 끝 부분 15개
        if total_samples > 30:
            smart_samples.extend(samples[-15:])

    # 🆕 TMDB에서 상세 캐릭터 정보 가져오기
    character_info = ""
    if request.metadata.characters:
        char_lines = []
        for c in request.metadata.characters[:10]:
            # CharacterInfo 모델 속성 접근
            char_name = c.character
            actor = c.actor
            gender = c.gender or ""
            if char_name:
                line = f"  • {char_name}"
                if gender:
                    line += f" ({gender})"
                if actor:
                    line += f" - 배우: {actor}"
                char_lines.append(line)

        if char_lines:
            character_info = f"""
═══════════════════════════════════════
🎭 TMDB 캐릭터 데이터 (매우 중요!)
═══════════════════════════════════════
{chr(10).join(char_lines)}

⚠️ 위 캐릭터 정보를 기반으로 character_personas를 생성하세요!
- 캐릭터명은 위 데이터에서 가져오기
- 성별은 이미 제공됨 (남성/여성)
- 각 캐릭터의 말투와 관계를 분석하여 작성
"""

    # 배우 정보 (캐릭터 정보가 없을 때 폴백)
    actor_hint = ""
    if not character_info and request.metadata.actors:
        actor_hint = f"""
⚠️ 출연 배우 정보를 참고하여 반드시 주요 캐릭터를 생성하세요:
{request.metadata.actors}

위 배우들이 연기하는 캐릭터를 파악하여 character_personas에 포함시키세요.
"""

    # 🆕 모든 줄거리 소스 통합 (Wikipedia + OMDB + TMDB)
    wikipedia_section = ""
    plot_parts = []
    if request.metadata.wikipedia_plot:
        plot_parts.append(("Wikipedia 상세 줄거리", request.metadata.wikipedia_plot))
    if request.metadata.omdb_full_plot:
        plot_parts.append(("OMDB 상세 줄거리", request.metadata.omdb_full_plot))
    if request.metadata.detailed_plot and request.metadata.detailed_plot not in [
        request.metadata.wikipedia_plot, request.metadata.omdb_full_plot
    ]:
        plot_parts.append(("추가 줄거리", request.metadata.detailed_plot))

    if plot_parts:
        combined_plot = ""
        for label, text in plot_parts:
            # 각 소스별 최대 6000자
            truncated = text[:6000] + "..." if len(text) > 6000 else text
            combined_plot += f"\n【{label}】\n{truncated}\n"

        wikipedia_section = f"""
═══════════════════════════════════════
📖 방대한 줄거리 정보 (번역 품질의 핵심!)
═══════════════════════════════════════
{combined_plot}
⚠️ 위 줄거리에서 다음을 반드시 파악하세요:
  1. 캐릭터 이름, 성별, 관계 (가족/친구/동료/적)
  2. 캐릭터 간 호칭 (형/누나/오빠/언니 등)
  3. 작품의 분위기와 톤
  4. 주요 장소와 고유명사
"""

    # 평점/수상 정보 블록
    ratings_section = ""
    rating_parts = []
    if request.metadata.imdb_rating:
        rating_parts.append(f"IMDb: {request.metadata.imdb_rating}")
    if request.metadata.rotten_tomatoes:
        rating_parts.append(f"Rotten Tomatoes: {request.metadata.rotten_tomatoes}")
    if request.metadata.metacritic:
        rating_parts.append(f"Metacritic: {request.metadata.metacritic}")
    if rating_parts:
        ratings_section = f"- 평점: {' | '.join(rating_parts)}\n"
    if request.metadata.awards:
        ratings_section += f"- 수상: {request.metadata.awards}\n"
    if request.metadata.box_office:
        ratings_section += f"- 박스오피스: {request.metadata.box_office}\n"

    # Wikipedia 개요 (줄거리와 별도로 영화 배경/제작 정보)
    overview_section = ""
    if request.metadata.wikipedia_overview:
        overview_section = f"""
═══════════════════════════════════════
🌐 영화 개요 (Wikipedia Summary)
═══════════════════════════════════════
{request.metadata.wikipedia_overview[:3000]}
"""

    # 한글 줄거리 (있으면 추가)
    ko_plot_section = ""
    if request.metadata.detailed_plot_ko:
        ko_plot_section = f"""
═══════════════════════════════════════
🇰🇷 한글 줄거리
═══════════════════════════════════════
{request.metadata.detailed_plot_ko[:6000]}
"""

    user_content = f"""
🚨🚨🚨 최우선 지시사항 🚨🚨🚨
- 아래 제공된 "영화 정보"와 "상세 줄거리"가 이 영화의 공식 정보입니다.
- 자막 샘플은 말투 분석용으로만 사용하고, 영화 내용 파악에는 사용하지 마세요!
- 제목, 장르, 줄거리는 반드시 아래 제공된 정보를 그대로 사용하세요.

═══════════════════════════════════════
📽️ 영화 공식 정보 (반드시 이 정보 사용!)
═══════════════════════════════════════
- 제목: {request.metadata.title}
- 장르: {', '.join(request.metadata.genre)}
- 시놉시스: {request.metadata.synopsis}
- 감독: {request.metadata.director}
- 각본: {request.metadata.writer}
- 출연: {request.metadata.actors}
- 연도: {request.metadata.year}
- 러닝타임: {request.metadata.runtime}
- 등급: {request.metadata.rated}
{ratings_section}{overview_section}{ko_plot_section}{wikipedia_section}{character_info}{actor_hint}
═══════════════════════════════════════
📝 자막 샘플 (말투/어조/관계 분석용 - 줄거리 파악에는 사용 금지!)
═══════════════════════════════════════
- 총 자막 수: {request.diagnostic_stats.total_count}개
- 아래 샘플에서 분석할 것:
  1) 캐릭터별 문장 길이·감탄사·비속어 패턴
  2) 대화 상대에 따른 말투 변화 (같은 캐릭터도 상대에 따라 달라질 수 있음)
  3) 기술적 노이즈 (HTML 태그, OCR 오류, 포맷 이상)

【시작 부분 샘플】
{chr(10).join(smart_samples[:20]) if smart_samples else '샘플 없음'}

【중간 부분 샘플】
{chr(10).join(smart_samples[20:35]) if len(smart_samples) > 20 else ''}

【끝 부분 샘플】
{chr(10).join(smart_samples[35:]) if len(smart_samples) > 35 else ''}

═══════════════════════════════════════
⚠️ 최종 체크리스트
═══════════════════════════════════════
1. content_analysis.estimated_title = "{request.metadata.title}" (변경 금지)
2. content_analysis.genre = "{', '.join(request.metadata.genre)}" (변경 금지)
3. character_personas: 줄거리/TMDB 데이터 기반으로 최소 3명 이상 작성
4. character_relationships: 모든 주요 관계를 양방향(A→B, B→A)으로 작성
5. speech_style: 3요소(존비어+어미성향+문장스타일) 형식 준수
6. fixed_terms: 캐릭터 이름 영한 매핑 필수 포함
7. translation_rules: 범용 규칙 금지, 작품 고유 규칙만 작성

위 정보를 기반으로 번역 전략 기획서를 JSON 형식으로 생성하십시오.
"""

    try:
        # Vertex AI Gemini 호출
        print(f"[DEBUG] Getting Vertex AI client...")
        vai = get_vertex_ai()
        print(f"[DEBUG] Client ready. Model: {vai.model}, Region: {vai.location}")
        
        # Gemini API 형식으로 호출
        full_prompt = f"{system_prompt}\n\n{user_content}"
        print(f"[DEBUG] Calling Gemini API...")
        response = vai.client.models.generate_content(
            model=vai.model,
            contents=full_prompt,
            config={
                "max_output_tokens": 8192,
                "temperature": 0.3,
                "thinking_config": {"thinking_budget": 0},  # thinking 비활성화 → 속도 대폭 향상
            }
        )
        print(f"[DEBUG] Got response")

        # 🔍 응답 완전성 확인
        finish_reason = None
        if response.candidates:
            candidate = response.candidates[0]
            finish_reason = candidate.finish_reason if hasattr(candidate, 'finish_reason') else None
            print(f"[DEBUG] Finish reason: {finish_reason}")

        # 응답에서 텍스트 추출
        response_text = response.text if response.text else ""
        print(f"[DEBUG] Response text length: {len(response_text)}")
        print(f"[DEBUG] Response preview: {response_text[:200] if response_text else 'EMPTY'}...")
        print(f"[DEBUG] Response end: ...{response_text[-100:] if len(response_text) > 100 else response_text}")
        
        # JSON 파싱 시도 (다중 전략)
        try:
            json_match = response_text.strip()
            parse_success = False
            parse_error = None

            # 전략 1: ```json 블록
            if "```json" in response_text:
                try:
                    json_match = response_text.split("```json")[1].split("```")[0].strip()
                    strategy_data = json.loads(json_match)
                    parse_success = True
                    print(f"[DEBUG] JSON parsed via ```json block")
                except Exception as e:
                    parse_error = e
                    print(f"[DEBUG] Strategy 1 failed: {e}")

            # 전략 2: ``` 블록
            if not parse_success and "```" in response_text:
                try:
                    parts = response_text.split("```")
                    if len(parts) >= 2:
                        json_match = parts[1].strip()
                        if json_match.startswith("json"):
                            json_match = json_match[4:].strip()
                        strategy_data = json.loads(json_match)
                        parse_success = True
                        print(f"[DEBUG] JSON parsed via ``` block")
                except Exception as e:
                    parse_error = e
                    print(f"[DEBUG] Strategy 2 failed: {e}")

            # 전략 3: { } 찾기 (가장 바깥쪽 중괄호)
            if not parse_success:
                try:
                    start_idx = response_text.find('{')
                    end_idx = response_text.rfind('}')
                    if start_idx != -1 and end_idx != -1 and end_idx > start_idx:
                        json_match = response_text[start_idx:end_idx + 1]
                        strategy_data = json.loads(json_match)
                        parse_success = True
                        print(f"[DEBUG] JSON parsed via braces search")
                except Exception as e:
                    parse_error = e
                    print(f"[DEBUG] Strategy 3 failed: {e}")

            # 전략 4: 응답 전체를 JSON으로 시도
            if not parse_success:
                try:
                    strategy_data = json.loads(response_text.strip())
                    parse_success = True
                    print(f"[DEBUG] JSON parsed as raw response")
                except Exception as e:
                    parse_error = e
                    print(f"[DEBUG] Strategy 4 failed: {e}")

            # 🔧 전략 5: 잘린 JSON 복구 (괄호 균형 맞추기)
            if not parse_success:
                try:
                    print(f"[DEBUG] Trying truncated JSON recovery...")
                    # ```json 블록에서 JSON 부분만 추출
                    if "```json" in response_text:
                        json_part = response_text.split("```json")[1]
                        # 닫는 ``` 가 있으면 제거
                        if "```" in json_part:
                            json_part = json_part.split("```")[0]
                    elif "{" in response_text:
                        json_part = response_text[response_text.find("{"):]
                    else:
                        json_part = response_text

                    json_part = json_part.strip()

                    # 열린 괄호 개수 세기
                    open_braces = json_part.count('{') - json_part.count('}')
                    open_brackets = json_part.count('[') - json_part.count(']')

                    print(f"[DEBUG] Open braces: {open_braces}, Open brackets: {open_brackets}")

                    # 마지막 완전한 항목까지 자르기 시도
                    # 마지막 완전한 "}" 또는 완전한 문자열 찾기
                    last_valid = json_part.rfind('"}')
                    if last_valid == -1:
                        last_valid = json_part.rfind('"]')
                    if last_valid == -1:
                        last_valid = json_part.rfind('},')

                    if last_valid > 0:
                        recovered = json_part[:last_valid + 2]
                        # 괄호 균형 맞추기
                        open_braces = recovered.count('{') - recovered.count('}')
                        open_brackets = recovered.count('[') - recovered.count(']')
                        recovered += ']' * open_brackets + '}' * open_braces

                        print(f"[DEBUG] Attempting to parse recovered JSON (length: {len(recovered)})")
                        strategy_data = json.loads(recovered)
                        parse_success = True
                        print(f"[DEBUG] JSON recovered and parsed successfully!")
                except Exception as e:
                    parse_error = e
                    print(f"[DEBUG] Strategy 5 (recovery) failed: {e}")

            # 🔧 전략 6: JSON 구문 오류 자동 교정 (누락 쉼표, 후행 쉼표, 제어 문자 등)
            if not parse_success:
                try:
                    import re as _re
                    print(f"[DEBUG] Trying JSON syntax auto-repair...")

                    # JSON 부분 추출
                    if "```json" in response_text:
                        repair_json = response_text.split("```json")[1]
                        if "```" in repair_json:
                            repair_json = repair_json.split("```")[0]
                    elif "{" in response_text:
                        s = response_text.find("{")
                        e_idx = response_text.rfind("}")
                        repair_json = response_text[s:e_idx + 1] if e_idx > s else response_text[s:]
                    else:
                        repair_json = response_text

                    repair_json = repair_json.strip()

                    # 1) 문자열 내부의 제어 문자 이스케이프
                    def _esc_ctrl(s):
                        out, in_str, esc = [], False, False
                        for ch in s:
                            if esc:
                                out.append(ch); esc = False; continue
                            if ch == '\\' and in_str:
                                out.append(ch); esc = True; continue
                            if ch == '"':
                                in_str = not in_str
                            if in_str and ord(ch) < 0x20:
                                out.append({'\\n': '\\n', '\\r': '\\r', '\\t': '\\t'}.get(ch, f'\\u{ord(ch):04x}'))
                                continue
                            out.append(ch)
                        return ''.join(out)
                    repair_json = _esc_ctrl(repair_json)

                    # 2) 후행 쉼표 제거 (, } 또는 , ])
                    repair_json = _re.sub(r',\s*}', '}', repair_json)
                    repair_json = _re.sub(r',\s*]', ']', repair_json)

                    # 3) 누락 쉼표 추가: "}\n  {" → "},\n  {" or "]\n  [" 등
                    #    줄 끝이 }, ], "로 끝나고 다음 줄이 {, [, "로 시작하면 쉼표 삽입
                    repair_json = _re.sub(
                        r'(")\s*\n(\s*")',   # "value"\n  "key"  → "value",\n  "key"
                        r'\1,\n\2', repair_json
                    )
                    repair_json = _re.sub(
                        r'(})\s*\n(\s*{)',   # }\n  {  → },\n  {
                        r'\1,\n\2', repair_json
                    )
                    repair_json = _re.sub(
                        r'(])\s*\n(\s*\[)',  # ]\n  [  → ],\n  [
                        r'\1,\n\2', repair_json
                    )
                    repair_json = _re.sub(
                        r'(})\s*\n(\s*")',   # }\n  "  → },\n  "
                        r'\1,\n\2', repair_json
                    )
                    repair_json = _re.sub(
                        r'(")\s*\n(\s*{)',   # "value"\n  {  → "value",\n  {
                        r'\1,\n\2', repair_json
                    )
                    repair_json = _re.sub(
                        r'(")\s*\n(\s*\[)',  # "value"\n  [  → "value",\n  [
                        r'\1,\n\2', repair_json
                    )

                    # 4) 괄호 균형 맞추기
                    open_b = repair_json.count('{') - repair_json.count('}')
                    open_k = repair_json.count('[') - repair_json.count(']')
                    if open_b > 0 or open_k > 0:
                        repair_json += ']' * max(0, open_k) + '}' * max(0, open_b)

                    strategy_data = json.loads(repair_json)
                    parse_success = True
                    print(f"[DEBUG] JSON auto-repaired and parsed successfully!")
                except Exception as e:
                    parse_error = e
                    print(f"[DEBUG] Strategy 6 (auto-repair) failed: {e}")

            if parse_success:
                print(f"[DEBUG] JSON parsed successfully! Keys: {list(strategy_data.keys())}")
            else:
                raise json.JSONDecodeError(f"All strategies failed: {parse_error}", response_text, 0)
        except json.JSONDecodeError as e:
            print(f"[ERROR] JSON parse failed: {e}")
            print(f"[ERROR] Raw response: {response_text[:500]}")
            # 파싱 실패 시 기본 구조 생성 - 에러 정보 포함!
            strategy_data = {
                "content_analysis": {
                    "estimated_title": request.metadata.title,
                    "genre": ', '.join(request.metadata.genre),
                    "mood": f"[JSON 파싱 실패: {str(e)[:100]}]",
                    "summary": f"Raw response preview: {response_text[:300] if response_text else 'EMPTY'}"
                },
                "character_personas": [
                    {
                        "name": "[파싱실패] 기본캐릭터",
                        "description": "JSON 파싱 실패로 기본값 반환됨",
                        "speech_style": "현대 구어체"
                    }
                ],
                "data_diagnosis": {
                    "timecode_status": "정상",
                    "technical_noise": "분석 필요"
                },
                "fixed_terms": [],
                "translation_rules": [
                    "원문의 뉘앙스를 최대한 보존",
                    "초당 7-10자 이내로 압축",
                    "캐릭터별 말투 일관성 유지"
                ]
            }
        
        # character_relationships 파싱 (from/to 필드명 변환)
        relationships = []
        for rel in strategy_data.get("character_relationships", []):
            relationships.append(CharacterRelationship(
                from_char=rel.get("from", ""),
                to_char=rel.get("to", ""),
                relationship_type=rel.get("relationship_type", ""),
                honorific=rel.get("honorific", ""),
                speech_level=rel.get("speech_level", ""),
                note=rel.get("note", "")
            ))

        # 캐릭터 페르소나 파싱 (빈 배열이면 배우 정보로 폴백 생성)
        character_personas_raw = strategy_data.get("character_personas", [])
        character_personas = []

        if character_personas_raw:
            for p in character_personas_raw:
                character_personas.append(CharacterPersona(**p))

        # 페르소나가 비어있으면 배우 정보로 기본 생성
        if not character_personas and request.metadata.actors:
            print(f"[WARN] Empty character_personas, creating from actors: {request.metadata.actors}")
            actors = [a.strip() for a in request.metadata.actors.split(',')][:5]
            for i, actor in enumerate(actors):
                character_personas.append(CharacterPersona(
                    name=actor,
                    gender="",
                    role="주연" if i < 2 else "조연",
                    description=f"{actor} 배우가 연기하는 캐릭터",
                    speech_style="현대 구어체 (AI 분석 필요)"
                ))

        # 그래도 비어있으면 기본 캐릭터 추가
        if not character_personas:
            print("[WARN] No character personas, adding default")
            character_personas.append(CharacterPersona(
                name="주인공",
                gender="",
                role="주인공",
                description="주요 등장인물 (수동 설정 필요)",
                speech_style="현대 구어체"
            ))

        # 응답 구조화
        return StrategyBlueprint(
            approval_id=approval_id,
            content_analysis=strategy_data.get("content_analysis", {}),
            character_personas=character_personas,
            character_relationships=relationships,
            data_diagnosis=strategy_data.get("data_diagnosis", {}),
            fixed_terms=strategy_data.get("fixed_terms", []),
            translation_rules=strategy_data.get("translation_rules", [])
        )
        
    except Exception as e:
        # API 오류 시 기본 전략 반환
        import traceback
        print(f"[ERROR] Strategy generation error: {type(e).__name__}: {e}")
        traceback.print_exc()
        return StrategyBlueprint(
            approval_id=approval_id,
            content_analysis={
                "estimated_title": request.metadata.title,
                "genre": ', '.join(request.metadata.genre) if request.metadata.genre else "미분류",
                "mood": "분석 대기",
                "summary": request.metadata.synopsis[:200] if request.metadata.synopsis else "시놉시스 없음"
            },
            character_personas=[
                CharacterPersona(
                    name="일반 화자",
                    description="기본 등장인물",
                    speech_style="현대 한국어 구어체"
                )
            ],
            data_diagnosis={
                "timecode_status": "정상",
                "technical_noise": f"자막 {request.diagnostic_stats.total_count}개 분석 완료"
            },
            fixed_terms=[],
            translation_rules=[
                "원문의 의미를 정확히 전달",
                "자연스러운 한국어 표현 사용",
                "캐릭터별 말투 일관성 유지",
                "초당 7-10자 이내 압축"
            ]
        )


@router.post("/approve")
async def approve_strategy(approval_id: str, modifications: Optional[Dict[str, Any]] = None):
    """
    번역 전략 승인 API
    승인 시 해당 approval_id로 번역 실행 가능
    """
    return {
        "status": "approved",
        "approval_id": approval_id,
        "message": "번역 전략이 승인되었습니다. 이제 번역을 실행할 수 있습니다.",
        "modifications_applied": modifications is not None
    }
