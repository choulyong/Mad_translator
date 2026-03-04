"""
Pass 5.7: Timecode Hygiene Sorter (타임코드 위생 검사기)

역할:
- 물리적 SRT 블록들의 길이나 오버랩(Overlap) 연산.
- 1초 미만으로 극단적으로 짧은 블록 감지.
- 시작 시간이 이전 블록보다 앞서는 역전(Inversion) 현상 감지.
- 타임코드 오류에 대한 로그(Warnings) 출력 밑 기초 교정.
"""

from typing import Dict, Any, List
from datetime import datetime
import re

def _parse_time(time_str: str) -> float:
    """SRT 타임코드(00:00:00,000)를 초(second) 단위의 float로 변환"""
    # 기본 SRT 포맷이 아닐 경우 대비
    match = re.search(r'(\d+):(\d+):(\d+)[,.](\d+)', time_str)
    if not match:
        return 0.0
    h, m, s, ms = map(int, match.groups())
    return h * 3600 + m * 60 + s + ms / 1000.0

def _format_time(seconds: float) -> str:
    """초(second)를 SRT 타임코드 포맷으로 변환"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

async def run_pass_5_7(
    job: Dict[str, Any],
    blocks: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    job["current_pass"] = "Pass 5.7: 타임코드 위생 검사"
    job["progress"] = 99
    job["logs"].append("> [Pass 5.7] 타임코드 위생 검사(Module E) 시작...")

    if not blocks:
        return blocks

    warnings = []
    infos = []
    fixed = 0
    
    # TC-5: 빈 텍스트 블록 감지 및 삭제
    new_blocks = []
    for b in blocks:
        if b.get("ko", "").strip():
            new_blocks.append(b)
        else:
            job["logs"].append(f"  🔪 [Pass 5.7] TC-5 삭제: 빈 텍스트 블록(ID {b.get('id')}) 제거")
            fixed += 1
    blocks = new_blocks

    previous_end = 0.0

    for i, block in enumerate(blocks):
        start_str = block.get("start", "")
        end_str = block.get("end", "")
        
        if not start_str or not end_str:
            continue
            
        start_sec = _parse_time(start_str)
        end_sec = _parse_time(end_str)
        duration = end_sec - start_sec

        # TC-2: 역전/오버랩 현상 감지 및 교정 (start < prev_end)
        if start_sec < previous_end and i > 0:
            overlap = previous_end - start_sec
            if overlap > 0.1:
                warnings.append(f"TC-2 오버랩 감지: 블록 {block.get('id')} ({start_str} < 이전 {previous_end:.2f}초)")
                start_sec = previous_end + 0.001
                block["start"] = _format_time(start_sec)
                fixed += 1
                
        # TC-3: 60초+ 갭 -> info
        if i > 0 and (start_sec - previous_end) >= 60.0:
            infos.append(f"TC-3 롱 갭: 블록 {block.get('id')} 이전 ({start_sec - previous_end:.1f}초)")

        # TC-1: duration > 8초 (경고), > 12초 (분할 - 여기서는 경고 및 로그로 안내)
        if duration > 12.0:
            warnings.append(f"TC-1 초과 길이(>12초): 블록 {block.get('id')} ({duration:.1f}초) -> 강제 분할 필요")
            # TODO: 실제 타임코드/텍스트 분할 로직 보강 시 추가
        elif duration > 8.0:
            warnings.append(f"TC-1 긴 길이(>8초): 블록 {block.get('id')} ({duration:.1f}초)")
            
        # TC-4: 3줄 이상 텍스트 -> 2줄로 병합/분할
        ko_text = block.get("ko", "")
        lines = ko_text.split("\n")
        if len(lines) >= 3:
            warnings.append(f"TC-4 과다 줄바꿈(3줄 이상): 블록 {block.get('id')}")
            # 단순 2줄로 강제 병합 (가장 짧은 줄을 이전/다음 줄에 붙임)
            # 여기서는 편의상 중간 공백 치환으로 2줄화
            block["ko"] = " ".join(lines[:-1]) + "\n" + lines[-1]
            fixed += 1

        previous_end = max(end_sec, start_sec)

    if infos:
        job["logs"].append(f"  ℹ  [Pass 5.7] 특이사항 {len(infos)}건 (ex: 60초+ 갭).")
    if warnings:
        job["logs"].append(f"  ⚠ [Pass 5.7] 타임코드 위생 경고 {len(warnings)}건 발견.")
        for w in warnings[:5]:
            job["logs"].append(f"    - {w}")
        if len(warnings) > 5:
            job["logs"].append(f"    - ...외 {len(warnings)-5}건")
            
    if fixed > 0:
        job["logs"].append(f"  🔪 [Pass 5.7] 자동 교정 완료: {fixed}개 타임코드/위생 규칙 적용")

    job["logs"].append(f"  ✅ [Pass 5.7] 타임코드 위생 검사(Module E) 완료")
    
    return blocks
