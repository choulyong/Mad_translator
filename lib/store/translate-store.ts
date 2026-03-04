import { create } from "zustand";
import type {
  SubtitleBlock,
  MovieMetadata,
  StrategyBlueprint,
  DiagnosticResult,
  ConfirmedSpeechLevel,
  ToneMemoryEntry,
} from "./translate-types";

interface TranslateStore {
  // ====== Persistent state (survives page navigation) ======
  subtitles: SubtitleBlock[];
  loading: boolean;
  processingProgress: number;
  currentBatch: number;
  totalBatches: number;
  strategyBlueprint: StrategyBlueprint | null;
  strategyLoading: boolean;
  metadata: MovieMetadata | null;
  diagnostic: DiagnosticResult | null;
  logMessages: string[];
  videoUrl: string;
  rawSrtContent: string;
  srtFileName: string;
  videoFileName: string;
  backendConnected: boolean;
  query: string;
  translationRunning: boolean;
  showTranslationComplete: boolean;
  syncOffset: number;
  subtitleMode: "original" | "translated" | "both";
  loadedMovieId: string; // tracks which movieId was already auto-loaded
  movieFilePath: string; // original video file path (for export to same folder)
  autoExportPending: boolean; // flag: auto-export SRT after translation completes

  // V3: 화자 식별 + 말투 정책
  characterRelations: Record<string, string>;
  confirmedSpeechLevels: Record<string, ConfirmedSpeechLevel>;
  speakerIdentified: boolean;
  globalToneMemory: ToneMemoryEntry[];

  // ====== Actions ======
  setSubtitles: (subtitles: SubtitleBlock[]) => void;
  setLoading: (loading: boolean) => void;
  setProcessingProgress: (progress: number) => void;
  setCurrentBatch: (batch: number) => void;
  setTotalBatches: (total: number) => void;
  setStrategyBlueprint: (blueprint: StrategyBlueprint | null) => void;
  setStrategyLoading: (loading: boolean) => void;
  setMetadata: (metadata: MovieMetadata | null) => void;
  setDiagnostic: (diagnostic: DiagnosticResult | null) => void;
  addLog: (message: string) => void;
  setLogMessages: (messages: string[]) => void;
  setVideoUrl: (url: string) => void;
  setRawSrtContent: (content: string) => void;
  setSrtFileName: (name: string) => void;
  setVideoFileName: (name: string) => void;
  setBackendConnected: (connected: boolean) => void;
  setQuery: (query: string) => void;
  setTranslationRunning: (running: boolean) => void;
  setShowTranslationComplete: (show: boolean) => void;
  setSyncOffset: (offset: number) => void;
  setSubtitleMode: (mode: "original" | "translated" | "both") => void;
  setLoadedMovieId: (id: string) => void;
  setMovieFilePath: (path: string) => void;
  setAutoExportPending: (pending: boolean) => void;

  // V3 actions
  setCharacterRelations: (relations: Record<string, string>) => void;
  setConfirmedSpeechLevels: (levels: Record<string, ConfirmedSpeechLevel>) => void;
  setSpeakerIdentified: (identified: boolean) => void;
  setGlobalToneMemory: (memory: ToneMemoryEntry[]) => void;

  // Batch update helpers
  updateSubtitle: (id: number, field: "en" | "ko", value: string) => void;

  // Reset (clear all state)
  reset: () => void;
}

const initialLogMessages = [
  "➜ ~init AURA OS v2.0...",
  "[OK] System ready",
  "> Waiting for input...",
];

export const useTranslateStore = create<TranslateStore>((set) => ({
  subtitles: [],
  loading: false,
  processingProgress: 0,
  currentBatch: 0,
  totalBatches: 0,
  strategyBlueprint: null,
  strategyLoading: false,
  metadata: null,
  diagnostic: null,
  logMessages: [...initialLogMessages],
  videoUrl: "",
  rawSrtContent: "",
  srtFileName: "",
  videoFileName: "",
  backendConnected: false,
  query: "",
  translationRunning: false,
  showTranslationComplete: false,
  syncOffset: 0,
  subtitleMode: "both",
  loadedMovieId: "",
  movieFilePath: "",
  autoExportPending: false,
  characterRelations: {},
  confirmedSpeechLevels: {},
  speakerIdentified: false,
  globalToneMemory: [],

  setSubtitles: (subtitles) => set({ subtitles }),
  setLoading: (loading) => set({ loading }),
  setProcessingProgress: (processingProgress) => set({ processingProgress }),
  setCurrentBatch: (currentBatch) => set({ currentBatch }),
  setTotalBatches: (totalBatches) => set({ totalBatches }),
  setStrategyBlueprint: (strategyBlueprint) => set({ strategyBlueprint }),
  setStrategyLoading: (strategyLoading) => set({ strategyLoading }),
  setMetadata: (metadata) => set({ metadata }),
  setDiagnostic: (diagnostic) => set({ diagnostic }),
  addLog: (message) =>
    set((state) => {
      const newLogs = [...state.logMessages, message];
      return { logMessages: newLogs.length > 50 ? newLogs.slice(-50) : newLogs };
    }),
  setLogMessages: (logMessages) => set({ logMessages }),
  setVideoUrl: (videoUrl) => set({ videoUrl }),
  setRawSrtContent: (rawSrtContent) => set({ rawSrtContent }),
  setSrtFileName: (srtFileName) => set({ srtFileName }),
  setVideoFileName: (videoFileName) => set({ videoFileName }),
  setBackendConnected: (backendConnected) => set({ backendConnected }),
  setQuery: (query) => set({ query }),
  setTranslationRunning: (translationRunning) => set({ translationRunning }),
  setShowTranslationComplete: (showTranslationComplete) =>
    set({ showTranslationComplete }),
  setSyncOffset: (syncOffset) => set({ syncOffset }),
  setSubtitleMode: (subtitleMode) => set({ subtitleMode }),
  setLoadedMovieId: (loadedMovieId) => set({ loadedMovieId }),
  setMovieFilePath: (movieFilePath) => set({ movieFilePath }),
  setAutoExportPending: (autoExportPending) => set({ autoExportPending }),
  setCharacterRelations: (characterRelations) => set({ characterRelations }),
  setConfirmedSpeechLevels: (confirmedSpeechLevels) => set({ confirmedSpeechLevels }),
  setSpeakerIdentified: (speakerIdentified) => set({ speakerIdentified }),
  setGlobalToneMemory: (globalToneMemory) => set({ globalToneMemory }),

  updateSubtitle: (id, field, value) =>
    set((state) => ({
      subtitles: state.subtitles.map((s) =>
        s.id === id ? { ...s, [field]: value } : s
      ),
    })),

  reset: () =>
    set({
      subtitles: [],
      loading: false,
      processingProgress: 0,
      currentBatch: 0,
      totalBatches: 0,
      strategyBlueprint: null,
      strategyLoading: false,
      metadata: null,
      diagnostic: null,
      logMessages: [...initialLogMessages],
      videoUrl: "",
      rawSrtContent: "",
      srtFileName: "",
      videoFileName: "",
      backendConnected: false,
      query: "",
      translationRunning: false,
      showTranslationComplete: false,
      syncOffset: 0,
      subtitleMode: "both",
      loadedMovieId: "",
      movieFilePath: "",
      autoExportPending: false,
      characterRelations: {},
      confirmedSpeechLevels: {},
      speakerIdentified: false,
      globalToneMemory: [],
    }),
}));
