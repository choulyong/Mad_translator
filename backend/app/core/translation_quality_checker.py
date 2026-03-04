# ═══════════════════════════════════════════════════════════════════════════════
# 🔍 번역 품질 검사 및 자동 수정 모듈
# ═══════════════════════════════════════════════════════════════════════════════
# 기능:
# 1. 미번역 감지 (영어 그대로 남은 자막)
# 2. 슬래시 줄바꿈 오류 자동 수정
# 3. 번역투 감지
# 4. 말투 일관성 검증
# ═══════════════════════════════════════════════════════════════════════════════

import re
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass, field
from enum import Enum


class Severity(Enum):
    """문제 심각도"""
    CRITICAL = "critical"  # 🔴 심각 - 즉시 수정 필요
    WARNING = "warning"    # 🟡 중간 - 검토 필요
    INFO = "info"          # 🟢 양호 - 참고


@dataclass
class QualityIssue:
    """품질 문제 항목"""
    line_number: int
    original: str
    translated: str
    issue_type: str
    severity: Severity
    description: str
    auto_fixable: bool = False
    suggested_fix: Optional[str] = None


@dataclass
class QualityReport:
    """품질 검사 리포트"""
    total_lines: int = 0
    untranslated_lines: List[QualityIssue] = field(default_factory=list)
    slash_errors: List[QualityIssue] = field(default_factory=list)
    translation_smell: List[QualityIssue] = field(default_factory=list)
    speech_inconsistency: List[QualityIssue] = field(default_factory=list)

    @property
    def summary(self) -> Dict:
        """요약 통계"""
        return {
            "total_lines": self.total_lines,
            "untranslated": {
                "count": len(self.untranslated_lines),
                "severity": "critical" if self.untranslated_lines else "good"
            },
            "slash_errors": {
                "count": len(self.slash_errors),
                "severity": "warning" if self.slash_errors else "good"
            },
            "translation_smell": {
                "count": len(self.translation_smell),
                "severity": "warning" if len(self.translation_smell) > 10 else "good"
            },
            "speech_inconsistency": {
                "count": len(self.speech_inconsistency),
                "severity": "warning" if self.speech_inconsistency else "good"
            }
        }


