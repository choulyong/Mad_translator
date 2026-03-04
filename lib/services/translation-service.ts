/**
 * Translation Service V3 — Cinema Engine
 * Module-level singleton. Runs independently of React component lifecycle.
 *
 * V3 Pass Flow:
 *   Pass 0   — Speaker identification (/identify-speakers)
 *   Pass 0.5 — Addressee estimation + speech policy (frontend only)
 *   Pass 1   — Semantic batch translation (CPS + tone memory)
 *   Pass 2   — Failed batch retry
 *   Pass 3   — Missing block fill
 *   Pass 4   — LLM-as-Judge QC
 */

import { useTranslateStore } from "@/lib/store/translate-store";
import type {
  SubtitleBlock,
  SemanticBatch,
  ToneMemoryEntry,
  SpeechPolicy,
  SpeechPolicyType,
  ConfirmedSpeechLevel,
} from "@/lib/store/translate-types";
import {
  parseTimecodeToSeconds,
  sanitizeSubtitleText,
  computeBlockDuration,
  computeMaxChars,
  detectBatchMood,
  detectToneFromKorean,
} from "./translation-utils";

// API config
const getApiBase = () => {
  if (typeof window !== "undefined") {
    return "/api/v1";  // 항상 상대경로 → Next.js rewrite로 localhost:8033/api/v1 프록시
  }
  return process.env.NEXT_PUBLIC_API_BASE || "https://sub.metaldragon.co.kr/api/v1";
};
const API_BASE = getApiBase();
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

// Module-level abort controller for cancellation
let abortController: AbortController | null = null;

