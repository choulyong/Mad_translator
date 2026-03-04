import re
from datetime import timedelta

class LogicGate:
    """
    🏛️ Subtitle Translation OS: Execution Kernel - The Logic-Gate
    자막 번역의 5대 절대 원칙을 물리적으로 강제하는 핵심 클래스.
    """

    def __init__(self):
        self.signature = "0\n00:00:00,500 --> 00:00:05,000\nMade by Med AI\n\n"

    def recursive_noise_sanitization(self, text: str) -> str:
        """Rule 3: 모든 HTML 태그 및 시스템 메타데이터 소거."""
        # HTML 태그 제거 (e.g., <span>, <i>, ...)
        clean_text = re.sub(r'<[^>]*>', '', text)
        # 시스템 메타데이터 제거 (e.g., [cite], [span_x], ...)
        clean_text = re.sub(r'\[(?:cite|span_\w+)\]', '', clean_text)
        return clean_text.strip()

    def bit_level_mirroring(self, original_srt: str) -> list:
        """Rule 2: 인덱스 번호와 타임코드를 비트 단위로 일치시켜 파싱."""
        # SRT 패턴: index\nstart --> end\ntext\n\n
        pattern = r"(\d+)\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\n([\s\S]*?)(?:\n\n|\Z)"
        matches = re.findall(pattern, original_srt)
        
        blocks = []
        for match in matches:
            idx, start, end, text = match
            blocks.append({
                'index': int(idx),
                'timecode': f"{start} --> {end}",
                'text': text
            })
        return blocks

    def format_text(self, text: str, mode: str = 'dialogue') -> str:
        """Rule 5: Formatting Protocol 적용."""
        if mode == 'dialogue' and not text.startswith('-'):
            return f"- {text}"
        elif mode == 'onscreen':
            return f"[{text}]"
        elif mode == 'music':
            return f"♪ {text}"
        return text

    def finalize_srt(self, translated_blocks: list) -> str:
        """Rule 1 & Rule 2 결합: 최종 SRT 생성."""
        output = self.signature # Signature Zero (Rule 1)
        
        for block in translated_blocks:
            # 원본 인덱스 유지 (Rule 2)
            output += f"{block['index']}\n"
            output += f"{block['timecode']}\n"
            output += f"{block['text']}\n\n"
        
        return output.strip()

    def refine_text_length(self, text: str, duration_sec: float) -> str:
        """Rule 2: 가독성 제약(초당 7~10자) 준수를 위한 문장 압축 (Placeholder)."""
        # 실제 구현에서는 LLM에게 압축을 요청하거나 알고리즘 적용
        # 여기서는 로직 틀만 제공
        max_chars = int(duration_sec * 10)
        if len(text) > max_chars:
            # TODO: LLM Refinement Logic
            pass
        return text