class TranslationQualityChecker:
    """번역 품질 검사기"""

    # 영어 감지 패턴 (영어만 있는 줄 — 특수문자 포함)
    ENGLISH_ONLY_PATTERN = re.compile(r'^[A-Za-z0-9\s\.,!?\'"()\-:;/&@#\$%\*\+\=\[\]\{\}<>~`\u2014\u2013\u2018\u2019\u201c\u201d\u2026]+$')

    # 영어 단어 비율 체크 (한국어에 영어가 많이 섞인 경우)
    ENGLISH_WORD_PATTERN = re.compile(r'\b[A-Za-z]{3,}\b')

    # 슬래시 줄바꿈 오류 패턴
    SLASH_LINEBREAK_PATTERN = re.compile(r'\s*/\s*')

    # 번역투 패턴
    TRANSLATION_SMELL_PATTERNS = [
        (r'할\s*것이다', "~할 것이다 → ~ㄹ 거야"),
        (r'될\s*것이다', "~될 것이다 → ~될 거야"),
        (r'일\s*것이다', "~일 것이다 → ~일 거야"),
        (r'의\s+\S+의\s+', "~의 ~의 연속 사용"),
        (r'에\s*대해서?', "~에 대해 과다 사용"),
        (r'에\s*관해서?', "~에 관해 과다 사용"),
        # 그녀 — 모든 조사 형태 (문장 시작 + 중간)
        (r'그녀[가는를의에도]', "그녀+조사 번역투"),
        # 그(he) — "그는/그가" (단, "그거/그건/그게/그걸" 등은 정상이므로 조사 한정)
        (r'(?:^|[\s,])그[는가를의에]\s', "그+조사 번역투"),
        # 그들 — 모든 조사 형태
        (r'그들[은이의을에도]', "그들+조사 번역투"),
        # 그것 — 모든 형태
        (r'그것[은이을의에도]', "그것+조사 번역투"),
        (r'하는\s*것(?:이|을|에)', "~하는 것 → ~하기/~하는 거"),
        (r'만약\s+.+한?다면', "만약 ~한다면 → ~하면"),
    ]

    # 존댓말 마커
    FORMAL_MARKERS = ['요', '세요', '습니다', '니다', '십시오', '시오', '겠습니다', '드립니다', '드릴게요']

    # 반말 마커
    INFORMAL_MARKERS = ['야', '어', '아', '해', '지', '냐', '니', '거든', '잖아', '거야', '네']

    def __init__(self):
        self.speech_memory: Dict[str, str] = {}  # 캐릭터 간 말투 기억

    def check_quality(self, subtitles: List[Dict]) -> QualityReport:
        """
        전체 품질 검사 실행

        Args:
            subtitles: [{"id": 1, "en": "Hello", "ko": "안녕"}, ...]

        Returns:
            QualityReport
        """
        report = QualityReport(total_lines=len(subtitles))

        for sub in subtitles:
            line_num = sub.get('id', 0)
            original = sub.get('en', '')
            translated = sub.get('ko', '')

            # 1. 미번역 검사
            untranslated = self._check_untranslated(line_num, original, translated)
            if untranslated:
                report.untranslated_lines.append(untranslated)

            # 2. 슬래시 오류 검사
            slash_error = self._check_slash_error(line_num, original, translated)
            if slash_error:
                report.slash_errors.append(slash_error)

            # 3. 번역투 검사
            smell_issues = self._check_translation_smell(line_num, original, translated)
            report.translation_smell.extend(smell_issues)

        # 4. 말투 일관성 검사 (전체 자막 대상)
        speech_issues = self._check_speech_consistency(subtitles)
        report.speech_inconsistency.extend(speech_issues)

        return report

    def _check_untranslated(self, line_num: int, original: str, translated: str) -> Optional[QualityIssue]:
        """미번역 검사"""
        if not translated or not translated.strip():
            return QualityIssue(
                line_number=line_num,
                original=original,
                translated=translated,
                issue_type="untranslated",
                severity=Severity.CRITICAL,
                description="번역 누락 (빈 문자열)",
                auto_fixable=False
            )

        # 원문과 동일한 경우 (가장 확실한 미번역 신호)
        if original and translated.strip().lower() == original.strip().lower():
            # 감탄사/효과음은 원문 그대로일 수 있으므로 제외
            if len(original.strip()) > 3 and not re.match(r'^[\s♪\*\[\(]', original.strip()):
                return QualityIssue(
                    line_number=line_num,
                    original=original,
                    translated=translated,
                    issue_type="untranslated",
                    severity=Severity.CRITICAL,
                    description="미번역 (원문과 동일)",
                    auto_fixable=False
                )

        # 영어만 있는 경우
        if self.ENGLISH_ONLY_PATTERN.match(translated.strip()):
            # 감탄사, 이름 등 예외 처리 (대소문자 무시)
            exceptions = {s.lower() for s in [
                'OK', 'Hi', 'Hey', 'Oh', 'Ah', 'Wow', 'Yes', 'No', 'Yeah', 'Okay',
                'Mm', 'Hmm', 'Uh', 'Um', 'Huh', 'Shh', 'Bye', 'Bravo',
            ]}
            if translated.strip().lower() not in exceptions and len(translated.strip()) > 3:
                return QualityIssue(
                    line_number=line_num,
                    original=original,
                    translated=translated,
                    issue_type="untranslated",
                    severity=Severity.CRITICAL,
                    description="미번역 (영어 그대로)",
                    auto_fixable=False
                )

        # 영어 단어가 너무 많은 경우 (40% 이상)
        korean_chars = len(re.findall(r'[가-힣]', translated))
        english_words = len(self.ENGLISH_WORD_PATTERN.findall(translated))
        total_meaningful = korean_chars + english_words * 3  # 영어 단어 평균 3자

        if total_meaningful > 0 and english_words * 3 / total_meaningful > 0.4:
            if len(translated) > 8:  # 짧은 문장 제외
                return QualityIssue(
                    line_number=line_num,
                    original=original,
                    translated=translated,
                    issue_type="partial_untranslated",
                    severity=Severity.WARNING,
                    description=f"부분 미번역 (영어 {english_words}단어)",
                    auto_fixable=False
                )

        return None

    def _check_slash_error(self, line_num: int, original: str, translated: str) -> Optional[QualityIssue]:
        """슬래시 줄바꿈 오류 검사"""
        if not translated:
            return None

        # " / " 패턴 찾기 (가사 ♪ 제외)
        if ' / ' in translated and '♪' not in translated:
            # 수정된 버전 생성
            fixed = translated.replace(' / ', '\n')

            return QualityIssue(
                line_number=line_num,
                original=original,
                translated=translated,
                issue_type="slash_linebreak",
                severity=Severity.WARNING,
                description="슬래시 줄바꿈 오류",
                auto_fixable=True,
                suggested_fix=fixed
            )

        return None

    def _check_translation_smell(self, line_num: int, original: str, translated: str) -> List[QualityIssue]:
        """번역투 검사"""
        issues = []

        if not translated:
            return issues

        for pattern, description in self.TRANSLATION_SMELL_PATTERNS:
            if re.search(pattern, translated):
                issues.append(QualityIssue(
                    line_number=line_num,
                    original=original,
                    translated=translated,
                    issue_type="translation_smell",
                    severity=Severity.INFO,
                    description=description,
                    auto_fixable=False
                ))

        return issues

    def _check_speech_consistency(self, subtitles: List[Dict]) -> List[QualityIssue]:
        """말투 일관성 검사"""
        issues = []
        speech_history: Dict[Tuple[str, str], List[Dict]] = {}

        for sub in subtitles:
            translated = sub.get('ko', '')
            if not translated:
                continue

            # 간단한 말투 분석 (존댓말 vs 반말)
            speech_level = self._detect_speech_level(translated)
            if speech_level:
                line_num = sub.get('id', 0)

                # 히스토리에 저장 (간단히 line_num 기준으로)
                # 실제로는 화자 정보가 필요하지만, 없으면 연속된 자막 비교
                key = f"line_{line_num // 50}"  # 50줄 단위로 그룹화

                if key not in speech_history:
                    speech_history[key] = []

                speech_history[key].append({
                    "line": line_num,
                    "text": translated,
                    "level": speech_level
                })

        # 그룹 내에서 급격한 말투 변화 감지
        for key, history in speech_history.items():
            prev_level = None
            for item in history:
                if prev_level and item["level"] != prev_level:
                    # 연속된 줄에서 말투가 바뀐 경우
                    issues.append(QualityIssue(
                        line_number=item["line"],
                        original="",
                        translated=item["text"],
                        issue_type="speech_inconsistency",
                        severity=Severity.INFO,
                        description=f"말투 변화 감지: {prev_level} → {item['level']}",
                        auto_fixable=False
                    ))
                prev_level = item["level"]

        return issues

    def _detect_speech_level(self, text: str) -> Optional[str]:
        """말투 레벨 감지"""
        formal_count = sum(1 for marker in self.FORMAL_MARKERS if marker in text)
        informal_count = sum(1 for marker in self.INFORMAL_MARKERS if marker in text)

        if formal_count > informal_count and formal_count > 0:
            return "존댓말"
        elif informal_count > formal_count and informal_count > 0:
            return "반말"

        return None

    def auto_fix_slash_errors(self, subtitles: List[Dict], preserve_music_slash: bool = True) -> Tuple[List[Dict], int]:
        """
        슬래시 줄바꿈 오류 자동 수정

        Args:
            subtitles: 자막 리스트
            preserve_music_slash: 가사(♪) 내 슬래시 유지 여부

        Returns:
            (수정된 자막 리스트, 수정 개수)
        """
        fixed_count = 0
        result = []

        for sub in subtitles:
            translated = sub.get('ko', '')

            if translated and ' / ' in translated:
                # 가사 내 슬래시 처리
                if preserve_music_slash and '♪' in translated:
                    # 가사는 그대로 유지
                    result.append(sub)
                else:
                    # 슬래시를 줄바꿈으로 변환
                    fixed = translated.replace(' / ', '\n')
                    result.append({**sub, 'ko': fixed})
                    fixed_count += 1
            else:
                result.append(sub)

        return result, fixed_count

    def get_untranslated_indices(self, subtitles: List[Dict]) -> List[int]:
        """
        미번역 자막 인덱스 리스트 반환 (재번역 요청용)
        """
        indices = []

        for sub in subtitles:
            line_num = sub.get('id', 0)
            original = sub.get('en', '')
            translated = sub.get('ko', '')

            issue = self._check_untranslated(line_num, original, translated)
            if issue:
                indices.append(line_num)

        return indices


