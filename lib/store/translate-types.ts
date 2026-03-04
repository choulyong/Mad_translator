// Shared types for translate page — used by store, service, and page.tsx

export interface SubtitleBlock {
  id: number;
  start: string;
  end: string;
  en: string;
  ko: string;
  // V3: 화자 식별
  speaker?: string;
  speakers?: string[];
  speakerConfidence?: "high" | "medium" | "low";
  addressee?: string;
}

// ═══ V3 시맨틱 배칭 ═══

export interface SemanticBatch {
  startIdx: number;
  endIdx: number;
  blocks: SubtitleBlock[];
  sceneBreak: boolean;
  batchMood?: string;
  overlapCount?: number;
}

// ═══ V3 말투 정책 ═══

export type SpeechPolicyType = "CASUAL_LOCK" | "HONORIFIC_LOCK" | "UNDETERMINED";

export interface SpeechPolicy {
  type: SpeechPolicyType;
  confidence: number;
  sampleCount: number;
  source?: "strategy" | "llm" | "statistical";
}

export interface ConfirmedSpeechLevel {
  level: string;
  confirmedAt: number;
  honorificCount: number;
  banmalCount: number;
  locked: boolean;
}

export interface ToneMemoryEntry {
  speaker: string;
  addressee: string;
  tone: string;
  lastSeenAt: number;
}

export interface MovieMetadata {
  title: string;
  orig_title: string;
  genre: string[];
  runtime: string;
  fps: string;
  quality: string;
  synopsis: string;
  poster_url: string;
  // Extended metadata from OMDB
  year?: string;
  director?: string;
  actors?: string;
  imdb_rating?: string;
  imdb_id?: string;
  // Extended metadata from TMDB
  tmdb_id?: string;
  characters?: Array<{
    actor: string;
    character: string;
    gender?: string;
    order?: number;
  }>;
  keywords?: string[];
  tagline?: string;
  original_language?: string;
  production_countries?: string[];
  // OMDB extended
  rated?: string;
  awards?: string;
  rotten_tomatoes?: string;
  metacritic?: string;
  box_office?: string;
  writer?: string;
  // Wikipedia & OMDB integration
  detailed_plot?: string;
  detailed_plot_ko?: string;
  omdb_full_plot?: string;
  wikipedia_plot?: string;
  wikipedia_overview?: string;
  wikipedia_cast?: string;
  wikipedia_lang?: string;
  has_wikipedia?: boolean;
}

export interface StrategyBlueprint {
  approval_id: string;
  content_analysis: {
    estimated_title: string;
    genre: string;
    mood: string;
    narrative_arc?: string;
    formality_spectrum?: string;
    summary: string;
  };
  character_personas: CharacterPersona[];
  character_relationships?: CharacterRelationshipEntry[];
  data_diagnosis: {
    timecode_status: string;
    technical_noise: string;
  };
  fixed_terms: Array<{
    original: string;
    translation: string;
    note?: string;
  }>;
  translation_rules: string[];
}

export interface CharacterPersona {
  name: string;
  gender?: string;
  role?: string;
  personality?: string;
  description: string;
  speech_style: string;
  speech_level_default?: string;
  speech_pattern_markers?: string;
  relationships?: string;
  tone_archetype?: "A" | "B" | "C" | "D";
}

export interface CharacterRelationshipEntry {
  from_char: string;
  to_char: string;
  relationship_type?: string;
  honorific?: string;
  speech_level?: string;
  note?: string;
}

export interface DiagnosticResult {
  status: string;
  report: string;
  blocks: Array<{
    index: number;
    timecode: string;
    text: string;
  }>;
  stats: {
    total_count: number;
    complexity: number;
  };
}
