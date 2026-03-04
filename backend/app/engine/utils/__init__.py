"""
Engine Utils — 번역 엔진 유틸리티 모듈

제공 모듈:
- parsing: JSON 정제 및 파싱
- batching: 시맨틱 배칭
- postprocessing: 후처리 함수들
- tone_memory: 톤 메모리 및 일관성 관리
- character: 화자 관계 및 호칭 감지
"""

# Parsing
from .parsing import sanitize_json, parse_translation_response

# Batching
from .batching import (
    parse_timecode_to_seconds,
    compute_block_duration,
    compute_max_chars,
    detect_batch_mood,
    apply_hard_binding,
    build_semantic_batches,
)

# Postprocessing
from .postprocessing import (
    norm_for_dedup,
    fix_music_notes,
    normalize_dialogue_dashes,
    normalize_punctuation,
    smart_linebreak,
    postprocess_translations,
    sanitize_subtitle_text,
)

# Tone Memory
from .tone_memory import (
    detect_tone_from_korean,
    check_qc_needed,
    extract_tone_from_batch,
    update_confirmed_speech_levels,
    detect_dedup,
)

# Character
from .character import detect_side_talk, VOCATIVE_DICT

__all__ = [
    # Parsing
    "sanitize_json",
    "parse_translation_response",
    # Batching
    "parse_timecode_to_seconds",
    "compute_block_duration",
    "compute_max_chars",
    "detect_batch_mood",
    "apply_hard_binding",
    "build_semantic_batches",
    # Postprocessing
    "norm_for_dedup",
    "fix_music_notes",
    "normalize_dialogue_dashes",
    "normalize_punctuation",
    "smart_linebreak",
    "postprocess_translations",
    "sanitize_subtitle_text",
    # Tone Memory
    "detect_tone_from_korean",
    "check_qc_needed",
    "extract_tone_from_batch",
    "update_confirmed_speech_levels",
    "detect_dedup",
    # Character
    "detect_side_talk",
    "VOCATIVE_DICT",
]