# ═══════════════════════════════════════════════════════════════════════════════
# API용 함수들
# ═══════════════════════════════════════════════════════════════════════════════

def check_translation_quality(subtitles: List[Dict]) -> Dict:
    """
    번역 품질 검사 (API용)

    Args:
        subtitles: [{"id": 1, "en": "...", "ko": "..."}, ...]

    Returns:
        품질 리포트 딕셔너리
    """
    checker = TranslationQualityChecker()
    report = checker.check_quality(subtitles)

    return {
        "summary": report.summary,
        "untranslated": [
            {
                "line": issue.line_number,
                "original": issue.original,
                "translated": issue.translated,
                "description": issue.description
            }
            for issue in report.untranslated_lines
        ],
        "slash_errors": [
            {
                "line": issue.line_number,
                "original": issue.translated,
                "suggested_fix": issue.suggested_fix,
                "auto_fixable": issue.auto_fixable
            }
            for issue in report.slash_errors
        ],
        "translation_smell": [
            {
                "line": issue.line_number,
                "text": issue.translated,
                "pattern": issue.description
            }
            for issue in report.translation_smell[:20]  # 최대 20개
        ],
        "speech_issues": [
            {
                "line": issue.line_number,
                "text": issue.translated,
                "description": issue.description
            }
            for issue in report.speech_inconsistency[:20]  # 최대 20개
        ]
    }