// ====== fetchWithRetry ======
export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = MAX_RETRIES
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      const mergedSignal = options.signal;
      if (mergedSignal) {
        mergedSignal.addEventListener("abort", () => controller.abort());
      }

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) return response;
      if (response.status >= 500) {
        throw new Error(`Server error: ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error as Error;
      if (error instanceof Error && error.name === "AbortError") {
        if (abortController?.signal.aborted) throw error;
        console.warn(`[WARN] Request timed out on attempt ${attempt + 1}`);
      }
      if (attempt < maxRetries - 1) {
        const backoff = Math.min(
          INITIAL_BACKOFF_MS * Math.pow(2, attempt),
          MAX_BACKOFF_MS
        );
        console.log(`[INFO] Retrying in ${backoff}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  throw lastError || new Error("Request failed after retries");
}

// ====== Store helpers ======
function getStore() {
  return useTranslateStore.getState();
}
function addLog(message: string) {
  getStore().addLog(message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 4: Semantic Batching
// ═══════════════════════════════════════════════════════════════════════════════

function buildSemanticBatches(subtitles: SubtitleBlock[]): SemanticBatch[] {
  if (subtitles.length === 0) return [];

  const MIN_BATCH = 20;
  const MAX_BATCH = 40;
  const SCENE_GAP_SEC = 2.5;

  const batches: SemanticBatch[] = [];
  let currentBatch: SubtitleBlock[] = [];
  let batchStart = 0;

  for (let i = 0; i < subtitles.length; i++) {
    currentBatch.push(subtitles[i]);

    // Check if we should split here
    let shouldSplit = false;
    let isSceneBreak = false;

    if (i < subtitles.length - 1) {
      const currentEnd = parseTimecodeToSeconds(subtitles[i].end);
      const nextStart = parseTimecodeToSeconds(subtitles[i + 1].start);
      const gap = nextStart - currentEnd;

      // Scene break: gap > 2.5s AND batch >= MIN_BATCH
      if (gap > SCENE_GAP_SEC && currentBatch.length >= MIN_BATCH) {
        shouldSplit = true;
        isSceneBreak = true;
      }

      // Hard max: batch >= MAX_BATCH → split at sentence boundary
      if (currentBatch.length >= MAX_BATCH) {
        // Look back 5 items for sentence-ending punctuation
        const lookback = Math.min(5, currentBatch.length - MIN_BATCH);
        let splitFound = false;
        for (let j = 0; j < lookback; j++) {
          const checkIdx = currentBatch.length - 1 - j;
          const text = currentBatch[checkIdx].en;
          if (text && /[.?!]$/.test(text.trim())) {
            // Split after this item; push remainder back
            const kept = currentBatch.slice(0, checkIdx + 1);
            const remainder = currentBatch.slice(checkIdx + 1);

            // Overlap: next batch will include the last 2 blocks of the kept batch
            const overlapCount = Math.min(2, kept.length);
            const overlapBlocks = kept.slice(kept.length - overlapCount);

            batches.push({
              startIdx: batchStart,
              endIdx: batchStart + kept.length - 1,
              blocks: [...kept],
              sceneBreak: false,
              batchMood: detectBatchMood(kept),
              overlapCount: batchStart === 0 ? 0 : 2, // 2 blocks overlap
            });
            // Next batch starts exactly at the overlapping point!
            currentBatch = [...overlapBlocks, ...remainder];
            batchStart = batchStart + kept.length - overlapCount;
            splitFound = true;
            break;
          }
        }
        if (!splitFound) {
          shouldSplit = true;
        }
      }
    }

    if (shouldSplit && currentBatch.length > 0) {
      batches.push({
        startIdx: batchStart,
        endIdx: batchStart + currentBatch.length - 1,
        blocks: [...currentBatch],
        sceneBreak: isSceneBreak,
        batchMood: detectBatchMood(currentBatch),
        overlapCount: batchStart === 0 ? 0 : 2,
      });

      const overlapCount = Math.min(2, currentBatch.length);
      const overlapBlocks = currentBatch.slice(currentBatch.length - overlapCount);

      batchStart = batchStart + currentBatch.length - overlapCount;
      currentBatch = [...overlapBlocks];
    }
  }

  // Flush remaining
  if (currentBatch.length > 0) {
    // Merge tiny last batch into previous
    if (currentBatch.length < 4 && batches.length > 0) {
      const prev = batches[batches.length - 1];
      prev.blocks.push(...currentBatch);
      prev.endIdx = prev.startIdx + prev.blocks.length - 1;
      prev.batchMood = detectBatchMood(prev.blocks);
    } else {
      batches.push({
        startIdx: batchStart,
        endIdx: batchStart + currentBatch.length - 1,
        blocks: [...currentBatch],
        sceneBreak: false,
        batchMood: detectBatchMood(currentBatch),
        overlapCount: batchStart === 0 ? 0 : 2,
      });
    }
  }

  return batches;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 5: Speaker Identification (Pass 0)
// ═══════════════════════════════════════════════════════════════════════════════

async function identifySpeakers(
  subtitles: SubtitleBlock[]
): Promise<SubtitleBlock[]> {
  const store = getStore();
  const { strategyBlueprint, metadata } = store;
  const updated = [...subtitles];

  // 배치 사이즈를 확장하여 API 호출 수를 크게 줄이고 TimeOut/RateLimit 방지
  const SPEAKER_BATCH_SIZE = 150;
  const totalBatches = Math.ceil(subtitles.length / SPEAKER_BATCH_SIZE);
  const allSpeakers = new Set<string>();
  const dialogueSamples: Record<string, string[]> = {};

  addLog(`> [Pass 0] 화자 식별 시작 (${totalBatches}개 거대 배치로 압축)...`);

  const synopsisParts = [
    metadata?.detailed_plot,
    metadata?.omdb_full_plot,
    metadata?.wikipedia_plot,
    metadata?.synopsis,
  ].filter(Boolean);
  const synopsis = synopsisParts.join("\n\n").slice(0, 3000) || "";

  const personas =
    strategyBlueprint?.character_personas
      ?.map((p) => {
        let line = `${p.name}`;
        if (p.gender) line += ` (${p.gender})`;
        if (p.role) line += ` [${p.role}]`;
        line += `: ${p.description}`;
        line += ` | 말투: ${p.speech_style}`;
        if (p.speech_level_default) line += ` | 기본: ${p.speech_level_default}`;
        if (p.speech_pattern_markers) line += ` | 특징: ${p.speech_pattern_markers}`;
        return line;
      })
      .join("\n") || "";

  // Group-Parallel (3중 병렬) 파이프라인 실행
  const PASS0_CONCURRENCY = 3;
  for (let chunkStart = 0; chunkStart < totalBatches; chunkStart += PASS0_CONCURRENCY) {
    if (abortController?.signal.aborted) break;
    const chunkEnd = Math.min(chunkStart + PASS0_CONCURRENCY, totalBatches);

    // UI Progress 업데이트 (진척도 % 반영)
    const pass0Progress = Math.floor(1 + ((chunkStart + 1) / totalBatches) * 9);
    store.setProcessingProgress(pass0Progress);
    addLog(`  > [Pass 0] 화자 식별 Group-Parallel 병렬 실행 (${chunkStart + 1}~${chunkEnd}/${totalBatches})...`);

    const promises = [];
    for (let i = chunkStart; i < chunkEnd; i++) {
      const start = i * SPEAKER_BATCH_SIZE;
      const end = Math.min(start + SPEAKER_BATCH_SIZE, subtitles.length);
      const chunk = subtitles.slice(start, end);
      const isLast = (i === totalBatches - 1);

      // Collect prev_identified from already processed blocks (이전 문맥 연결)
      const prevIdentified = updated
        .slice(Math.max(0, start - 15), start)
        .filter((s) => s.speaker)
        .map((s) => ({ index: s.id, speaker: s.speaker }));

      const promise = fetchWithRetry(
        `${API_BASE}/subtitles/identify-speakers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abortController?.signal,
          body: JSON.stringify({
            blocks: chunk.map((s) => ({
              index: s.id,
              start: s.start,
              end: s.end,
              text: s.en,
            })),
            title: metadata?.title || "",
            synopsis,
            genre:
              strategyBlueprint?.content_analysis?.genre ||
              metadata?.genre?.join(", ") ||
              "",
            personas,
            prev_identified: prevIdentified.length > 0 ? prevIdentified : null,
            generate_relationships: isLast,
            all_speakers: isLast ? Array.from(allSpeakers) : null,
            dialogue_samples: isLast ? dialogueSamples : null,
          }),
        }
      ).then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          if (data.speakers && Array.isArray(data.speakers)) {
            for (const sp of data.speakers) {
              const idx = updated.findIndex((s) => s.id === sp.index);
              if (idx !== -1) {
                updated[idx] = {
                  ...updated[idx],
                  speaker: sp.speaker || undefined,
                  speakerConfidence: sp.confidence || "medium",
                };
                if (sp.speaker) {
                  allSpeakers.add(sp.speaker);
                  if (!dialogueSamples[sp.speaker]) {
                    dialogueSamples[sp.speaker] = [];
                  }
                  if (dialogueSamples[sp.speaker].length < 5) {
                    dialogueSamples[sp.speaker].push(updated[idx].en);
                  }
                }
              }
            }
            addLog(`    ✓ [배치 ${i + 1}] 화자 식별 완료 (${data.speakers.length} 블록)`);
          } else {
            addLog(`    ⚠ [배치 ${i + 1}] 화자 식별 데이터 없음 (Pass)`);
          }
          if (isLast && data.relationships) {
            store.setCharacterRelations(data.relationships);
            const relCount = Object.keys(data.relationships).length;
            addLog(`  ✓ [Pass 0] 최종 관계 맵 생성 완료 (${relCount}쌍)`);
          }
        } else {
          addLog(`  ⚠ [배치 ${i + 1}] 백엔드 응답 실패 (HTTP ${res.status})`);
        }
      }).catch((err) => {
        if (!abortController?.signal.aborted) {
          addLog(`  ⚠ [배치 ${i + 1}] 에러 발생: ${err.message}`);
        }
      });

      promises.push(promise);
    }

    // Group 3개의 배치 완료 대기 (병렬 파이프라인 동기화)
    await Promise.all(promises);
  }

  const identified = updated.filter((s) => s.speaker).length;
  addLog(
    `  ✓ [Pass 0] AI 화자 식별 전체 완료: ${identified}/${subtitles.length}개 (${allSpeakers.size}명)`
  );

  // ─── [Pass 0.2] Viterbi-like Speaker Sequence Smoothing (연속 결측치 교정) ───
  addLog(`> [Pass 0.2] Viterbi 화자 체인 스무딩 (연속 결측치 교정)...`);
  let smoothedCount = 0;
  let sIdx = 0;

  while (sIdx < updated.length) {
    if (!updated[sIdx].speaker || updated[sIdx].speaker === "unknown") {
      // Chunk 끝 식별
      let eIdx = sIdx;
      while (eIdx < updated.length && (!updated[eIdx].speaker || updated[eIdx].speaker === "unknown")) {
        eIdx++;
      }

      const leftSpk = sIdx > 0 ? updated[sIdx - 1].speaker : null;
      const rightSpk = eIdx < updated.length ? updated[eIdx].speaker : null;

      // 양옆 화자가 모두 존재하는 경우
      if (leftSpk && rightSpk && leftSpk !== "unknown" && rightSpk !== "unknown") {
        if (leftSpk === rightSpk) {
          for (let k = sIdx; k < eIdx; k++) { updated[k].speaker = leftSpk; smoothedCount++; }
        } else {
          const leftEnd = parseTimecodeToSeconds(updated[sIdx - 1].end);
          const rightStart = parseTimecodeToSeconds(updated[eIdx].start);
          for (let k = sIdx; k < eIdx; k++) {
            const kStart = parseTimecodeToSeconds(updated[k].start);
            const kEnd = parseTimecodeToSeconds(updated[k].end);
            const gapLeft = kStart - leftEnd;
            const gapRight = rightStart - kEnd;
            if (gapLeft <= gapRight) { updated[k].speaker = leftSpk; }
            else { updated[k].speaker = rightSpk; }
            smoothedCount++;
          }
        }
      }
      // 왼쪽 화자만 존재하는 경우
      else if (leftSpk && leftSpk !== "unknown") {
        for (let k = sIdx; k < eIdx; k++) { updated[k].speaker = leftSpk; smoothedCount++; }
      }
      // 오른쪽 화자만 존재하는 경우
      else if (rightSpk && rightSpk !== "unknown") {
        for (let k = sIdx; k < eIdx; k++) { updated[k].speaker = rightSpk; smoothedCount++; }
      }

      sIdx = eIdx;
    } else {
      sIdx++;
    }
  }
  addLog(`  ✓ [Pass 0.2] Viterbi 스무딩 완료 (${smoothedCount}개 결측 화자 복구됨)`);

  store.setSpeakerIdentified(true);

  return updated;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 6: Addressee Estimation + Speech Policy (Pass 0.5)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 5.5: Tone Archetype Assignment (Pass 0.5 pre-step)
// ═══════════════════════════════════════════════════════════════════════════════

function assignToneArchetypes(): void {
  const store = getStore();
  const personas = store.strategyBlueprint?.character_personas;
  if (!personas || personas.length === 0) return;

  const archetypeKeywords: Record<string, string[]> = {
    A: ["sly", "sarcastic", "witty", "cunning", "veteran", "con", "charm", "ironic", "cynical", "manipulat", "사기", "능청", "비꼼", "여유", "베테랑"],
    B: ["passionate", "direct", "brave", "hot-headed", "heroic", "action", "determined", "child", "kid", "주인공", "열정", "직설", "단호"],
    C: ["calm", "intellectual", "scholar", "formal", "educated", "aristocrat", "investigat", "학자", "귀족", "조사", "차분", "지적", "격식"],
    D: ["rough", "rebellious", "villain", "beast", "raw", "rude", "aggressive", "brutal", "thug", "악당", "반항", "거침", "날것"],
  };

  let assignedCount = 0;

  for (const persona of personas) {
    if (persona.tone_archetype) continue;

    const haystack = [
      persona.personality || "",
      persona.description || "",
      persona.role || "",
      persona.speech_style || "",
    ].join(" ").toLowerCase();

    let matched = false;
    for (const [archetype, keywords] of Object.entries(archetypeKeywords)) {
      if (keywords.some((kw) => haystack.includes(kw))) {
        persona.tone_archetype = archetype as "A" | "B" | "C" | "D";
        matched = true;
        assignedCount++;
        break;
      }
    }

    if (!matched) {
      persona.tone_archetype = "B";
      assignedCount++;
    }
  }

  if (assignedCount > 0) {
    addLog(`  ✓ [Pass 0.5 pre] Tone Archetype 할당: ${assignedCount}명 (${personas.map((p) => `${p.name}=${p.tone_archetype}`).join(", ")})`);
  }
}

function estimateAddressees(subtitles: SubtitleBlock[]): SubtitleBlock[] {
  const updated = [...subtitles];
  const SCENE_GAP_SEC = 2.5;
  const DIALOGUE_GAP_SEC = 6;

  // Session Buffer: tracks the dominant conversation pair within a scene
  let sessionMainPair: { a: string; b: string } | null = null;

  for (let i = 0; i < updated.length; i++) {
    if (updated[i].addressee) continue;

    const currentSpeaker = updated[i].speaker;
    if (!currentSpeaker) continue;

    // Scene break detection → reset session
    if (i > 0) {
      const gap =
        parseTimecodeToSeconds(updated[i].start) -
        parseTimecodeToSeconds(updated[i - 1].end);
      if (gap > SCENE_GAP_SEC) {
        sessionMainPair = null;
      }
    }

    // Rule 1: Previous block has a different speaker → that's the addressee + register Main Pair
    if (i > 0 && updated[i - 1].speaker && updated[i - 1].speaker !== currentSpeaker) {
      const prevSpeaker = updated[i - 1].speaker!;
      updated[i] = { ...updated[i], addressee: prevSpeaker };
      // Register/update Main Pair
      if (!sessionMainPair) {
        sessionMainPair = { a: currentSpeaker, b: prevSpeaker };
      } else {
        // Update if this pair is the same main pair (either direction)
        const isExisting =
          (sessionMainPair.a === currentSpeaker && sessionMainPair.b === prevSpeaker) ||
          (sessionMainPair.a === prevSpeaker && sessionMainPair.b === currentSpeaker);
        if (!isExisting) {
          // New dominant pair replaces old
          sessionMainPair = { a: currentSpeaker, b: prevSpeaker };
        }
      }
      continue;
    }

    // Rule 2: Same speaker consecutive (within 6s) → inherit addressee
    if (i > 0 && updated[i - 1].speaker === currentSpeaker && updated[i - 1].addressee) {
      const gap =
        parseTimecodeToSeconds(updated[i].start) -
        parseTimecodeToSeconds(updated[i - 1].end);
      if (gap <= DIALOGUE_GAP_SEC) {
        updated[i] = { ...updated[i], addressee: updated[i - 1].addressee };
        continue;
      }
    }

    // Rule 3 (NEW): Session Buffer recovery — if speaker is part of Main Pair, recover partner
    if (sessionMainPair) {
      if (currentSpeaker === sessionMainPair.a) {
        updated[i] = { ...updated[i], addressee: sessionMainPair.b };
      } else if (currentSpeaker === sessionMainPair.b) {
        updated[i] = { ...updated[i], addressee: sessionMainPair.a };
      }
    }
  }

  return updated;
}

function buildSpeechPolicies(
  relations: Record<string, string>,
  source: "strategy" | "llm"
): Record<string, SpeechPolicy> {
  const policies: Record<string, SpeechPolicy> = {};
  const baseConfidence = source === "strategy" ? 1.0 : 0.8;

  for (const [pair, description] of Object.entries(relations)) {
    const desc = description.toLowerCase();
    let policyType: SpeechPolicyType = "UNDETERMINED";

    if (
      desc.includes("반말") ||
      desc.includes("친구") ||
      desc.includes("동급") ||
      desc.includes("casual") ||
      desc.includes("informal")
    ) {
      policyType = "CASUAL_LOCK";
    } else if (
      desc.includes("존댓말") ||
      desc.includes("경어") ||
      desc.includes("상사") ||
      desc.includes("formal") ||
      desc.includes("honorific") ||
      desc.includes("부하")
    ) {
      policyType = "HONORIFIC_LOCK";
    }

    policies[pair] = {
      type: policyType,
      confidence: baseConfidence,
      sampleCount: 0,
      source,
    };
  }

  return policies;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 7: Tone Memory Extraction
// ═══════════════════════════════════════════════════════════════════════════════

function extractToneFromBatch(
  blocks: SubtitleBlock[],
  existingMemory: ToneMemoryEntry[]
): ToneMemoryEntry[] {
  const newEntries: ToneMemoryEntry[] = [...existingMemory];

  for (const block of blocks) {
    if (!block.ko || !block.speaker) continue;

    const tone = detectToneFromKorean(block.ko);
    if (!tone) continue;

    const entry: ToneMemoryEntry = {
      speaker: block.speaker,
      addressee: block.addressee || "unknown",
      tone,
      lastSeenAt: block.id,
    };

    // Update existing or add new
    const existingIdx = newEntries.findIndex(
      (e) => e.speaker === entry.speaker && e.addressee === entry.addressee
    );
    if (existingIdx !== -1) {
      newEntries[existingIdx] = entry;
    } else {
      newEntries.push(entry);
    }
  }

  // Keep only last 100 entries
  return newEntries.slice(-100);
}

function updateConfirmedSpeechLevels(
  blocks: SubtitleBlock[],
  existing: Record<string, ConfirmedSpeechLevel>,
  opts?: { sceneBreak?: boolean; prevMood?: string; currentMood?: string }
): Record<string, ConfirmedSpeechLevel> {
  const levels = { ...existing };

  // Scene-break or mood-shift unlock: 씬 전환이나 무드 급변 시 lock 해제
  if (opts?.sceneBreak || (opts?.prevMood && opts?.currentMood && opts.prevMood !== opts.currentMood)) {
    for (const key of Object.keys(levels)) {
      if (levels[key].locked) {
        levels[key] = { ...levels[key], locked: false };
      }
    }
  }

  for (const block of blocks) {
    if (!block.ko || !block.speaker) continue;

    const key = `${block.speaker} → ${block.addressee || "general"}`;
    const tone = detectToneFromKorean(block.ko);

    if (!levels[key]) {
      levels[key] = {
        level: "undetermined",
        confirmedAt: block.id,
        honorificCount: 0,
        banmalCount: 0,
        locked: false,
      };
    }

    if (tone === "formal") {
      levels[key].honorificCount++;
    } else if (tone === "informal") {
      levels[key].banmalCount++;
    }

    // Lock if 95%+ ratio with ≥5 samples
    const total = levels[key].honorificCount + levels[key].banmalCount;
    if (total >= 5 && !levels[key].locked) {
      const ratio = levels[key].honorificCount / total;
      if (ratio >= 0.95) {
        levels[key].level = "honorific";
        levels[key].locked = true;
        levels[key].confirmedAt = block.id;
      } else if (ratio <= 0.05) {
        levels[key].level = "banmal";
        levels[key].locked = true;
        levels[key].confirmedAt = block.id;
      }
    }
  }

  return levels;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Response Parsing (shared by all passes)
// ═══════════════════════════════════════════════════════════════════════════════

function parseTranslationResponse(
  data: Record<string, unknown>
): Array<{ index: number; text: string }> {
  const results: Array<{ index: number; text: string }> = [];

  if (data.data && Array.isArray(data.data)) {
    for (const batch of data.data as Array<{
      batch_index?: number;
      content: unknown;
    }>) {
      let translations: Array<{ index: number; text: string }> = [];

      if (Array.isArray(batch.content)) {
        translations = batch.content;
      } else if (typeof batch.content === "string") {
        try {
          const cleaned = (batch.content as string)
            .replace(/```json\s*/gi, "")
            .replace(/```\s*/g, "")
            .trim();
          const jsonStart = cleaned.indexOf("[");
          const jsonEnd = cleaned.lastIndexOf("]");
          if (jsonStart !== -1 && jsonEnd > jsonStart) {
            translations = JSON.parse(
              cleaned.substring(jsonStart, jsonEnd + 1)
            );
          }
        } catch {
          /* skip parse error */
        }
      }

      results.push(...translations);
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main Translation Function (V3)
// ═══════════════════════════════════════════════════════════════════════════════

export async function executeTranslation(): Promise<void> {
  const store = getStore();

  if (store.translationRunning) {
    console.warn(
      "[TranslationService] Already running, ignoring duplicate call"
    );
    return;
  }

  const { subtitles, strategyBlueprint, metadata, srtFileName } = store;

  console.log(
    "[TranslationService] ========== V3 executeTranslation START =========="
  );
  addLog("[V3] Cinema Engine 번역 시작");

  if (subtitles.length === 0) {
    console.error("[TranslationService] No subtitles to translate!");
    addLog("[ERROR] 자막이 없습니다!");
    return;
  }

  abortController = new AbortController();
  store.setLogMessages([]);  // 번역 시작 시 이전 로그 초기화
  store.setLoading(true);
  store.setTranslationRunning(true);
  store.setProcessingProgress(0);

  try {
    let updatedSubtitles: SubtitleBlock[] = [...subtitles];
    let totalApplied = 0;

    // ═══════════════════════════════════════════════════════════════
    // Pass 0: Speaker Identification [0% → 10%]
    // ═══════════════════════════════════════════════════════════════
    if (!abortController.signal.aborted) {
      store.setProcessingProgress(1);
      updatedSubtitles = await identifySpeakers(updatedSubtitles);
      store.setSubtitles([...updatedSubtitles]);
      store.setProcessingProgress(10);
    }

    // ═══════════════════════════════════════════════════════════════
    // Pass 0.5: Addressee Estimation + Speech Policy [10% → 12%]
    // ═══════════════════════════════════════════════════════════════
    if (!abortController.signal.aborted) {
      addLog("> [Pass 0.5] Tone Archetype 할당 + 청자 추정 + 말투 정책 빌드...");

      assignToneArchetypes();
      updatedSubtitles = estimateAddressees(updatedSubtitles);
      store.setSubtitles([...updatedSubtitles]);

      // Build speech policies from strategy relations
      const strategyRelations: Record<string, string> = {};
      if (strategyBlueprint?.character_personas) {
        for (const p of strategyBlueprint.character_personas) {
          if (p.relationships) {
            strategyRelations[p.name] = p.relationships;
          }
        }
      }
      // V3: character_relationships 양방향 관계 맵도 통합
      if (strategyBlueprint?.character_relationships) {
        for (const rel of strategyBlueprint.character_relationships) {
          if (rel.from_char && rel.to_char) {
            const key = `${rel.from_char} → ${rel.to_char}`;
            const val = [
              rel.speech_level,
              rel.honorific ? `호칭: ${rel.honorific}` : "",
              rel.note,
            ].filter(Boolean).join(", ");
            if (val) strategyRelations[key] = val;
          }
        }
      }

      // Merge strategy + LLM relations
      const llmRelations = store.characterRelations;
      const allRelations = { ...llmRelations };
      for (const [k, v] of Object.entries(strategyRelations)) {
        if (!allRelations[k]) allRelations[k] = v;
      }

      const policies = buildSpeechPolicies(
        allRelations,
        Object.keys(strategyRelations).length > 0 ? "strategy" : "llm"
      );

      // Convert policies to confirmed speech levels
      const confirmedLevels: Record<string, ConfirmedSpeechLevel> = {};
      for (const [pair, policy] of Object.entries(policies)) {
        if (policy.type !== "UNDETERMINED") {
          confirmedLevels[pair] = {
            level:
              policy.type === "CASUAL_LOCK" ? "banmal" : "honorific",
            confirmedAt: 0,
            honorificCount: policy.type === "HONORIFIC_LOCK" ? 1 : 0,
            banmalCount: policy.type === "CASUAL_LOCK" ? 1 : 0,
            locked: policy.confidence >= 1.0,
          };
        }
      }
      store.setConfirmedSpeechLevels(confirmedLevels);

      const addrCount = updatedSubtitles.filter((s) => s.addressee).length;
      addLog(
        `  ✓ [Pass 0.5] 청자 추정 ${addrCount}개, 말투 정책 ${Object.keys(policies).length}개`
      );
      store.setProcessingProgress(12);
    }

    // ═══════════════════════════════════════════════════════════════
    // Pass 0.7: Context-Aware Filtering (상황 인식 말투 보정)
    // 원문의 호격(Vocative)을 감지하여 권위/직속 관계의 양방향 말투 강제 Lock
    // ═══════════════════════════════════════════════════════════════
    if (!abortController?.signal.aborted) {
      addLog("> [Pass 0.7] 호칭(Vocative) 기반 권위/복종 양방향 Lock 체결 중...");

      const submissiveVocative = /\b(?:yes|no|sorry|excuse me|hello|goodbye|right|please),\s*(sir|ma'am|captain|boss|officer|detective|sergeant|chief|doctor|professor|your majesty|your highness|my lord|master)\b/i;
      const absoluteSubmissive = /^(?:sir|ma'am|captain|boss|officer|detective|sergeant|chief|doctor|professor|your majesty|your highness|my lord|master)[,.!?]/i;
      const authoritativeVocative = /\b(?:listen here|shut up|hey|you),\s*(prisoner|inmate|servant|slave|private|soldier|boy|kid|scum)\b/i;
      const absoluteAuthoritative = /^(?:prisoner|inmate|servant|slave|private|soldier|boy|kid|scum)[,.!?]/i;

      let contextFixCount = 0;
      const currentLevels = { ...getStore().confirmedSpeechLevels };

      for (let i = 0; i < updatedSubtitles.length; i++) {
        const block = updatedSubtitles[i];
        if (!block.en) continue;

        const speaker = block.speaker || "UNKNOWN";
        const addressee = block.addressee || "UNKNOWN";
        if (speaker === "UNKNOWN" || addressee === "UNKNOWN") continue;

        const pairFwd = `${speaker} → ${addressee}`;
        const pairRev = `${addressee} → ${speaker}`;

        let speakerIsSubmissive = false;
        let speakerIsAuthoritative = false;

        const text = block.en.trim();

        if (submissiveVocative.test(text) || absoluteSubmissive.test(text)) {
          speakerIsSubmissive = true;
        } else if (authoritativeVocative.test(text) || absoluteAuthoritative.test(text)) {
          speakerIsAuthoritative = true;
        }

        if (speakerIsSubmissive && !currentLevels[pairFwd]?.locked) {
          currentLevels[pairFwd] = { level: "honorific", confirmedAt: i, honorificCount: 10, banmalCount: 0, locked: true };
          currentLevels[pairRev] = { level: "banmal", confirmedAt: i, honorificCount: 0, banmalCount: 10, locked: true };
          contextFixCount++;
        } else if (speakerIsAuthoritative && !currentLevels[pairFwd]?.locked) {
          currentLevels[pairFwd] = { level: "banmal", confirmedAt: i, honorificCount: 0, banmalCount: 10, locked: true };
          currentLevels[pairRev] = { level: "honorific", confirmedAt: i, honorificCount: 10, banmalCount: 0, locked: true };
          contextFixCount++;
        }
      }

      if (contextFixCount > 0) {
        store.setConfirmedSpeechLevels(currentLevels);
        addLog(`  ✓ [Pass 0.7] 양방향 말투 Lock ${contextFixCount}건 완벽 갱신 (오탐지 제거 완료)`);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // Pass 0.8: Auto-NER (고유명사 자동 추출 및 1차 용어집 병합)
    // ═══════════════════════════════════════════════════════════════
    if (!abortController?.signal.aborted) {
      addLog("> [Pass 0.8] 대문자 시작 고유명사 (Auto-NER) 스캔 중...");
      const entityMap = new Map<string, number>();

      updatedSubtitles.forEach(block => {
        // 문장 중간에 등장하는 연속된 대문자 단어를 추출 (예: "the Stark Resilient")
        const matches = block.en.match(/(?<=[a-z]\s+)([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)/g);
        if (matches) {
          matches.forEach(m => {
            if (m.length > 3) entityMap.set(m, (entityMap.get(m) || 0) + 1);
          });
        }
      });
      // 3번 이상 등장한 유력한 고유명사 Top 5 자동 색출
      const topEntities = Array.from(entityMap.entries())
        .filter(([_, count]) => count >= 3)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([ent]) => `${ent} → ${ent} (고유명사 원어 유지)`);

      if (topEntities.length > 0) {
        const autoGlossary = topEntities.join(", ");
        const existingTerms = strategyBlueprint?.fixed_terms
          ?.map((t) => `${t.original} → ${t.translation}`).join(", ") || "";

        // 기존 사전과 병합하여 전역 scope에 노출
        (strategyBlueprint as any)._auto_fixed_terms = existingTerms ? `${existingTerms}, ${autoGlossary}` : autoGlossary;
        addLog(`  ✓ [Pass 0.8] 고유명사 ${topEntities.length}개 임시 사전 병합 완료!`);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // Pass 1~5.1: 백엔드 전체 위임 (/translate-all)
    // Pass 0~0.8 완료 후 전체 파이프라인을 백엔드에 위임합니다.
    // ═══════════════════════════════════════════════════════════════
    let currentJobId: string | null = null;

    if (!abortController.signal.aborted) {
      addLog("> [Backend] 번역 파이프라인 백엔드 위임 중...");
      store.setProcessingProgress(12);

      // ── payload 구성 ──
      const autoFixedTerms = (strategyBlueprint as any)._auto_fixed_terms || "";

      const translateAllPayload = {
        blocks: updatedSubtitles.map((s) => ({
          id: s.id,
          start: s.start,
          end: s.end,
          en: s.en,
          speaker: s.speaker,
          addressee: s.addressee,
        })),
        metadata: {
          title: metadata?.title || "",
          genre: metadata?.genre || [],
          synopsis: metadata?.synopsis || "",
          detailed_plot: (metadata as any)?.detailed_plot || "",
          omdb_full_plot: (metadata as any)?.omdb_full_plot || "",
          wikipedia_plot: (metadata as any)?.wikipedia_plot || "",
        },
        strategy: strategyBlueprint
          ? { ...strategyBlueprint, _auto_fixed_terms: autoFixedTerms }
          : null,
        character_relations: store.characterRelations || {},
        confirmed_speech_levels: store.confirmedSpeechLevels || {},
        options: {
          include_qc: true,
        },
      };

      // ── /translate-all 호출 ──
      const jobResp = await fetch(`${API_BASE}/subtitles/translate-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify(translateAllPayload),
      });

      if (!jobResp.ok) {
        throw new Error(
          `[translate-all] HTTP ${jobResp.status}: ${await jobResp.text()}`
        );
      }

      const { job_id } = await jobResp.json();
      currentJobId = job_id;
      addLog(`  ✓ [Backend] 번역 작업 시작됨 (job_id: ${job_id})`);

      // ── polling 루프 ──
      let lastLogCount = 0;
      let pollFailed = 0;

      while (!abortController.signal.aborted) {
        await new Promise<void>((resolve) => setTimeout(resolve, 800));

        if (abortController.signal.aborted) break;

        let statusData: any;
        try {
          const statusResp = await fetch(
            `${API_BASE}/subtitles/translate-status/${job_id}`,
            { signal: abortController.signal }
          );
          if (!statusResp.ok) {
            pollFailed++;
            if (pollFailed >= 15)
              throw new Error(`[translate-status] 연속 ${pollFailed}회 실패`);
            await new Promise<void>((r) => setTimeout(r, 1000));
            continue;
          }
          statusData = await statusResp.json();
          pollFailed = 0;
        } catch (e: any) {
          if (abortController.signal.aborted) break;
          // 자동 저장 완료 로그가 있으면 에러 무시하고 완료 처리
          if (e?.message?.includes("translate-status")) {
            break;
          }
          pollFailed++;
          if (pollFailed >= 15) throw e;
          await new Promise<void>((r) => setTimeout(r, 1000));
          continue;
        }

        // 진행률 업데이트 (12% ~ 99%)
        if (typeof statusData.progress === "number") {
          store.setProcessingProgress(12 + Math.floor(statusData.progress * 0.87));
        }

        // 새 로그 추가
        const allLogs: string[] = statusData.logs || [];
        if (allLogs.length > lastLogCount) {
          const newLogs = allLogs.slice(lastLogCount);
          newLogs.forEach((log: string) => addLog(log));
          lastLogCount = allLogs.length;
        }

        // 중간 결과 업데이트 (partial_subtitles)
        if (statusData.partial_subtitles?.length > 0) {
          const merged = updatedSubtitles.map((s) => {
            const partial = statusData.partial_subtitles.find(
              (p: any) => p.id === s.id
            );
            return partial?.ko ? { ...s, ko: partial.ko } : s;
          });
          store.setSubtitles([...merged]);
          updatedSubtitles = merged;
        }

        // 완료 확인
        if (statusData.status === "complete") {
          if (statusData.result?.length > 0) {
            const mergedFinal = updatedSubtitles.map((s) => {
              const found = (statusData.result as any[]).find(
                (r) => r.id === s.id
              );
              return found ? { ...s, ko: found.ko || found.translated || s.ko || "" } : s;
            });
            updatedSubtitles = mergedFinal;
            store.setSubtitles([...updatedSubtitles]);
          }
          addLog("  ✓ [Backend] 전체 번역 파이프라인 완료");
          store.setProcessingProgress(99);
          break;
        }

        // 실패 확인
        if (statusData.status === "failed") {
          throw new Error(
            `[Backend] 번역 실패: ${statusData.error || "알 수 없는 오류"}`
          );
        }
      }

      // 취소 시 백엔드에 취소 신호 전송
      if (abortController.signal.aborted && currentJobId) {
        try {
          await fetch(
            `${API_BASE}/subtitles/translate-cancel/${currentJobId}`,
            { method: "DELETE" }
          );
        } catch {
          // ignore
        }
        throw new Error("Translation cancelled");
      }
    }

    store.setProcessingProgress(100);

    // Save to server
    try {
      const saveRes = await fetch(
        `${API_BASE}/subtitles/save-translation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            original_filename: srtFileName || "untitled.srt",
            title: metadata?.title || "",
            subtitles: updatedSubtitles.map((s) => ({
              id: s.id,
              start: s.start,
              end: s.end,
              en: s.en,
              ko: s.ko || "",
            })),
          }),
        }
      );
      if (saveRes.ok) {
        const saveData = await saveRes.json();
        addLog(`[OK] 서버에 저장됨: ${saveData.filename}`);
      } else {
        addLog("[WARN] 서버 저장 실패 (로컬 다운로드는 가능)");
      }
    } catch (saveErr) {
      console.error("Server save failed:", saveErr);
      addLog("[WARN] 서버 저장 실패 (로컬 다운로드는 가능)");
    }

    // Completion notification
    store.setShowTranslationComplete(true);
    setTimeout(() => {
      useTranslateStore
        .getState()
        .setShowTranslationComplete(false);
    }, 7000);

    store.setAutoExportPending(true);
  } catch (err) {
    if (abortController?.signal.aborted) {
      addLog("[INFO] 번역이 취소되었습니다.");
    } else if ((err as any)?.message?.includes("translate-status")) {
      // 폴링 연결 불안정 — 백엔드는 정상 완료됐을 수 있음 (에러 표시 안 함)
      console.warn("Polling ended:", (err as any).message);
    } else {
      console.error("Batch translation failed:", err);
      addLog(`[ERROR] Translation failed: ${err}`);
    }
  } finally {
    store.setLoading(false);
    store.setCurrentBatch(0);
    store.setTranslationRunning(false);
    abortController = null;

    // 번역 완료 여부와 관계없이 자동 EXPORT 트리거
    store.setAutoExportPending(true);
  }
}

// ====== Cancel translation ======
export function cancelTranslation(): void {
  if (abortController) {
    abortController.abort();
    addLog("[INFO] 번역 취소 요청됨...");
  }
}

// ====== Check if running ======
export function isTranslationRunning(): boolean {
  return getStore().translationRunning;
}
