# subtitle_cleaner.py
import re

ITALIC_TAG_RE = re.compile(r"</?i>", re.IGNORECASE)

def _normalize_fx_line(line: str) -> str:
    s = line.strip()
    if not s:
        return ""

    # remove italic tags
    s = ITALIC_TAG_RE.sub("", s).strip()

    # music ♪ ... ♪ → [음악]
    if "♪" in s:
        return "[음악]"

    # ( ... ) → [ ... ]
    if s.startswith("(") and s.endswith(")") and len(s) >= 3:
        inner = s[1:-1].strip()
        if inner:
            return f"[{inner}]"

    return s


def clean_subtitle_text(text: str) -> str:
    """
    - <i> 제거
    - FX/음악 스타일 통일
    - 동일 라인 중복 제거
    """
    lines = text.split("\n")
    out = []

    for ln in lines:
        ln = _normalize_fx_line(ln)
        if not ln:
            continue
        if out and out[-1] == ln:
            continue
        out.append(ln)

    return "\n".join(out)


def remove_duplicate_blocks(blocks, gap_ms=800):
    """
    blocks: [{"start": ms, "end": ms, "text": str}, ...]
    연속 동일 자막 제거
    """
    cleaned = []

    for b in blocks:
        if not cleaned:
            cleaned.append(b)
            continue

        prev = cleaned[-1]

        if (
            b["text"] == prev["text"]
            and b["start"] - prev["end"] <= gap_ms
        ):
            continue

        cleaned.append(b)

    return cleaned
