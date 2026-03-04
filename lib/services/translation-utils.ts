/**
 * Translation Utility Functions — V3 Cinema Engine
 * Timecode parsing, CPS computation, mood detection, tone analysis.
 */

import type { SubtitleBlock } from "@/lib/store/translate-types";

/**
 * SRT timecode → seconds (e.g. "00:01:23,456" → 83.456)
 */
export function parseTimecodeToSeconds(tc: string): number {
  if (!tc) return 0;
  // Accept both comma and dot as millisecond separator
  const normalized = tc.replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length !== 3) return 0;
  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  const seconds = parseFloat(parts[2]) || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Remove technical noise from subtitle text before sending to LLM
 */
export function sanitizeSubtitleText(text: string): string {
  if (!text) return "";
  let cleaned = text;
  // Remove HTML tags
  cleaned = cleaned.replace(/<[^>]+>/g, "");
  // Remove font/color tags remnants
  cleaned = cleaned.replace(/\{\\[^}]+\}/g, "");
  // Normalize whitespace (but preserve intentional newlines)
  cleaned = cleaned.replace(/[ \t]+/g, " ");
  // Trim each line
  cleaned = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
  return cleaned.trim();
}

/**
 * Compute block display duration in seconds
 */
export function computeBlockDuration(block: SubtitleBlock): number {
  const startSec = parseTimecodeToSeconds(block.start);
  const endSec = parseTimecodeToSeconds(block.end);
  const duration = endSec - startSec;
  return Math.max(duration, 0.5); // minimum 0.5s
}

/**
 * Compute maximum Korean character count for CPS compliance.
 * Default CPS rate: 14 chars/sec (Korean OTT standard)
 */
export function computeMaxChars(durationSec: number, cpsRate = 14): number {
  return Math.max(Math.floor(durationSec * cpsRate), 4); // minimum 4 chars
}

/**
 * Detect overall mood of a batch from English source text.
 * Returns: "tense" | "romantic" | "humorous" | "sad" | "formal" | "neutral"
 */
export function detectBatchMood(blocks: SubtitleBlock[]): string {
  if (!blocks || blocks.length === 0) return "neutral";

  const allText = blocks
    .map((b) => b.en)
    .join(" ")
    .toLowerCase();

  // Keyword scoring
  const scores: Record<string, number> = {
    tense: 0,
    romantic: 0,
    humorous: 0,
    sad: 0,
    formal: 0,
  };

  // Tense / Action
  const tenseWords = [
    "kill", "die", "dead", "gun", "shoot", "run", "hurry", "bomb",
    "attack", "fight", "danger", "help", "stop", "now", "quick",
    "fuck", "shit", "damn", "hell", "bastard",
  ];
  // Romantic
  const romanticWords = [
    "love", "kiss", "heart", "beautiful", "darling", "honey", "miss",
    "marry", "together", "forever", "feel", "dream",
  ];
  // Humorous
  const humorousWords = [
    "funny", "laugh", "joke", "crazy", "stupid", "dude", "bro",
    "awesome", "cool", "weird", "haha", "lol",
  ];
  // Sad
  const sadWords = [
    "cry", "tear", "sorry", "lost", "gone", "never", "alone",
    "death", "funeral", "miss", "goodbye", "farewell",
  ];
  // Formal
  const formalWords = [
    "sir", "ma'am", "your honor", "court", "president", "senator",
    "doctor", "protocol", "regulation", "report", "briefing",
  ];

  for (const w of tenseWords) if (allText.includes(w)) scores.tense++;
  for (const w of romanticWords) if (allText.includes(w)) scores.romantic++;
  for (const w of humorousWords) if (allText.includes(w)) scores.humorous++;
  for (const w of sadWords) if (allText.includes(w)) scores.sad++;
  for (const w of formalWords) if (allText.includes(w)) scores.formal++;

  // Exclamation marks → tense
  const exclamations = (allText.match(/!/g) || []).length;
  scores.tense += Math.min(exclamations, 5);

  // Question marks → neutral (no bias)
  // Ellipsis → sad/romantic
  const ellipsis = (allText.match(/\.\.\./g) || []).length;
  scores.sad += Math.min(ellipsis, 3);
  scores.romantic += Math.min(ellipsis, 2);

  // Find highest score
  let maxScore = 0;
  let mood = "neutral";
  for (const [key, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      mood = key;
    }
  }

  // Threshold: need at least 2 signals
  return maxScore >= 2 ? mood : "neutral";
}

/**
 * Detect tone (formal/informal) from Korean text.
 * Lightweight heuristic for tone memory extraction.
 */
export function detectToneFromKorean(
  text: string
): "formal" | "informal" | null {
  if (!text || text.trim().length < 2) return null;

  const stripped = text.replace(/[.!?\s]+$/, "");

  const formalEndings = [
    "습니다", "합니다", "입니다", "됩니다", "겠습니다",
    "세요", "하세요", "주세요", "까요", "나요", "지요",
  ];
  const informalEndings = [
    "해", "야", "지", "어", "네", "걸", "잖아", "거든",
    "구나", "군", "다", "래", "거야",
  ];

  for (const ending of formalEndings) {
    if (stripped.endsWith(ending)) return "formal";
  }
  for (const ending of informalEndings) {
    if (stripped.endsWith(ending)) return "informal";
  }

  return null;
}
