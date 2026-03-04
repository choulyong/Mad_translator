"""SRT 파일 생성 및 다운로드 모듈"""
import io
import re

# [번역 실패: ...] 패턴 - 최종 안전망
_FAIL_PATTERN = re.compile(r'^\[번역\s*실패')

def generate_srt(subtitles: list) -> str:
    """
    번역된 자막을 SRT 형식으로 생성

    Args:
        subtitles: [{"id": "1", "start": 0.0, "end": 3.0, "ko": "안녕하세요"}, ...]

    Returns:
        SRT 형식의 문자열
    """
    if not subtitles:
        return ""

    merged_blocks = []
    
    for sub in subtitles:
        start = _seconds_to_timecode(sub.get("start", 0))
        end = _seconds_to_timecode(sub.get("end", 0))
        text = sub.get("ko", "")
        
        # `ko` 필드에 한국어가 포함되어 있거나, 일반 텍스트가 의미 있게 채워져 있는 경우
        has_korean_content = text and not _FAIL_PATTERN.match(text) and text.strip() != ""

        if has_korean_content:
            merged_blocks.append({
                "start": start,
                "end": end,
                "text": text,
                "is_valid": True
            })
        else:
            # 텍스트가 비어 있거나 실패 패턴일 경우 앞선 유효 블록과 합침
            if merged_blocks and merged_blocks[-1]["is_valid"]:
                merged_blocks[-1]["end"] = end
            else:
                # 합칠 앞 블록이 없거나, 앞 블록도 번역 실패인 경우
                merged_blocks.append({
                    "start": start,
                    "end": end,
                    "text": "" if _FAIL_PATTERN.match(text) else text,
                    "is_valid": False
                })

    srt_lines = []
    for i, mb in enumerate(merged_blocks, 1):
        srt_lines.append(str(i))
        srt_lines.append(f"{mb['start']} --> {mb['end']}")
        srt_lines.append(mb['text'])
        srt_lines.append("")

    return "\n".join(srt_lines)


def _seconds_to_timecode(seconds: float) -> str:
    """
    초(float)를 SRT 타임코드로 변환
    예: 123.456 → 00:02:03,456
    """
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)

    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def create_srt_file(subtitles: list) -> io.BytesIO:
    """
    SRT 파일을 바이트 스트림으로 생성
    다운로드용
    """
    srt_content = generate_srt(subtitles)
    bytes_io = io.BytesIO(srt_content.encode('utf-8'))
    bytes_io.seek(0)
    return bytes_io
