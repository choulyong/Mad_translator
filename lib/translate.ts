/**
 * Plot 번역 (백엔드 Metadata API + Subtitle 백엔드 Gemini)
 */

const SUBTITLE_API_URL = process.env.SUBTITLE_API_URL || "http://localhost:8033";

/** 단일 텍스트 블록 번역 (내부용) */
async function translateBlock(text: string): Promise<string | null> {
  const response = await fetch(`${SUBTITLE_API_URL}/api/v1/subtitles/batch-translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      blocks: [
        {
          index: 1,
          start: "00:00:00,000",
          end: "00:05:00,000",  // ← 5분으로 확대 (많은 텍스트 수용)
          text: text.substring(0, 20000),  // ← 5000자 → 20000자로 확대
          speaker: "Narrator",
          addressee: "General",
          duration_sec: 300,  // ← 300초 (5분)
          max_chars: 2000,  // ← 500자 → 2000자로 확대 (자막 제약 완화)
        }
      ],
      title: "Movie Plot Translation",
      genre: "Documentary",
      synopsis: "Plot summary translation from English to Korean",
      personas: "Narrator: 영화 줄거리 해설자, 중립적이고 전문적인 톤",
      fixed_terms: "",
      translation_rules: "- 원문의 모든 정보를 최대한 보존\n- 자연스러운 한글 표현 사용\n- 영화 제목과 인명은 원문 유지\n- 전문적인 톤 유지\n- 축약하지 말고 완전한 번역 제공",
      target_lang: "ko",
      prev_context: [],
    }),
  });

  if (!response.ok) {
    console.error("[Translate] Batch API error:", response.status);
    return null;
  }

  const result = await response.json();

  if (result.data && Array.isArray(result.data)) {
    for (const batch of result.data) {
      if (batch.content && Array.isArray(batch.content)) {
        for (const item of batch.content) {
          if (item.text) return item.text;
        }
      }
    }
  }

  return null;
}

export async function translateToKorean(text: string): Promise<string | null> {
  if (!text) return text;

  // 대부분 한국어면 번역 불필요 (한글 비율 30% 이상)
  const koreanChars = (text.match(/[가-힣]/g) || []).length;
  if (koreanChars / text.length > 0.3) return text;

  try {
    // 문단 구조 보존: \n\n으로 분리된 문단이 있으면 각각 번역 후 합치기
    const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);

    if (paragraphs.length > 1) {
      const translated: string[] = [];
      for (const para of paragraphs) {
        const result = await translateBlock(para);
        translated.push(result || para); // 번역 실패 시 원문 유지
      }
      return translated.join('\n\n');
    }

    // 단일 문단 번역
    return await translateBlock(text);
  } catch (err) {
    console.error("[Translate] Error:", err);
    return null;
  }
}
