# backend/app/core/tone_mapper.py
from typing import Dict, Any, Optional
import re

def parse_srt_time_to_ms(time_str: str) -> int:
    """SRT 시간 문자열(00:00:00,000)을 밀리초(ms)로 변환"""
    if not time_str: return 0
    try:
        time_str = time_str.replace(".", ",")
        parts = time_str.split(",")
        ms = int(parts[1]) if len(parts) > 1 else 0
        h, m, s = map(int, parts[0].split(":"))
        return h * 3600000 + m * 60000 + s * 1000 + ms
    except Exception:
        return 0

class RelationToneMapper:
    """
    (Speaker, Addressee) 기반의 톤 맵핑 스토어.
    단일 캐릭터의 절대적인 톤이 아니라, 관계를 기반으로 톤을 맵핑하며
    타임코드(Time-Stamped) 기반의 톤 변화 규칙도 지원한다.
    """
    def __init__(self, initial_relations: list = None):
        # 쌍방향 키: "Speaker → Addressee"
        self._matrix: Dict[str, Dict[str, Any]] = {}
        if initial_relations:
            self.update_from_strategy(initial_relations)

    def _make_key(self, speaker: str, addressee: str) -> str:
        s = (speaker or "").strip()
        a = (addressee or "").strip()
        return f"{s} → {a}"

    def update_from_strategy(self, relationships: list):
        """Strategy Blueprint (Pass 0)의 관계 정보 및 타임코드 기반 톤 변화 주입"""
        for rel in relationships:
            if not isinstance(rel, dict):
                continue
            speaker = rel.get("from_char") or rel.get("from")
            addressee = rel.get("to_char") or rel.get("to")
            speech_level = rel.get("speech_level", "")
            time_rules = rel.get("time_rules", []) # [{"start": "00:00:00,000", "end": "00:10:00,000", "speech_level": "banmal"}]
            
            if speaker and addressee:
                key = self._make_key(speaker, addressee)
                # 톤 결정
                is_banmal = "banmal" in speech_level.lower() or "반말" in speech_level
                level = "banmal" if is_banmal else "honorific"
                
                # 타임코드 룰 파싱
                parsed_time_rules = []
                for tr in time_rules:
                    st_ms = parse_srt_time_to_ms(tr.get("start"))
                    en_ms = parse_srt_time_to_ms(tr.get("end"))
                    t_lv = tr.get("speech_level", "")
                    t_is_banmal = "banmal" in t_lv.lower() or "반말" in t_lv
                    parsed_time_rules.append({
                        "start_ms": st_ms,
                        "end_ms": en_ms,
                        "level": "banmal" if t_is_banmal else "honorific"
                    })
                
                self._matrix[key] = {
                    "level": level,
                    "updated_by": "strategy",
                    "locked": True,
                    "time_rules": parsed_time_rules
                }

    def update_from_dynamic_extraction(self, char_relations: dict):
        """Pass 0.5 (자막에서 자동 추출된 관계 매트릭스) 정보를 통합"""
        for key, rel_desc in char_relations.items():
            if " → " in key:
                if key not in self._matrix:
                    # 미확정 관계라면 설명(rel_desc) 기반 휴리스틱 추론 가능 (안전 장치로 honorific)
                    self._matrix[key] = {
                        "level": "honorific", 
                        "updated_by": "dynamic_extraction",
                        "locked": False,
                        "time_rules": [],
                        "desc": rel_desc
                    }

    def get_tone(self, speaker: str, addressee: str, current_time_str: str = None) -> str:
        """
        지정된 (Speaker, Addressee)의 톤을 반환 (banmal 또는 honorific)
        타임코드(current_time)가 제공되면 time_rules를 우선 검사한다.
        """
        key = self._make_key(speaker, addressee)
        
        # Addressee가 없거나 일반적인 혼잣말인 경우를 위한 fallback
        fallback_key = self._make_key(speaker, "?")
        
        info = self._matrix.get(key) or self._matrix.get(fallback_key)
        
        if info:
            current_ms = parse_srt_time_to_ms(current_time_str) if current_time_str else -1
            if current_ms >= 0:
                for tr in info.get("time_rules", []):
                    if tr["start_ms"] <= current_ms <= tr["end_ms"]:
                        return tr["level"]
            return info.get("level", "honorific")
            
        return "honorific" # 기본 안전 폴백

    def inject_few_shot_anchor(self, speaker: str, addressee: str, current_time_str: str = None) -> str:
        """Pass 1 LLM에게 주입할 강력한 앵커 프롬프트 텍스트 반환"""
        if not speaker:
            return ""
            
        target = addressee if addressee else "(불특정/군중)"
        tone = self.get_tone(speaker, addressee, current_time_str)
        
        if tone == "banmal":
            return f"\n[톤 강제 앵커] 화자({speaker})는 청자({target})에게 반드시 **반말**을 씁니다. (절대 금지: ~요, ~습니다 / 권장 어미: ~다, ~군, ~지, ~어, ~야)"
        else:
            return f"\n[톤 강제 앵커] 화자({speaker})는 청자({target})에게 반드시 **존댓말**을 씁니다. (권장 어미: ~요, ~습니다)"

    def export(self):
        """로깅용"""
        return self._matrix