def auto_fix_subtitles(subtitles: List[Dict], fix_options: Dict = None) -> Dict:
    """
    자막 자동 수정 (API용)

    Args:
        subtitles: 자막 리스트
        fix_options: {
            "slash_errors": True,
            "preserve_music_slash": True
        }

    Returns:
        수정 결과
    """
    options = fix_options or {}
    checker = TranslationQualityChecker()

    result = {
        "fixed_subtitles": subtitles,
        "fixes_applied": {}
    }

    # 슬래시 오류 수정
    if options.get("slash_errors", True):
        fixed_subs, slash_count = checker.auto_fix_slash_errors(
            subtitles,
            preserve_music_slash=options.get("preserve_music_slash", True)
        )
        result["fixed_subtitles"] = fixed_subs
        result["fixes_applied"]["slash_errors"] = slash_count

    return result


def get_retranslation_targets(subtitles: List[Dict]) -> List[Dict]:
    """
    재번역이 필요한 자막 블록 추출 (API용)
    """
    checker = TranslationQualityChecker()
    indices = checker.get_untranslated_indices(subtitles)

    targets = []
    for sub in subtitles:
        if sub.get('id') in indices:
            targets.append({
                "index": sub.get('id'),
                "text": sub.get('en', ''),
                "start": sub.get('start', ''),
                "end": sub.get('end', '')
            })

    return targets
