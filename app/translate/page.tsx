"use client";
import React, { useState, useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Play, Pause, SkipForward, SkipBack, Settings, Bell,
  FolderOpen, Zap, CheckCircle2, Sliders, ChevronDown,
  Maximize2, Minimize2, Volume2, VolumeX, Save, Wand2, Search, Brain, Terminal,
  Upload, Plus, Activity, FileVideo, FileText, PictureInPicture2,
  Rewind, FastForward, Gauge, Music2, X, Sun, Moon, Sparkles, RotateCcw
} from 'lucide-react';
import { getMovieForTranslation, exportSrtToFile, enrichMovie, resetAndEnrichMovie } from '@/app/actions';
import { useTranslateStore } from '@/lib/store/translate-store';
import { executeTranslation, fetchWithRetry } from '@/lib/services/translation-service';
import type { SubtitleBlock, MovieMetadata, StrategyBlueprint, CharacterPersona, DiagnosticResult } from '@/lib/store/translate-types';
import Hls from 'hls.js';

// ====== FILENAME PARSER ======
// Extract movie title + year from filename
// Example: "Cleaner.2025.BluRAT.1080p.BluRay.x264.AAC5.1.srt" → "Cleaner 2025"
function extractMovieTitle(filename: string): string {
  // Remove file extension
  let name = filename.replace(/\.(srt|mp4|mkv|avi|mov|wmv|flv|webm|m4v|sub|ass)$/i, '');

  // Split by common delimiters (. - _ space)
  const parts = name.split(/[.\-_\s]+/);

  // Find title parts (before quality/codec tags start)
  const stopTags = /^(720p|1080p|2160p|4k|uhd|hd|bluray|bdrip|brrip|dvdrip|webrip|web|webdl|hdtv|hdrip|x264|x265|h264|h265|hevc|avc|xvid|aac|ac3|dts|flac|proper|repack|internal|limited|unrated|extended|directors|theatrical|remux|10bit|hdr|sdr|atmos|truehd)$/i;

  const titleParts: string[] = [];
  let foundYear = '';

  for (const part of parts) {
    // Check if this part is a year (1900-2099)
    if (/^(19|20)\d{2}$/.test(part)) {
      foundYear = part;
      break; // Year typically marks end of title
    }

    // Check if this is a quality/codec tag - stop here
    if (stopTags.test(part)) {
      break;
    }

    // Skip empty or very short parts
    if (part.length >= 2) {
      titleParts.push(part);
    }
  }

  // Build result: Title + Year
  let result = titleParts.join(' ');
  if (foundYear) {
    result += ' ' + foundYear;
  }

  // Capitalize properly
  result = result.replace(/\b\w/g, c => c.toUpperCase());

  return result.trim();
}

// ====== JSON SAFE STRING HELPER ======
// Sanitize text for safe JSON transmission (Wikipedia data contains special chars)
function sanitizeForJson(text: string | undefined | null, maxLength: number = 3000): string {
  if (!text) return "";

  let sanitized = text
    // Remove or replace control characters
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Replace actual newlines and tabs with spaces
    .replace(/[\r\n\t]+/g, ' ')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    // Trim whitespace
    .trim();

  // Limit length to prevent overly large requests
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength) + "...";
  }

  return sanitized;
}

// Types imported from @/lib/store/translate-types

// API_BASE: Next.js rewrite 프록시 (CORS 문제 없음, 어느 도메인에서든 동작)
const getApiBase = () => {
  if (typeof window !== "undefined") {
    return "/api/v1";  // Next.js rewrite → localhost:8033/api/v1
  }
  return process.env.NEXT_PUBLIC_API_BASE || "https://sub.metaldragon.co.kr/api/v1";
};
const API_BASE = getApiBase();

// fetchWithRetry moved to @/lib/services/translation-service.ts

export default function TranslatePageWrapper() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen bg-black text-zinc-500">Loading...</div>}>
      <TranslatePage />
    </Suspense>
  );
}

function TranslatePage() {
  console.log('[TranslatePage] Component rendering, location:', typeof window !== 'undefined' ? window.location.href : 'SSR');

  // ====== GLOBAL STORE (survives page navigation) ======
  const subtitles = useTranslateStore(s => s.subtitles);
  const setSubtitles = useTranslateStore(s => s.setSubtitles);
  const loading = useTranslateStore(s => s.loading);
  const setLoading = useTranslateStore(s => s.setLoading);
  const processingProgress = useTranslateStore(s => s.processingProgress);
  const currentBatch = useTranslateStore(s => s.currentBatch);
  const totalBatches = useTranslateStore(s => s.totalBatches);
  const strategyBlueprint = useTranslateStore(s => s.strategyBlueprint);
  const setStrategyBlueprint = useTranslateStore(s => s.setStrategyBlueprint);
  const strategyLoading = useTranslateStore(s => s.strategyLoading);
  const setStrategyLoading = useTranslateStore(s => s.setStrategyLoading);
  const metadata = useTranslateStore(s => s.metadata);
  const setMetadata = useTranslateStore(s => s.setMetadata);
  const diagnostic = useTranslateStore(s => s.diagnostic);
  const logMessages = useTranslateStore(s => s.logMessages);
  const addLog = useTranslateStore(s => s.addLog);
  const videoUrl = useTranslateStore(s => s.videoUrl);
  const setVideoUrl = useTranslateStore(s => s.setVideoUrl);
  const rawSrtContent = useTranslateStore(s => s.rawSrtContent);
  const setRawSrtContent = useTranslateStore(s => s.setRawSrtContent);
  const srtFileName = useTranslateStore(s => s.srtFileName);
  const setSrtFileName = useTranslateStore(s => s.setSrtFileName);
  const videoFileName = useTranslateStore(s => s.videoFileName);
  const setVideoFileName = useTranslateStore(s => s.setVideoFileName);
  const backendConnected = useTranslateStore(s => s.backendConnected);
  const setBackendConnected = useTranslateStore(s => s.setBackendConnected);
  const query = useTranslateStore(s => s.query);
  const setQuery = useTranslateStore(s => s.setQuery);
  const showTranslationComplete = useTranslateStore(s => s.showTranslationComplete);
  const setShowTranslationComplete = useTranslateStore(s => s.setShowTranslationComplete);
  const syncOffset = useTranslateStore(s => s.syncOffset);
  const setSyncOffset = useTranslateStore(s => s.setSyncOffset);
  const subtitleMode = useTranslateStore(s => s.subtitleMode);
  const setSubtitleMode = useTranslateStore(s => s.setSubtitleMode);
  const movieFilePath = useTranslateStore(s => s.movieFilePath);
  const setMovieFilePath = useTranslateStore(s => s.setMovieFilePath);
  const autoExportPending = useTranslateStore(s => s.autoExportPending);
  const setAutoExportPending = useTranslateStore(s => s.setAutoExportPending);

  // ====== LOCAL STATE (UI-only, re-initialized on mount) ======
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [currentTime, setCurrentTime] = useState("00:00:00,000");
  const [activeSubtitleId, setActiveSubtitleId] = useState<number | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [srtFile, setSrtFile] = useState<File | null>(null);
  const [showStrategyModal, setShowStrategyModal] = useState(false);
  const [volume, setVolume] = useState(1);
  const hlsRef = useRef<Hls | null>(null);
  const [isHlsMode, setIsHlsMode] = useState(false);

  // ====== HLS.js / VIDEO SRC INTEGRATION ======
  useEffect(() => {
    if (!videoRef.current || !videoUrl) return;

    const video = videoRef.current;

    // URL 객체를 안전하게 활용하여 type=hls 파라미터 확인
    let isHlsUrl = false;
    try {
      // 상대경로(/api/...)인 경우 window.location.origin 활용
      const urlObj = new URL(videoUrl, window.location.origin);
      isHlsUrl = urlObj.searchParams.get('type') === 'hls' || videoUrl.includes('.m3u8');
    } catch {
      isHlsUrl = videoUrl.includes('.m3u8') || videoUrl.includes('type=hls');
    }

    // 기존 HLS 인스턴스 초기화
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    // 1. HLS 스트림인 경우
    if (isHlsUrl) {
      setIsHlsMode(true);
      // HLS.js가 video를 완전히 제어해야 하므로 네이티브 src 제거
      video.removeAttribute('src');
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,   // 파일 재생 — 라이브 모드 비활성화
          fragLoadingTimeOut: 20000,
          manifestLoadingTimeOut: 20000
        });
        hlsRef.current = hls;

        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          console.log('[HLS] Media attached, loading source:', videoUrl);
          hls.loadSource(videoUrl);
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          console.error('[HLS ERROR]', data.type, data.details, data.fatal);
          if (data.fatal) {
            switch (data.type) {
              case Hls.ErrorTypes.NETWORK_ERROR:
                console.log('[HLS] Network error, recovering...');
                hls.startLoad();
                break;
              case Hls.ErrorTypes.MEDIA_ERROR:
                console.log('[HLS] Media error, recovering...');
                hls.recoverMediaError();
                break;
              default:
                console.error('[HLS] Unrecoverable error, destroying.');
                hls.destroy();
                break;
            }
          }
        });

        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // iOS Safari 등 네이티브 HLS 지원 환경
        video.src = videoUrl;
      } else {
        console.error('[HLS] HLS is not supported in this browser.');
      }
    }
    // 2. 일반 재생 (MP4, MKV 등 로컬 파일 또는 HTTP)
    else {
      setIsHlsMode(false);
      video.src = videoUrl;  // HLS destroy 후 src 명시 설정 필요 (JSX 리렌더링 타이밍 의존 불가)
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [videoUrl]);

  // ====== SUBTITLE TABLE VIRTUALIZATION ======
  const VISIBLE_ROWS = 30;
  const [tableScrollTop, setTableScrollTop] = useState(0);
  const ROW_HEIGHT = 60;

  // ====== PERFORMANCE OPTIMIZATION ======
  const lastTimeUpdateRef = useRef<number>(0);
  const videoTimeRef = useRef<number>(0);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);

  // ====== ADVANCED PLAYER CONTROLS ======
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [audioTracks, setAudioTracks] = useState<{ id: number, label: string, language: string }[]>([]);
  const [currentAudioTrack, setCurrentAudioTrack] = useState(0);
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [isPiP, setIsPiP] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastClickTimeRef = useRef<number>(0);

  // ====== SETTINGS & HISTORY ======
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [translationHistory, setTranslationHistory] = useState<{ id: string, title: string, date: string, count: number }[]>([]);
  const [subtitleFontSize, setSubtitleFontSize] = useState(100);
  const [subtitlePosition, setSubtitlePosition] = useState(10);

  // ====== ENRICH STATE ======
  const [enriching, setEnriching] = useState(false);

  // ====== TOAST NOTIFICATION ======
  const [saveToast, setSaveToast] = useState<{ show: boolean; message: string; type: 'success' | 'fallback' }>({ show: false, message: '', type: 'success' });

  // ====== THEME ======
  const [isDarkMode, setIsDarkMode] = useState(true);

  // ====== RIGHT PANEL COLLAPSE ======
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);

  // ====== MOBILE TAB ======
  const [mobileTab, setMobileTab] = useState<'player' | 'files' | 'log' | 'intel'>('player');

  // ====== LIBRARY AUTO-LOAD ======
  const searchParams = useSearchParams();
  const movieIdParam = searchParams.get('movieId');
  console.log('[TranslatePage] searchParams movieId:', movieIdParam);
  const autoLoadedRef = useRef(false);
  const [autoStrategyTrigger, setAutoStrategyTrigger] = useState(false);

  // ====== RESTORE state from store on mount ======
  useEffect(() => {
    const store = useTranslateStore.getState();

    // Restore File objects from stored filenames
    if (store.srtFileName) {
      setSrtFile(new File([], store.srtFileName, { type: 'application/x-subrip' }));
    }
    if (store.videoFileName) {
      setVideoFile(new File([], store.videoFileName, { type: 'video/mp4' }));
    }

    // Restore active subtitle selection
    if (store.subtitles.length > 0) {
      setActiveSubtitleId(store.subtitles[0].id);
    }

    // If loading was stuck from a previous unmount (not translation running), clear it
    if (store.loading && !store.translationRunning) {
      store.setLoading(false);
    }

    // Re-open strategy modal if strategy was generated but not yet approved
    if (store.strategyBlueprint && !store.translationRunning && store.subtitles.length > 0) {
      const hasTranslation = store.subtitles.some(s => s.ko && s.ko.trim() !== '');
      if (!hasTranslation) {
        setShowStrategyModal(true);
      }
    }

    console.log('[RESTORE] Store state on mount:', {
      subtitles: store.subtitles.length,
      loading: store.loading,
      translationRunning: store.translationRunning,
      srtFileName: store.srtFileName,
      videoUrl: store.videoUrl ? 'set' : 'empty',
      loadedMovieId: store.loadedMovieId,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);

  // Check backend connection on mount
  useEffect(() => {
    let mounted = true;
    let retryCount = 0;
    let consecutiveFailures = 0;  // 연속 실패 카운트
    const MAX_CONSECUTIVE_FAILURES = 3;  // 3회 연속 실패 시에만 오프라인

    const checkBackend = async (isInitial = false) => {
      if (!mounted) return;

      const healthUrl = `${API_BASE}/health`;

      try {
        const controller = new AbortController();
        // 타임아웃 15초로 증가 (Gemini API 호출 중에도 여유 확보)
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const res = await fetch(healthUrl, {
          signal: controller.signal,
          cache: 'no-store'
        });
        clearTimeout(timeoutId);

        if (!mounted) return;
        if (res.ok) {
          // 성공 시 연속 실패 카운트 리셋
          consecutiveFailures = 0;
          setBackendConnected(true);
          if (isInitial || retryCount > 0) {
            addLog('[OK] Backend connected');
          }
          retryCount = 0;
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        if (!mounted) return;

        // 초기 연결 시 재시도 (최대 3회)
        if (isInitial && retryCount < 3) {
          retryCount++;
          setTimeout(() => checkBackend(true), 1000);
          return;
        }

        // 연속 실패 카운트 증가
        consecutiveFailures++;

        // 3회 연속 실패 시에만 오프라인으로 표시
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          setBackendConnected(false);
          console.log(`[Health] Backend offline after ${consecutiveFailures} consecutive failures`);
        } else {
          // 아직 오프라인으로 표시하지 않음 - 재시도 대기
          console.log(`[Health] Check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}), retrying...`);
        }
      }
    };

    // 초기 연결 확인 (약간의 지연 후)
    setTimeout(() => checkBackend(true), 500);

    // 45초마다 재확인 (번역 중 부하 감소)
    const interval = setInterval(() => checkBackend(false), 45000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Fullscreen state tracking
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFS = document.fullscreenElement !== null;
      console.log('[FULLSCREEN] State changed:', isFS, 'Element:', document.fullscreenElement);
      setIsFullscreen(isFS);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // ====== KEYBOARD SHORTCUTS ======
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      const video = videoRef.current;
      if (!video) return;

      switch (e.key) {
        case ' ': // Space - Play/Pause
          e.preventDefault();
          isPlaying ? video.pause() : video.play();
          break;
        case 'ArrowLeft': // ← 10초 뒤로
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 10);
          break;
        case 'ArrowRight': // → 10초 앞으로
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
          break;
        case 'ArrowUp': // ↑ 30초 앞으로
          e.preventDefault();
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 30);
          break;
        case 'ArrowDown': // ↓ 30초 뒤로
          e.preventDefault();
          video.currentTime = Math.max(0, video.currentTime - 30);
          break;
        case 'f': // F - 전체화면 토글
        case 'F':
          e.preventDefault();
          if (document.fullscreenElement) {
            document.exitFullscreen();
          } else {
            videoContainerRef.current?.requestFullscreen();
          }
          break;
        case 'm': // M - 음소거 토글
        case 'M':
          e.preventDefault();
          const newVol = volume > 0 ? 0 : 1;
          setVolume(newVol);
          video.volume = newVol;
          break;
        case 'p': // P - PiP 토글
        case 'P':
          e.preventDefault();
          togglePiP();
          break;
        case ',': // < 속도 감소
          e.preventDefault();
          changeSpeed(-0.25);
          break;
        case '.': // > 속도 증가
          e.preventDefault();
          changeSpeed(0.25);
          break;
        case 'Escape':
          setShowContextMenu(false);
          setShowSpeedMenu(false);
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isPlaying, volume]);

  // ====== PLAYER CONTROL FUNCTIONS ======
  const changeSpeed = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    const newSpeed = Math.max(0.25, Math.min(2, playbackSpeed + delta));
    setPlaybackSpeed(newSpeed);
    video.playbackRate = newSpeed;
  }, [playbackSpeed]);

  const setSpeed = useCallback((speed: number) => {
    const video = videoRef.current;
    if (!video) return;
    setPlaybackSpeed(speed);
    video.playbackRate = speed;
    setShowSpeedMenu(false);
  }, []);

  const togglePiP = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPiP(false);
      } else if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
        setIsPiP(true);
      }
    } catch (err) {
      console.error('PiP error:', err);
    }
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      videoContainerRef.current?.requestFullscreen();
    }
  }, []);

  const skipTime = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
  }, []);

  // ====== AUDIO TRACK DETECTION ======
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const detectAudioTracks = () => {
      // HTMLMediaElement.audioTracks is not widely supported
      // But we can try to detect it
      const audioTrackList = (video as any).audioTracks;
      if (audioTrackList && audioTrackList.length > 0) {
        const tracks: { id: number, label: string, language: string }[] = [];
        for (let i = 0; i < audioTrackList.length; i++) {
          const track = audioTrackList[i];
          tracks.push({
            id: i,
            label: track.label || `Track ${i + 1}`,
            language: track.language || 'Unknown'
          });
        }
        setAudioTracks(tracks);
        addLog(`> Audio tracks detected: ${tracks.length}`);
      }
    };

    video.addEventListener('loadedmetadata', detectAudioTracks);
    return () => video.removeEventListener('loadedmetadata', detectAudioTracks);
  }, []);

  // ====== CONTROLS AUTO-HIDE (Netflix/Standard Player Style) ======
  const resetControlsTimeout = useCallback(() => {
    // 클릭 직후 300ms 이내면 마우스 이동 무시 (토글 보호)
    if (Date.now() - lastClickTimeRef.current < 300) {
      return;
    }
    setShowControls(true);
    // 커서 다시 표시
    if (videoContainerRef.current) {
      videoContainerRef.current.style.cursor = 'default';
    }
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    // 비디오가 로드된 경우 항상 3초 타이머 작동 (전체화면/일반 모두)
    if (videoUrl) {
      controlsTimeoutRef.current = setTimeout(() => {
        if (isPlaying) {
          setShowControls(false);
          // 커서도 숨기기
          if (videoContainerRef.current) {
            videoContainerRef.current.style.cursor = 'none';
          }
        }
      }, 3000);
    }
  }, [isPlaying, videoUrl]);

  // 비디오 클릭: play/pause 토글 + 전체화면 컨트롤 처리
  const handleVideoClick = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    // play/pause 토글
    if (isPlaying) {
      video.pause();
    } else {
      video.play().catch(console.warn);
    }

    if (isFullscreen) {
      lastClickTimeRef.current = Date.now();
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
      }
      setShowControls(false);
      if (videoContainerRef.current) {
        videoContainerRef.current.style.cursor = 'none';
      }
    } else {
      resetControlsTimeout();
    }
  }, [isFullscreen, isPlaying, resetControlsTimeout]);

  // ====== CONTEXT MENU (RIGHT-CLICK) ======
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);

  const selectAudioTrack = useCallback((trackId: number) => {
    const video = videoRef.current;
    if (!video) return;
    const audioTrackList = (video as any).audioTracks;
    if (audioTrackList) {
      for (let i = 0; i < audioTrackList.length; i++) {
        audioTrackList[i].enabled = (i === trackId);
      }
      setCurrentAudioTrack(trackId);
      addLog(`> Audio track changed: ${audioTracks[trackId]?.label || trackId}`);
    }
    setShowContextMenu(false);
  }, [audioTracks]);

  // ====== TRANSLATION HISTORY ======
  const loadTranslationHistory = useCallback(async (retryCount = 0) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5초 타임아웃

      const res = await fetch(`${API_BASE}/subtitles/translations`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        // 백엔드 응답: { translations: [...], count: n }
        const files = (data.translations || []).map((f: any) => ({
          id: f.filename,
          title: f.filename.replace(/_ko_\d{8}_\d{6}\.srt$/, '').replace(/_/g, ' '),
          date: f.modified ? new Date(f.modified).toLocaleString('ko-KR') : '',
          count: Math.round(f.size / 100) // 대략적인 자막 수 추정
        }));
        setTranslationHistory(files);
      }
    } catch (err) {
      // 초기 로딩 시 백엔드 연결 대기 (최대 2회 재시도)
      if (retryCount < 2) {
        setTimeout(() => loadTranslationHistory(retryCount + 1), 1000);
      } else {
        console.warn('[History] Backend not available, will retry on user action');
      }
    }
  }, []);

  const deleteTranslation = useCallback(async (filename: string) => {
    try {
      const res = await fetch(`${API_BASE}/subtitles/translations/${filename}`, { method: 'DELETE' });
      if (res.ok) {
        addLog(`> 삭제됨: ${filename}`);
        loadTranslationHistory();
      }
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  }, [loadTranslationHistory]);

  const downloadTranslation = useCallback((filename: string) => {
    window.open(`${API_BASE}/subtitles/translations/${filename}`, '_blank');
  }, []);

  // Load history on mount
  useEffect(() => {
    loadTranslationHistory();
  }, [loadTranslationHistory]);

  // Helper: Convert SRT timecode to seconds (memoized outside render)
  const timecodeToSeconds = useCallback((timecode: string): number => {
    const parts = timecode.split(/[:,]/);
    if (parts.length === 4) {
      const hours = parseInt(parts[0], 10);
      const minutes = parseInt(parts[1], 10);
      const seconds = parseInt(parts[2], 10);
      const ms = parseInt(parts[3], 10);
      return hours * 3600 + minutes * 60 + seconds + ms / 1000;
    }
    return 0;
  }, []);

  // ====== PRE-COMPUTED SUBTITLE INDEX ======
  // Convert timecodes to seconds ONCE when subtitles change (not every frame!)
  // Also apply syncOffset for global sync adjustment
  const processedSubtitles = useMemo(() => {
    const offsetSec = syncOffset / 1000; // Convert ms to seconds
    return subtitles.map(s => ({
      ...s,
      startSec: timecodeToSeconds(s.start) + offsetSec,
      endSec: timecodeToSeconds(s.end) + offsetSec,
    }));
  }, [subtitles, timecodeToSeconds, syncOffset]);

  // O(1) lookup map by ID
  const subtitleMap = useMemo(() => {
    return new Map(processedSubtitles.map(s => [s.id, s]));
  }, [processedSubtitles]);

  // Binary search for O(log n) time-based lookup
  const findSubtitleAtTime = useCallback((time: number) => {
    // Linear search fallback (subtitles might not be perfectly sorted)
    // Still fast because we're not parsing timecodes anymore
    return processedSubtitles.find(s => time >= s.startSec && time <= s.endSec) || null;
  }, [processedSubtitles]);

  // Memoized active subtitle (O(1) lookup instead of O(n) find in JSX)
  const activeSubtitle = useMemo(() => {
    if (activeSubtitleId === null) return null;
    return subtitleMap.get(activeSubtitleId) || null;
  }, [activeSubtitleId, subtitleMap]);

  // ====== MEMOIZED WAVEFORM BARS ======
  // Pre-compute waveform bars ONCE (not every render)
  const waveformBars = useMemo(() => {
    return Array.from({ length: 150 }, (_, i) => {
      const height = Math.round(20 + Math.abs(Math.sin(i * 0.3) * 60) + Math.abs(Math.sin(i * 0.7) * 20));
      const isActive = i > 60 && i < 80;
      return (
        <div
          key={i}
          className="transition-all duration-100"
          style={{
            height: `${height}%`,
            width: 3,
            backgroundColor: isActive ? '#137fec' : '#4b5563',
            borderRadius: 1,
            opacity: isActive ? 1 : 0.6
          }}
        />
      );
    });
  }, []); // Empty deps = computed once on mount

  // addLog is now from useTranslateStore

  // ====== MEMOIZED TRANSLATED COUNT ======
  // Cached O(n) filter - only recalculates when subtitles change
  const translatedCount = useMemo(() => {
    return subtitles.filter(s => s.ko).length;
  }, [subtitles]);

  // ====== VIRTUALIZED SUBTITLE LIST ======
  // Calculate which rows to render based on scroll position
  const visibleSubtitles = useMemo(() => {
    const startIdx = Math.max(0, Math.floor(tableScrollTop / ROW_HEIGHT) - 5);
    const endIdx = Math.min(subtitles.length, startIdx + VISIBLE_ROWS + 10);
    return {
      items: subtitles.slice(startIdx, endIdx),
      startIdx,
      totalHeight: subtitles.length * ROW_HEIGHT,
      offsetY: startIdx * ROW_HEIGHT
    };
  }, [subtitles, tableScrollTop]);

  // Memoized subtitle row click handler
  const handleSubtitleClick = useCallback((id: number) => {
    setActiveSubtitleId(id);
  }, []);

  // ====== AUTO METADATA SEARCH ======
  // Automatically search for movie metadata by title
  const searchMetadataByTitle = useCallback(async (title: string) => {
    if (!title || !backendConnected) return;

    addLog(`> Auto-searching metadata for "${title}"...`);
    setQuery(title); // Update search bar

    try {
      const res = await fetch(`${API_BASE}/metadata/search?title=${encodeURIComponent(title)}`);
      const data = await res.json();

      if (data && !data.error) {
        setMetadata(data);
        addLog(`[OK] Metadata loaded: ${data.title}`);
        if (data.director) addLog(`   Director: ${data.director}`);
        if (data.actors) addLog(`   Cast: ${data.actors.slice(0, 50)}...`);
        if (data.year) addLog(`   Year: ${data.year}`);
      } else {
        addLog(`[WARN] No metadata found for "${title}"`);
      }
    } catch (err) {
      console.error("Auto-search failed:", err);
      addLog(`[WARN] Auto-search failed, manual search available`);
    }
  }, [backendConnected, addLog]);

  // Search movie metadata (manual - on Enter key)
  const handleSearch = async (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && query) {
      setLoading(true);
      addLog(`> Searching metadata for "${query}"...`);
      try {
        const res = await fetch(`${API_BASE}/metadata/search?title=${encodeURIComponent(query)}`);
        const data = await res.json();
        setMetadata(data);
        addLog(`[OK] Metadata loaded: ${data.title}`);
        if (data.director) addLog(`   Director: ${data.director}`);
        if (data.actors) addLog(`   Cast: ${data.actors}`);
      } catch (err) {
        console.error("Search failed");
        addLog(`[ERROR] Metadata search failed`);
      }
      setLoading(false);
    }
  };

  // ====== FRONTEND SRT PARSER ======
  // Parse SRT file directly in browser (no API call needed)
  const parseSrtContent = (content: string): SubtitleBlock[] => {
    const blocks: SubtitleBlock[] = [];
    const parts = content.trim().split(/\n\s*\n/);

    for (const part of parts) {
      const lines = part.trim().split('\n');
      if (lines.length < 2) continue;

      // First line: index
      const index = parseInt(lines[0], 10);
      if (isNaN(index)) continue;

      // Second line: timecode
      const timecodeMatch = lines[1].match(/(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})/);
      if (!timecodeMatch) continue;

      // Remaining lines: text
      const text = lines.slice(2).join('\n').trim();

      blocks.push({
        id: index,
        start: timecodeMatch[1],
        end: timecodeMatch[2],
        en: text,
        ko: "",
      });
    }

    return blocks;
  };

  // Handle SRT file upload - Parse locally, search metadata from filename
  const handleSrtUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSrtFile(file);
    setSrtFileName(file.name);
    addLog(`> Loading SRT file: ${file.name}`);

    try {
      setLoading(true);

      // Read file content directly in browser
      const content = await file.text();
      setRawSrtContent(content); // Store for later analysis

      // Parse SRT locally (instant, no API call)
      const newSubtitles = parseSrtContent(content);

      if (newSubtitles.length > 0) {
        setSubtitles(newSubtitles);
        setActiveSubtitleId(newSubtitles[0].id);
        addLog(`[OK] SRT loaded: ${newSubtitles.length} subtitle blocks`);
      } else {
        addLog('[WARN] No valid subtitle blocks found in file');
      }

      // ====== EXTRACT TITLE FROM FILENAME (no auto-search) ======
      const movieTitle = extractMovieTitle(file.name);
      if (movieTitle && movieTitle.length > 2) {
        setQuery(movieTitle); // 검색창에 표시만 (자동 검색 안 함)
        addLog(`> 파일명에서 추출한 제목: "${movieTitle}" (검색창에서 Enter로 검색)`);
      }

    } catch (err) {
      console.error("SRT upload failed:", err);
      addLog(`[ERROR] Failed to read SRT file`);
    } finally {
      setLoading(false);
    }
  };

  // Handle video file selection
  const handleVideoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 파일 확장자 확인
    const ext = file.name.split('.').pop()?.toLowerCase();

    // MKV 경고: 오디오 코덱 호환성 문제
    if (ext === 'mkv') {
      addLog(`[WARN] MKV 파일은 오디오가 재생되지 않을 수 있습니다.`);
      addLog(`[INFO] MP4로 변환 권장: ffmpeg -i input.mkv -c:v copy -c:a aac output.mp4`);
    }

    setVideoFile(file);
    setVideoFileName(file.name);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    addLog(`> Video loaded: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`);

    // ====== EXTRACT TITLE FROM VIDEO FILENAME (no auto-search) ======
    const movieTitle = extractMovieTitle(file.name);
    if (movieTitle && movieTitle.length > 2) {
      setQuery(movieTitle); // 검색창에 표시만 (자동 검색 안 함)
      addLog(`> 파일명에서 추출한 제목: "${movieTitle}" (검색창에서 Enter로 검색)`);
    }
  };

  // Handle subtitle text edit - uses store's updateSubtitle
  const updateSubtitle = useTranslateStore(s => s.updateSubtitle);
  const handleSubtitleEdit = useCallback((id: number, field: 'en' | 'ko', value: string) => {
    updateSubtitle(id, field, value);
  }, [updateSubtitle]);

  // ====== THROTTLED TIME UPDATE (60fps → 10fps) ======
  // This is the KEY performance fix - reduces re-renders by 6x
  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return;

    const time = videoRef.current.currentTime;
    videoTimeRef.current = time; // Always update ref (free, no re-render)

    // Throttle: Only update state every 100ms (10fps instead of 60fps)
    const now = Date.now();
    if (now - lastTimeUpdateRef.current < 100) return;
    lastTimeUpdateRef.current = now;

    // Format time string
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time % 3600) / 60);
    const seconds = Math.floor(time % 60);
    const ms = Math.floor((time % 1) * 1000);
    setCurrentTime(`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms).padStart(3, '0')}`);

    // Auto-sync subtitle highlight using pre-computed index
    if (processedSubtitles.length > 0) {
      const currentSubtitle = findSubtitleAtTime(time);
      if (currentSubtitle) {
        setActiveSubtitleId(currentSubtitle.id);
      } else {
        setActiveSubtitleId(null); // 자막 없는 구간에서는 null로 설정
      }
    }
  }, [processedSubtitles, findSubtitleAtTime]); // activeSubtitleId 제거 - stale closure 방지

  // Reset throttle on seeking start (before timeupdate fires)
  const handleSeeking = useCallback(() => {
    lastTimeUpdateRef.current = 0; // Throttle 리셋
  }, []);

  // Force immediate update on seek complete
  const handleSeeked = useCallback(() => {
    lastTimeUpdateRef.current = 0; // Throttle 리셋
    handleTimeUpdate();
  }, [handleTimeUpdate]);

  // Generate translation strategy blueprint (STEP 1: Before translation)
  const handleGenerateStrategy = async () => {
    if (subtitles.length === 0) {
      addLog('[ERROR] No subtitles loaded. Please upload an SRT file first.');
      return;
    }

    // 메타데이터 확인
    if (!metadata?.title) {
      addLog('[WARN] 영화 메타데이터가 없습니다. 먼저 영화를 검색해주세요.');
      addLog('> 기본 전략으로 생성합니다...');
    } else {
      addLog(`> 영화 정보: ${metadata.title} (${metadata.genre?.join(', ')})`);
    }

    setStrategyLoading(true);
    addLog('> Generating translation strategy blueprint...');

    try {
      // Prepare sample texts for analysis (시작, 중간, 끝에서 골고루)
      const totalSubs = subtitles.length;
      let sampleTexts: string[] = [];

      // 시작 부분 20개
      sampleTexts.push(...subtitles.slice(0, 20).map(s => s.en));

      // 중간 부분 15개 (50개 이상일 때)
      if (totalSubs > 50) {
        const midStart = Math.floor(totalSubs / 2) - 7;
        sampleTexts.push(...subtitles.slice(midStart, midStart + 15).map(s => s.en));
      }

      // 끝 부분 15개 (30개 이상일 때)
      if (totalSubs > 30) {
        sampleTexts.push(...subtitles.slice(-15).map(s => s.en));
      }

      console.log(`[DEBUG] Sending ${sampleTexts.length} subtitle samples for analysis`);

      const requestBody = {
        metadata: {
          title: metadata?.title || "Unknown",
          genre: metadata?.genre || [],
          synopsis: metadata?.synopsis || "",
          director: metadata?.director || "",
          actors: metadata?.actors || "",
          year: metadata?.year || "",
          tmdb_id: metadata?.tmdb_id || "",
          characters: metadata?.characters || [],
          detailed_plot: sanitizeForJson(metadata?.detailed_plot, 6000),
          wikipedia_plot: sanitizeForJson(metadata?.wikipedia_plot, 6000),
          omdb_full_plot: sanitizeForJson(metadata?.omdb_full_plot, 6000),
          has_wikipedia: metadata?.has_wikipedia || false
        },
        diagnostic_stats: {
          total_count: subtitles.length,
          complexity: diagnostic?.stats?.complexity || 0,
          sample_texts: sampleTexts
        },
        subtitle_samples: sampleTexts
      };

      console.log('[DEBUG] Strategy request:', JSON.stringify(requestBody, null, 2));

      const res = await fetch(`${API_BASE}/strategy/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      console.log('[DEBUG] Strategy response status:', res.status);

      if (!res.ok) {
        throw new Error(`Strategy generation failed: ${res.status}`);
      }

      const blueprint: StrategyBlueprint = await res.json();
      console.log('[DEBUG] Strategy blueprint:', blueprint);
      console.log('[DEBUG] Character personas:', blueprint.character_personas);

      setStrategyBlueprint(blueprint);
      setShowStrategyModal(true);
      addLog(`[OK] Strategy blueprint generated (ID: ${blueprint.approval_id})`);
      addLog(`> Awaiting user approval...`);

    } catch (err) {
      console.error('Strategy generation failed:', err);
      addLog(`[ERROR] Strategy generation failed: ${err}`);
    } finally {
      setStrategyLoading(false);
    }
  };

  // ====== LIBRARY AUTO-LOAD: movieId query parameter → auto setup ======
  // 흐름: 자막 로드 → 비디오 연결 → 영화 제목으로 메타데이터 검색 → (사용자가 수동으로 AI 엔진 클릭)
  const loadedMovieId = useTranslateStore(s => s.loadedMovieId);
  const setLoadedMovieId = useTranslateStore(s => s.setLoadedMovieId);
  const storeSubtitles = useTranslateStore(s => s.subtitles);

  useEffect(() => {
    console.log('[AUTO-LOAD] useEffect fired, movieIdParam:', movieIdParam, 'loadedMovieId:', loadedMovieId, 'storeSubtitles:', storeSubtitles.length);

    // movieIdParam이 없으면 기존 상태 유지 (다른 페이지에서 돌아왔을 때)
    if (!movieIdParam) {
      console.log('[AUTO-LOAD] No movieIdParam, keeping existing store state. subtitles:', storeSubtitles.length);
      if (storeSubtitles.length > 0) {
        // 자막이 store에 있으면 사용
        addLog('[AUTO-LOAD] 기존 번역 세션 복원됨');
      }
      return;
    }

    // 이미 로드한 영화면 스킵
    if (loadedMovieId === movieIdParam && autoLoadedRef.current) return;

    // ── 새 영화 감지: 이전 상태 전체 초기화 ──
    if (loadedMovieId && loadedMovieId !== movieIdParam) {
      console.log('[AUTO-LOAD] New movie detected, resetting store. Old:', loadedMovieId, 'New:', movieIdParam);
      const store = useTranslateStore.getState();
      store.reset();
      // 로컬 UI 상태도 초기화
      setSrtFile(null);
      setVideoFile(null);
      setActiveSubtitleId(null);
      setShowStrategyModal(false);
    }
    autoLoadedRef.current = true;

    const loadFromLibrary = async () => {
      console.log('[AUTO-LOAD] loadFromLibrary started');
      addLog(`> 라이브러리에서 영화 로딩 중... (ID: ${movieIdParam})`);
      setLoading(true);
      let parsedSubtitles: SubtitleBlock[] = [];

      try {
        const result = await getMovieForTranslation(movieIdParam);
        if (!result.success || !result.data) {
          addLog(`[ERROR] ${result.error || '영화 데이터를 불러올 수 없습니다'}`);
          setLoading(false);
          return;
        }

        const { movie, srtContent, srtFileName: loadedSrtFileName, srtError } = result.data;

        // 1) SRT 파싱 (실패해도 계속 진행)
        if (srtContent && loadedSrtFileName) {
          setRawSrtContent(srtContent);
          const newSubtitles = parseSrtContent(srtContent);
          parsedSubtitles = newSubtitles;
          if (newSubtitles.length > 0) {
            setSubtitles(newSubtitles);
            setActiveSubtitleId(newSubtitles[0].id);
            // srtFile 상태도 설정 (UI 상태 표시용)
            setSrtFile(new File([srtContent], loadedSrtFileName, { type: 'application/x-subrip' }));
            setSrtFileName(loadedSrtFileName);
            addLog(`[OK] SRT 로드 완료: ${loadedSrtFileName} (${newSubtitles.length}개 블록)`);
          } else {
            addLog('[WARN] SRT 파일에서 유효한 자막 블록을 찾을 수 없습니다');
          }
        } else {
          addLog(`[WARN] 자막 로드 실패: ${srtError || '알 수 없는 오류'}`);
          addLog('> SRT 파일을 수동으로 업로드해주세요.');
        }

        // 2) 원본 파일 경로 저장 (Export 시 같은 폴더에 저장하기 위해)
        if (movie.filePath) {
          setMovieFilePath(movie.filePath);
        }

        // 3) 비디오 스트리밍 연결
        setVideoUrl(`/api/stream/${movieIdParam}`);
        // videoFile 상태도 설정 (UI 상태 표시용 — 가상 File 객체)
        const movieFileNameStr = movie.filePath ? movie.filePath.split(/[\\/]/).pop() || movie.title : movie.title;
        setVideoFile(new File([], movieFileNameStr, { type: 'video/mp4' }));
        setVideoFileName(movieFileNameStr);
        addLog(`[OK] 비디오 스트리밍 연결됨: ${movieFileNameStr}`);

        // 4) 영화 제목을 검색창에 설정
        setQuery(movie.title);
        addLog(`> 영화 제목: "${movie.title}"`);

        setLoading(false);

        // 5) 백엔드 연결 대기 (최대 10초, 타임아웃 후에도 검색 시도)
        console.log('[AUTO-LOAD] waiting for backend...');
        let backendOk = false;
        for (let i = 0; i < 10; i++) {
          try {
            const res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
            if (res.ok) { backendOk = true; break; }
          } catch { /* retry */ }
          await new Promise(r => setTimeout(r, 1000));
        }
        console.log('[AUTO-LOAD] backend check done, ok:', backendOk);
        if (backendOk) {
          setBackendConnected(true);
          addLog('[OK] 백엔드 연결됨');
        } else {
          addLog('[WARN] 백엔드 연결 대기 타임아웃. 검색을 시도합니다...');
        }

        // 5) 영화 제목으로 메타데이터 검색 (백엔드 API 호출)
        console.log('[AUTO-LOAD] starting metadata search for:', movie.title);
        addLog(`> "${movie.title}" 메타데이터 검색 중...`);
        let searchedMeta: MovieMetadata | null = null;
        try {
          const res = await fetch(`${API_BASE}/metadata/search?title=${encodeURIComponent(movie.title)}`);
          const data = await res.json();
          if (data && !data.error) {
            searchedMeta = data;
            setMetadata(data);
            addLog(`[OK] Metadata loaded: ${data.title}`);
            if (data.director) addLog(`   Director: ${data.director}`);
            if (data.actors) addLog(`   Cast: ${String(data.actors).slice(0, 60)}...`);
            if (data.year) addLog(`   Year: ${data.year}`);
          } else {
            addLog(`[WARN] 검색 결과 없음. DB 메타데이터로 대체합니다.`);
          }
        } catch (searchErr) {
          addLog(`[WARN] 메타데이터 검색 실패. DB 메타데이터로 대체합니다.`);
        }

        // 검색 실패 시 DB 메타데이터로 폴백
        let finalMeta = searchedMeta;
        if (!finalMeta) {
          const genres: string[] = movie.genres ? JSON.parse(movie.genres) : [];
          const castList: string[] = movie.cast ? JSON.parse(movie.cast) : [];
          const castProfiles: { name: string; character: string; profilePath: string | null }[] =
            movie.castProfiles ? JSON.parse(movie.castProfiles) : [];
          finalMeta = {
            title: movie.title, orig_title: movie.title, genre: genres,
            runtime: movie.runtime ? `${movie.runtime} min` : "", fps: "", quality: "",
            synopsis: movie.plotFullKo || movie.plotFull || movie.overview || "",
            poster_url: movie.posterPath ? `https://image.tmdb.org/t/p/w500${movie.posterPath}` : "",
            year: movie.releaseDate ? movie.releaseDate.slice(0, 4) : "",
            director: movie.director || "", writer: movie.writer || "",
            actors: castList.join(", "),
            imdb_rating: movie.imdbRating || "", imdb_id: movie.imdbId || "",
            tmdb_id: movie.tmdbId ? String(movie.tmdbId) : "",
            rated: movie.rated || "", awards: movie.awards || "",
            rotten_tomatoes: movie.rottenTomatoes || "", metacritic: movie.metacritic || "",
            box_office: movie.boxOffice || "",
            characters: castProfiles.map((c) => ({ actor: c.name, character: c.character })),
            detailed_plot: movie.plotFull || "",
            detailed_plot_ko: movie.plotFullKo || "",
            omdb_full_plot: movie.plotFull || "",
            wikipedia_plot: movie.wikiSummary || "",
            wikipedia_overview: movie.wikiOverview || "",
            has_wikipedia: !!movie.wikiSummary,
          };
          setMetadata(finalMeta);
          addLog(`[OK] DB Metadata fallback: ${finalMeta.title}`);
        }

        // 6) 자동 데이터 보강 → 보강된 메타데이터로 AI 전략 생성
        console.log('[AUTO-LOAD] starting auto-enrich for movieId:', movieIdParam);
        addLog('> 데이터 자동 보강 중... (OMDB · 줄거리 한글 번역)');
        try {
          const enrichResult = await enrichMovie(movieIdParam);
          if (enrichResult.success) {
            // 보강 후 DB에서 최신 데이터 다시 로드
            const freshData = await getMovieForTranslation(movieIdParam);
            if (freshData.success && freshData.data) {
              const m = freshData.data.movie;
              const genres: string[] = m.genres ? JSON.parse(m.genres) : finalMeta?.genre || [];
              const castList: string[] = m.cast ? JSON.parse(m.cast) : [];
              const castProfiles: { name: string; character: string; profilePath: string | null }[] =
                m.castProfiles ? JSON.parse(m.castProfiles) : [];
              finalMeta = {
                ...(finalMeta || {} as MovieMetadata),
                title: m.title, genre: genres,
                synopsis: m.plotFullKo || m.plotFull || m.overview || finalMeta?.synopsis || "",
                detailed_plot: m.plotFull || finalMeta?.detailed_plot || "",
                detailed_plot_ko: m.plotFullKo || finalMeta?.detailed_plot_ko || "",
                omdb_full_plot: m.plotFull || finalMeta?.omdb_full_plot || "",
                wikipedia_plot: m.wikiSummary || finalMeta?.wikipedia_plot || "",
                wikipedia_overview: m.wikiOverview || finalMeta?.wikipedia_overview || "",
                has_wikipedia: !!m.wikiSummary,
                imdb_rating: m.imdbRating || finalMeta?.imdb_rating || "",
                imdb_id: m.imdbId || finalMeta?.imdb_id || "",
                director: m.director || finalMeta?.director || "",
                writer: m.writer || finalMeta?.writer || "",
                actors: castList.join(", ") || finalMeta?.actors || "",
                characters: castProfiles.map((c) => ({ actor: c.name, character: c.character })),
                year: m.releaseDate ? m.releaseDate.slice(0, 4) : finalMeta?.year || "",
                runtime: m.runtime ? `${m.runtime} min` : finalMeta?.runtime || "",
                rated: m.rated || finalMeta?.rated || "",
                awards: m.awards || finalMeta?.awards || "",
                rotten_tomatoes: m.rottenTomatoes || finalMeta?.rotten_tomatoes || "",
                metacritic: m.metacritic || finalMeta?.metacritic || "",
                box_office: m.boxOffice || finalMeta?.box_office || "",
                poster_url: m.posterPath ? `https://image.tmdb.org/t/p/w500${m.posterPath}` : finalMeta?.poster_url || "",
                orig_title: finalMeta?.orig_title || m.title,
                tmdb_id: m.tmdbId ? String(m.tmdbId) : finalMeta?.tmdb_id || "",
              };
              setMetadata(finalMeta);
              const plotLen = (m.plotFull || '').length;
              addLog(`[OK] 데이터 보강 완료 — 줄거리 ${plotLen}자 / 한글 ${m.plotFullKo ? '✓' : '✗'} / IMDB ${m.imdbRating || '✗'}`);
            }
          } else {
            addLog(`[INFO] ${enrichResult.error || '이미 보강됨'}`);
          }
        } catch (enrichErr) {
          addLog(`[WARN] 데이터 보강 스킵: ${enrichErr}`);
        }

        // 7) 보강된 메타데이터로 AI 전략 자동 생성
        console.log('[AUTO-LOAD] metadata enriched, calling generateStrategyDirect');
        addLog('> 보강 완료. AI 전략 자동 생성 중...');
        if (parsedSubtitles.length > 0 && finalMeta) {
          await generateStrategyDirect(parsedSubtitles, finalMeta);
        } else {
          addLog('[WARN] 자막 또는 메타데이터가 없어 자동 전략 생성을 건너뜁니다.');
          addLog('> "AI 자동 동기화 실행" 버튼을 수동으로 클릭해주세요.');
        }

        // Mark this movieId as loaded in store (prevents re-loading on page re-mount)
        setLoadedMovieId(movieIdParam);

      } catch (err) {
        console.error('Library auto-load failed:', err);
        const errMsg = String(err);

        // Next.js 고질적인 배포 직후 캐시/해시 불일치 (Server Action Error) 자가 치유 시스템
        if (errMsg.includes('UnrecognizedActionError')) {
          addLog(`[WARN] V3 엔진 업데이트 캐시 레이턴시 감지. 즉각적인 클린 새로고침을 진행합니다...`);
          setTimeout(() => {
            if (typeof window !== 'undefined') {
              window.location.reload();
            }
          }, 1500);
          return;
        }

        addLog(`[ERROR] 라이브러리 자동 로드 실패: ${err}`);
        setLoading(false);
        // Still mark as loaded to prevent infinite retry loops
        setLoadedMovieId(movieIdParam);
      }
    };

    // 약간의 지연 후 실행 (컴포넌트 마운트 안정화)
    setTimeout(loadFromLibrary, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movieIdParam]);

  // ====== DIRECT STRATEGY GENERATION (bypass stale closures) ======
  // loadFromLibrary에서 직접 호출 — React state가 아닌 로컬 변수 사용
  const generateStrategyDirect = useCallback(async (
    directSubs: SubtitleBlock[],
    directMeta: MovieMetadata
  ) => {
    if (directSubs.length === 0) {
      addLog('[ERROR] No subtitles loaded.');
      return;
    }

    setStrategyLoading(true);
    addLog(`> 영화 정보: ${directMeta.title} (${directMeta.genre?.join(', ')})`);
    addLog('> Generating translation strategy blueprint...');

    try {
      const totalSubs = directSubs.length;
      const sampleTexts: string[] = [];
      sampleTexts.push(...directSubs.slice(0, 20).map(s => s.en));
      if (totalSubs > 50) {
        const midStart = Math.floor(totalSubs / 2) - 7;
        sampleTexts.push(...directSubs.slice(midStart, midStart + 15).map(s => s.en));
      }
      if (totalSubs > 30) {
        sampleTexts.push(...directSubs.slice(-15).map(s => s.en));
      }

      const requestBody = {
        metadata: {
          title: directMeta.title || "Unknown",
          genre: directMeta.genre || [],
          synopsis: directMeta.synopsis || "",
          director: directMeta.director || "",
          writer: directMeta.writer || "",
          actors: directMeta.actors || "",
          year: directMeta.year || "",
          runtime: directMeta.runtime || "",
          rated: directMeta.rated || "",
          imdb_rating: directMeta.imdb_rating || "",
          imdb_id: directMeta.imdb_id || "",
          tmdb_id: directMeta.tmdb_id || "",
          rotten_tomatoes: directMeta.rotten_tomatoes || "",
          metacritic: directMeta.metacritic || "",
          awards: directMeta.awards || "",
          box_office: directMeta.box_office || "",
          characters: directMeta.characters || [],
          detailed_plot: sanitizeForJson(directMeta.detailed_plot, 6000),
          detailed_plot_ko: sanitizeForJson(directMeta.detailed_plot_ko, 6000),
          wikipedia_plot: sanitizeForJson(directMeta.wikipedia_plot, 6000),
          wikipedia_overview: sanitizeForJson(directMeta.wikipedia_overview, 3000),
          omdb_full_plot: sanitizeForJson(directMeta.omdb_full_plot, 6000),
          has_wikipedia: directMeta.has_wikipedia || false
        },
        diagnostic_stats: {
          total_count: directSubs.length,
          complexity: 0,
          sample_texts: sampleTexts
        },
        subtitle_samples: sampleTexts
      };

      console.log('[AUTO-STRATEGY] Sending strategy request...');
      const res = await fetchWithRetry(`${API_BASE}/strategy/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!res.ok) {
        throw new Error(`Strategy generation failed: ${res.status}`);
      }

      const blueprint: StrategyBlueprint = await res.json();
      setStrategyBlueprint(blueprint);
      setShowStrategyModal(true);
      addLog(`[OK] Strategy blueprint generated (ID: ${blueprint.approval_id})`);
      addLog(`> Awaiting user approval...`);
    } catch (err) {
      console.error('Auto strategy generation failed:', err);
      addLog(`[ERROR] Strategy generation failed: ${err}`);
      addLog('> "AI 자동 동기화 실행" 버튼을 수동으로 클릭해주세요.');
    } finally {
      setStrategyLoading(false);
    }
  }, [addLog]);

  // Handle strategy approval and start translation (STEP 2: After approval)
  const handleApproveAndTranslate = async () => {
    console.log('[DEBUG] handleApproveAndTranslate called, strategyBlueprint:', !!strategyBlueprint);
    if (!strategyBlueprint) {
      console.error('[ERROR] No strategyBlueprint!');
      return;
    }

    setShowStrategyModal(false);
    addLog(`[OK] Strategy approved (ID: ${strategyBlueprint.approval_id})`);
    addLog('> Starting AI batch translation with approved strategy...');

    // Continue with actual translation
    await executeTranslation();
  };

  // executeTranslation is now imported from @/lib/services/translation-service

  // Handle batch translation (Legacy - now redirects to strategy flow)
  const handleBatchTranslate = async () => {
    if (subtitles.length === 0) {
      addLog('[ERROR] No subtitles loaded. Please upload an SRT file first.');
      return;
    }

    // Start with strategy generation instead of direct translation
    await handleGenerateStrategy();
  };

  // ====== 새로시작: 모든 상태 초기화 ======
  const handleNewStart = () => {
    if (subtitles.length > 0 || metadata) {
      if (!window.confirm('현재 작업을 모두 초기화하시겠습니까?\n번역된 내용이 저장되지 않습니다.')) return;
    }
    // Zustand store 전체 초기화
    useTranslateStore.getState().reset();
    // 로컬 UI 상태 초기화
    setSrtFile(null);
    setVideoFile(null);
    setActiveSubtitleId(null);
    setShowStrategyModal(false);
    autoLoadedRef.current = false;
    // URL에서 movieId 제거
    window.history.replaceState({}, '', '/translate');
  };

  // Handle SRT export/save
  const handleExportSrt = async () => {
    if (subtitles.length === 0) {
      addLog('[ERROR] No subtitles to export');
      return;
    }

    // 번역 상태 확인
    const translatedCount = subtitles.filter(s => s.ko && s.ko.trim() !== '').length;
    console.log('[DEBUG] Export - Total:', subtitles.length, 'Translated (ko):', translatedCount);
    console.log('[DEBUG] Export - Sample subtitles:', subtitles.slice(0, 5).map(s => ({ id: s.id, en: s.en?.substring(0, 20), ko: s.ko?.substring(0, 20) })));
    addLog(`> Generating SRT file... (${translatedCount}/${subtitles.length} translated)`);

    // Generate SRT content - 번역이 있으면 번역 사용, 없으면 원문
    const srtContent = subtitles.map(s => {
      const text = (s.ko && s.ko.trim() !== '') ? s.ko : s.en;
      return `${s.id}\n${s.start} --> ${s.end}\n${text}\n`;
    }).join('\n');

    // 파일명: "Title (Year).srt" 형식
    const exportTitle = metadata?.title
      ? (metadata.year ? `${metadata.title} (${metadata.year})` : metadata.title)
      : '';
    const exportFileName = exportTitle ? `${exportTitle}.srt` : 'translated.srt';

    // 영화 파일 경로가 있으면 같은 폴더에 영화 제목으로 저장
    if (movieFilePath && exportTitle) {
      addLog(`> 원본 폴더에 저장 중... (${exportFileName})`);
      const result = await exportSrtToFile(movieFilePath, exportTitle, srtContent);
      if (result.success && result.data) {
        addLog(`[OK] 저장 완료: ${result.data.savedPath}`);
        setSaveToast({ show: true, message: `저장 완료! ${exportFileName}`, type: 'success' });
        setTimeout(() => setSaveToast(prev => ({ ...prev, show: false })), 3000);
        return;
      }
      // 서버 저장 실패 시 브라우저 다운로드로 fallback
      addLog(`[WARN] 폴더 저장 실패: ${result.error} — 브라우저 다운로드로 전환`);
    }

    // Fallback: 브라우저 다운로드
    const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);

    addLog('[OK] SRT file exported (browser download)');
    setSaveToast({ show: true, message: `다운로드 완료! ${exportFileName}`, type: 'fallback' });
    setTimeout(() => setSaveToast(prev => ({ ...prev, show: false })), 3000);
  };

  // ====== AUTO-EXPORT: 번역 완료 후 자동 SRT Export ======
  const translationRunning = useTranslateStore(s => s.translationRunning);
  useEffect(() => {
    if (autoExportPending && !translationRunning && subtitles.length > 0) {
      const translatedCount = subtitles.filter(s => s.ko && s.ko.trim() !== '').length;
      if (translatedCount > 0) {
        addLog('> [AUTO] 번역 완료 — SRT 자동 저장 시작...');
        setAutoExportPending(false);
        // Store에서 최신 상태를 직접 읽어 stale closure 방지
        setTimeout(async () => {
          try {
            const state = useTranslateStore.getState();
            const currentSubs = state.subtitles;
            const currentMeta = state.metadata;
            const currentMoviePath = state.movieFilePath;

            if (currentSubs.length === 0) {
              state.addLog('[AUTO] 자막이 없습니다');
              return;
            }

            const count = currentSubs.filter(s => s.ko && s.ko.trim() !== '').length;
            console.log('[AUTO-EXPORT] Starting:', count, '/', currentSubs.length, 'translated');

            // SRT 생성
            const srtContent = currentSubs.map(s => {
              const text = (s.ko && s.ko.trim() !== '') ? s.ko : s.en;
              return `${s.id}\n${s.start} --> ${s.end}\n${text}\n`;
            }).join('\n');

            // 파일명: "Title (Year).ko.srt"
            const exportTitle = currentMeta?.title
              ? (currentMeta.year ? `${currentMeta.title} (${currentMeta.year})` : currentMeta.title)
              : '';
            const exportFileName = exportTitle ? `${exportTitle}.ko.srt` : 'translated.ko.srt';

            // 원본 폴더에 저장 시도
            if (currentMoviePath && exportTitle) {
              state.addLog(`> [AUTO] 원본 폴더에 저장 중... (${exportFileName})`);
              const result = await exportSrtToFile(currentMoviePath, exportTitle, srtContent);
              if (result.success && result.data) {
                state.addLog(`[OK] 자동 저장 완료: ${result.data.savedPath}`);
                return;
              }
              state.addLog(`[WARN] 폴더 저장 실패 — 브라우저 다운로드로 전환`);
            }

            // Fallback: 브라우저 다운로드
            const blob = new Blob([srtContent], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = exportFileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 100);

            state.addLog(`[OK] 자동 다운로드 완료 (${exportFileName})`);
          } catch (err) {
            console.error('[AUTO-EXPORT] Failed:', err);
            useTranslateStore.getState().addLog(`[ERROR] 자동 저장 실패: ${err}`);
          }
        }, 1000);
      } else {
        setAutoExportPending(false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoExportPending, translationRunning]);

  return (
    <div className={`${isDarkMode ? 'bg-[#101922] text-slate-100' : 'bg-gray-100 text-gray-900'} min-h-screen flex flex-col font-sans selection:bg-primary/30 overflow-hidden transition-colors duration-300`}>

      {/* ✅ 번역 완료 알림 - 성공률 표시 */}
      {showTranslationComplete && (() => {
        const translatedCount = subtitles.filter(s => s.ko && s.ko.trim() !== '').length;
        const successRate = subtitles.length > 0 ? Math.round((translatedCount / subtitles.length) * 100) : 0;
        return (
          <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[200] animate-in fade-in slide-in-from-top-4">
            <div className="bg-gradient-to-r from-green-500 to-emerald-600 backdrop-blur-sm text-white px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-4 border border-green-400/30">
              <div className="bg-white/20 rounded-full p-2 animate-pulse">
                <CheckCircle2 size={28} />
              </div>
              <div>
                <p className="font-bold text-lg">🎉 번역 완료!</p>
                <p className="text-sm opacity-90">{translatedCount}개 자막이 번역되었습니다</p>
                <p className="text-xs opacity-75 mt-1">성공률: {successRate}%</p>
              </div>
              <button
                onClick={() => setShowTranslationComplete(false)}
                className="ml-4 bg-white/20 hover:bg-white/30 rounded-full p-2 transition-colors"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })()}

      {/* ✅ 저장 완료 토스트 알림 */}
      {saveToast.show && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[200] animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className={`${saveToast.type === 'success'
            ? 'bg-gradient-to-r from-green-500 to-emerald-600'
            : 'bg-gradient-to-r from-blue-500 to-cyan-600'
            } backdrop-blur-sm text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border border-white/20`}>
            <CheckCircle2 size={20} />
            <span className="font-medium text-sm">{saveToast.message}</span>
            <button
              onClick={() => setSaveToast(prev => ({ ...prev, show: false }))}
              className="ml-2 bg-white/20 hover:bg-white/30 rounded-full p-1 transition-colors"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* 📊 Strategy Blueprint Approval Modal */}
      {showStrategyModal && strategyBlueprint && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[99999] flex items-center justify-center p-4">
          <div className="bg-[#111418] border border-[#283039] rounded-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden shadow-2xl">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-[#283039] flex items-center justify-between bg-[#0d1117]">
              <div className="flex items-center gap-3">
                <div className="size-10 bg-[#137fec]/20 rounded-xl flex items-center justify-center">
                  <Brain size={20} className="text-[#137fec]" />
                </div>
                <div>
                  <h2 className="text-white font-bold text-lg">번역 전략 기획서</h2>
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest">
                    STRATEGY BLUEPRINT • ID: {strategyBlueprint.approval_id}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowStrategyModal(false)}
                className="text-gray-500 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 overflow-y-auto max-h-[60vh] space-y-6">
              {/* Content Analysis */}
              <div className="space-y-3">
                <h3 className="text-[10px] font-black text-[#137fec] uppercase tracking-widest flex items-center gap-2">
                  <div className="size-1.5 rounded-full bg-[#137fec]" /> 1. 콘텐츠 분석
                </h3>
                <div className="bg-[#1a232e] rounded-xl p-4 border border-[#283039]">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-[9px] text-gray-500 uppercase mb-1">제목 (추정)</p>
                      <p className="text-white font-bold">{strategyBlueprint.content_analysis.estimated_title}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-gray-500 uppercase mb-1">장르</p>
                      <p className="text-white">{strategyBlueprint.content_analysis.genre}</p>
                    </div>
                    <div>
                      <p className="text-[9px] text-gray-500 uppercase mb-1">분위기</p>
                      <p className="text-white">{strategyBlueprint.content_analysis.mood}</p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-[9px] text-gray-500 uppercase mb-1">요약</p>
                      <p className="text-gray-300 text-sm">{strategyBlueprint.content_analysis.summary}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Character Personas */}
              <div className="space-y-3">
                <h3 className="text-[10px] font-black text-[#137fec] uppercase tracking-widest flex items-center gap-2">
                  <div className="size-1.5 rounded-full bg-[#137fec]" /> 2. 캐릭터 페르소나 및 말투
                </h3>
                <div className="space-y-2">
                  {strategyBlueprint.character_personas.map((persona, idx) => (
                    <div key={idx} className="bg-[#1a232e] rounded-xl p-4 border border-[#283039]">
                      <div className="flex items-start gap-3">
                        <div className="size-8 bg-gradient-to-br from-[#137fec] to-[#8b5cf6] rounded-lg flex items-center justify-center text-white font-bold text-sm">
                          {persona.name.charAt(0)}
                        </div>
                        <div className="flex-1">
                          <p className="text-white font-bold">{persona.name}</p>
                          <p className="text-gray-400 text-xs mt-1">{persona.description}</p>
                          <p className="text-[#137fec] text-xs mt-2 font-mono bg-[#137fec]/10 px-2 py-1 rounded inline-block">
                            말투: {persona.speech_style}
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Data Diagnosis */}
              <div className="space-y-3">
                <h3 className="text-[10px] font-black text-[#137fec] uppercase tracking-widest flex items-center gap-2">
                  <div className="size-1.5 rounded-full bg-[#137fec]" /> 3. 데이터 진단
                </h3>
                <div className="bg-[#1a232e] rounded-xl p-4 border border-[#283039]">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-[9px] text-gray-500 uppercase mb-1">타임코드 상태</p>
                      <span className="text-green-400 font-mono text-sm flex items-center gap-1.5">
                        <span className="size-2 rounded-full bg-green-500 inline-block" />
                        {strategyBlueprint.data_diagnosis.timecode_status}
                      </span>
                    </div>
                    <div>
                      <p className="text-[9px] text-gray-500 uppercase mb-1">기술적 노이즈</p>
                      <p className="text-gray-300 text-sm">{strategyBlueprint.data_diagnosis.technical_noise}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Fixed Terms */}
              {strategyBlueprint.fixed_terms.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-[10px] font-black text-[#137fec] uppercase tracking-widest flex items-center gap-2">
                    <div className="size-1.5 rounded-full bg-[#137fec]" /> 4. 고정 용어
                  </h3>
                  <div className="bg-[#1a232e] rounded-xl border border-[#283039] overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-[#0d1117] text-[9px] text-gray-500 uppercase">
                        <tr>
                          <th className="px-4 py-2 text-left">원어</th>
                          <th className="px-4 py-2 text-left">번역</th>
                          <th className="px-4 py-2 text-left">비고</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#283039]/50">
                        {strategyBlueprint.fixed_terms.map((term, idx) => (
                          <tr key={idx}>
                            <td className="px-4 py-2 text-white font-mono">{term.original}</td>
                            <td className="px-4 py-2 text-[#137fec] font-bold">{term.translation}</td>
                            <td className="px-4 py-2 text-gray-400">{term.note || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Translation Rules */}
              <div className="space-y-3">
                <h3 className="text-[10px] font-black text-[#137fec] uppercase tracking-widest flex items-center gap-2">
                  <div className="size-1.5 rounded-full bg-[#137fec]" /> 5. 번역 규칙
                </h3>
                <div className="bg-[#1a232e] rounded-xl p-4 border border-[#283039]">
                  <ul className="space-y-2">
                    {strategyBlueprint.translation_rules.map((rule, idx) => (
                      <li key={idx} className="flex items-start gap-2 text-sm text-gray-300">
                        <CheckCircle2 size={14} className="text-green-500 mt-0.5 flex-shrink-0" />
                        {rule}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-4 border-t border-[#283039] bg-[#0d1117] flex items-center justify-between">
              <p className="text-[10px] text-gray-500">
                이 전략과 말투로 번역을 진행하시겠습니까?
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setShowStrategyModal(false)}
                  className="px-4 py-2 rounded-lg text-xs font-bold text-gray-400 hover:text-white hover:bg-[#283039] transition-all"
                >
                  수정 요청
                </button>
                <button
                  onClick={handleApproveAndTranslate}
                  disabled={loading}
                  className="px-6 py-2 rounded-lg text-xs font-black text-white bg-[#137fec] hover:bg-[#1589ff] shadow-[0_0_20px_rgba(19,127,236,0.3)] transition-all flex items-center gap-2 disabled:opacity-50"
                >
                  <Zap size={14} fill="currentColor" />
                  승인 및 번역 실행
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 🏛️ Top Toolbar */}
      <header className={`h-14 flex items-center justify-between border-b ${isDarkMode ? 'border-[#283039] bg-[#111418]/95' : 'border-gray-300 bg-white/95'} backdrop-blur-xl px-3 md:px-6 z-50 transition-colors duration-300`}>
        <div className="flex items-center gap-2 md:gap-4 flex-1">
          {/* 검색창 - 모바일에서는 숨김 */}
          <div className="hidden md:block max-w-md w-full relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 size-4" />
            <input
              type="text"
              placeholder="Search Movie Metadata..."
              className={`w-full ${isDarkMode ? 'bg-[#1a232e] border-[#283039] text-white' : 'bg-white border-gray-300 text-gray-900'} border rounded-full py-1.5 pl-10 pr-4 text-xs focus:outline-none focus:border-[#137fec] focus:ring-1 focus:ring-[#137fec] transition-all`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearch}
            />
          </div>
        </div>

        <div className="flex items-center gap-1 md:gap-3">
          {/* 새로시작 */}
          <button
            onClick={handleNewStart}
            disabled={loading}
            className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-orange-400 bg-orange-500/10 border border-orange-500/30 hover:bg-orange-500/20 hover:border-orange-500/40 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
            title="새로시작 — 모든 상태 초기화"
          >
            <RotateCcw size={14} />
            <span>새로시작</span>
          </button>
          {/* 백엔드 상태 */}
          <div className={`flex items-center gap-1.5 px-2 md:px-3 py-1 bg-[#283039] rounded-full text-[10px] font-bold border ${backendConnected ? 'text-green-400 border-green-500/20' : 'text-red-400 border-red-500/20'}`}>
            <div className={`size-1.5 rounded-full ${backendConnected ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <span className="hidden sm:inline">{backendConnected ? 'CONNECTED' : 'OFFLINE'}</span>
          </div>
          <button
            onClick={() => { setShowHistoryModal(true); loadTranslationHistory(); }}
            className="p-2 hover:bg-[#283039] rounded-lg transition-colors text-gray-400 hover:text-[#137fec] relative"
            title="번역 히스토리"
          >
            <Bell size={18} />
            {translationHistory.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-[#137fec] text-white text-[8px] font-bold rounded-full size-4 flex items-center justify-center">
                {translationHistory.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setShowSettingsModal(true)}
            className="p-2 hover:bg-[#283039] rounded-lg transition-colors text-gray-400 hover:text-[#137fec]"
            title="설정"
          >
            <Settings size={18} />
          </button>
          <button
            onClick={() => setIsDarkMode(!isDarkMode)}
            className="p-2 hover:bg-[#283039] rounded-lg transition-all text-gray-400 hover:text-yellow-400"
            title={isDarkMode ? "라이트 모드로 전환" : "다크 모드로 전환"}
          >
            {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      {/* 📱 MOBILE TOOLBAR - 모바일 전용 상단 액션바 */}
      <div className="md:hidden flex items-center gap-2 px-3 py-2 border-b border-[#283039] bg-[#0d1117]">
        {/* SRT 로드 버튼 */}
        <button
          onClick={() => srtInputRef.current?.click()}
          disabled={loading}
          className={`flex-1 h-10 rounded-lg flex items-center justify-center gap-2 text-sm font-bold transition-all ${srtFile
            ? 'bg-green-500/20 text-green-400 border border-green-500/30'
            : 'bg-[#137fec]/20 text-[#137fec] border border-[#137fec]/30 hover:bg-[#137fec]/30'
            }`}
        >
          <FileText size={16} />
          <span>{srtFile ? '자막 ✓' : '자막 로드'}</span>
        </button>

        {/* 비디오 로드 버튼 */}
        <button
          onClick={() => fileInputRef.current?.click()}
          className={`flex-1 h-10 rounded-lg flex items-center justify-center gap-2 text-sm font-bold transition-all ${videoFile
            ? 'bg-green-500/20 text-green-400 border border-green-500/30'
            : 'bg-[#1a232e] text-gray-400 border border-[#283039] hover:bg-[#283039]'
            }`}
        >
          <FileVideo size={16} />
          <span>{videoFile ? '비디오 ✓' : '비디오'}</span>
        </button>

        {/* 번역 시작 버튼 */}
        <button
          onClick={executeTranslation}
          disabled={!subtitles.length || loading}
          className={`h-10 px-4 rounded-lg flex items-center justify-center gap-1 text-sm font-bold transition-all ${!subtitles.length || loading
            ? 'bg-gray-700 text-gray-500 cursor-not-allowed'
            : 'bg-[#137fec] text-white hover:bg-[#1589ff] shadow-[0_0_15px_rgba(19,127,236,0.4)]'
            }`}
        >
          <Zap size={14} fill="currentColor" />
          {loading ? '번역중...' : '번역'}
        </button>

        {/* 새로시작 버튼 (모바일) */}
        <button
          onClick={handleNewStart}
          disabled={loading}
          className="h-10 w-10 rounded-lg flex items-center justify-center text-gray-400 hover:text-orange-400 hover:bg-orange-500/10 border border-[#283039] hover:border-orange-500/20 transition-all disabled:opacity-30"
          title="새로시작"
        >
          <RotateCcw size={16} />
        </button>
      </div>

      {/* 📱 Mobile Progress + Log Bar — 번역 진행 시 최신 로그 표시 */}
      {loading && subtitles.length > 0 && (
        <div className="md:hidden px-3 py-2 border-b border-[#283039] bg-[#0d1117]/95 backdrop-blur-sm">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="size-3 border-2 border-[#137fec]/30 border-t-[#137fec] rounded-full animate-spin" />
            <span className="text-[11px] font-mono font-bold text-[#137fec]">{processingProgress}%</span>
            <div className="flex-1 h-1 bg-[#283039] rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-[#137fec] to-[#4da6ff] transition-all duration-300"
                style={{ width: `${processingProgress}%` }} />
            </div>
            <span className="text-[10px] text-gray-500 font-mono">{currentBatch}/{totalBatches}</span>
          </div>
          {logMessages.length > 0 && (
            <div className="text-[10px] font-mono text-gray-400 truncate pl-5">
              {logMessages[logMessages.length - 1]}
            </div>
          )}
        </div>
      )}

      {/* 📱 Mobile Tab Bar */}
      <div className={`md:hidden flex border-b ${isDarkMode ? 'border-[#283039] bg-[#111418]' : 'border-gray-200 bg-white'} shrink-0`}>
        <button
          onClick={() => setMobileTab('files')}
          className={`flex-1 py-2.5 text-xs font-bold flex flex-col items-center gap-1 transition-colors ${mobileTab === 'files' ? 'text-[#137fec] border-b-2 border-[#137fec]' : 'text-gray-500'}`}
        >
          <FolderOpen size={16} />파일
        </button>
        <button
          onClick={() => setMobileTab('player')}
          className={`flex-1 py-2.5 text-xs font-bold flex flex-col items-center gap-1 transition-colors ${mobileTab === 'player' ? 'text-[#137fec] border-b-2 border-[#137fec]' : 'text-gray-500'}`}
        >
          <FileVideo size={16} />플레이어
        </button>
        <button
          onClick={() => setMobileTab('intel')}
          className={`flex-1 py-2.5 text-xs font-bold flex flex-col items-center gap-1 transition-colors relative ${mobileTab === 'intel' ? 'text-[#137fec] border-b-2 border-[#137fec]' : 'text-gray-500'}`}
        >
          <Brain size={16} />전략
          {strategyBlueprint && <span className="absolute top-1 right-3 size-1.5 rounded-full bg-green-500" />}
        </button>
        <button
          onClick={() => setMobileTab('log')}
          className={`flex-1 py-2.5 text-xs font-bold flex flex-col items-center gap-1 transition-colors relative ${mobileTab === 'log' ? 'text-[#137fec] border-b-2 border-[#137fec]' : 'text-gray-500'}`}
        >
          <Terminal size={16} />로그
          {loading && <span className="absolute top-1 right-3 size-1.5 rounded-full bg-[#137fec] animate-pulse" />}
        </button>
      </div>

      <div className="flex-1 flex overflow-hidden flex-col md:flex-row">
        {/* 📋 Left Panel: Assets & Data */}
        <aside className={`${mobileTab === 'files' ? 'flex flex-1 min-h-0' : 'hidden'} md:flex md:flex-none w-full md:w-[320px] border-r ${isDarkMode ? 'border-[#283039] bg-[#111418]' : 'border-gray-300 bg-gray-50'} flex-col transition-colors duration-300`}>
          <div className="p-4 flex-1 flex flex-col gap-6 overflow-y-auto overflow-x-hidden custom-scrollbar">
            {/* Metadata Card */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Active Project</h3>
                {srtFile && (
                  <span className="text-[10px] text-[#137fec] font-bold bg-[#137fec]/10 px-2 py-0.5 rounded truncate max-w-[100px]">
                    {srtFile.name.replace('.srt', '')}
                  </span>
                )}
              </div>

              <div className="relative aspect-[2/3] rounded-xl overflow-hidden border border-[#283039] group max-h-[260px] md:max-h-none">
                {metadata?.poster_url ? (
                  <img
                    src={metadata.poster_url}
                    className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                    alt="Poster"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center bg-[#1a232e] gap-3 py-8">
                    <div className="size-12 rounded-xl bg-[#283039] flex items-center justify-center">
                      <FileVideo size={24} className="text-gray-600" />
                    </div>
                    <p className="text-gray-600 text-xs text-center px-4">영화 제목을 검색하거나<br/>자막 파일을 로드하세요</p>
                  </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-[#101922] via-transparent to-transparent" />
                <div className="absolute bottom-3 left-3 right-3">
                  <h4 className="text-white font-bold text-lg leading-tight">{metadata?.title || ""}</h4>
                  <p className="text-[#9dabb9] text-[10px] uppercase font-bold tracking-tighter opacity-80">{metadata?.orig_title || ""}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="bg-[#1a232e] p-2 rounded-lg border border-[#283039]">
                  <p className="text-[9px] text-gray-500 font-bold uppercase">Year</p>
                  <p className="text-xs font-bold text-white">{metadata?.year || "-"}</p>
                </div>
                <div className="bg-[#1a232e] p-2 rounded-lg border border-[#283039]">
                  <p className="text-[9px] text-gray-500 font-bold uppercase">Runtime</p>
                  <p className="text-xs font-bold text-white">{metadata?.runtime || "-"}</p>
                </div>
                <div className="bg-[#1a232e] p-2 rounded-lg border border-[#283039] col-span-2">
                  <p className="text-[9px] text-gray-500 font-bold uppercase">Genre</p>
                  <p className="text-xs font-bold text-white">{metadata?.genre?.join(', ') || "-"}</p>
                </div>
              </div>

              {/* Director & Cast - Extended Metadata */}
              {metadata?.director && (
                <div className="bg-[#1a232e] p-3 rounded-lg border border-[#283039] space-y-2">
                  <div>
                    <p className="text-[9px] text-gray-500 font-bold uppercase">Director</p>
                    <p className="text-xs font-bold text-[#137fec]">{metadata.director}</p>
                  </div>
                  {metadata.actors && (
                    <div>
                      <p className="text-[9px] text-gray-500 font-bold uppercase">Cast</p>
                      <p className="text-xs text-gray-300 leading-relaxed">{metadata.actors}</p>
                    </div>
                  )}
                  {metadata.imdb_rating && (
                    <div className="flex items-center gap-2 pt-1">
                      <span className="text-yellow-500">★</span>
                      <span className="text-xs font-bold text-white">{metadata.imdb_rating}/10</span>
                      <span className="text-[9px] text-gray-500">IMDB</span>
                    </div>
                  )}
                </div>
              )}

              {/* Synopsis */}
              {metadata?.synopsis && metadata.synopsis.length > 20 && (
                <div className="bg-[#1a232e] p-3 rounded-lg border border-[#283039]">
                  <p className="text-[9px] text-gray-500 font-bold uppercase mb-1">Synopsis</p>
                  <p className="text-[11px] text-gray-400 leading-relaxed line-clamp-4">{metadata.synopsis}</p>
                </div>
              )}

              {/* 데이터 보강 버튼 — 메타데이터 있으면 항상 표시 */}
              {metadata?.title && (
                <button
                  onClick={async () => {
                    setEnriching(true);
                    setSaveToast({ show: true, message: '줄거리 데이터 보강 중...', type: 'fallback' });
                    try {
                      if (loadedMovieId) {
                        // 라이브러리 영화: DB 보강 → 리로드
                        const result = await enrichMovie(loadedMovieId);
                        if (result.success) {
                          const fresh = await getMovieForTranslation(loadedMovieId);
                          if (fresh.success && fresh.data) {
                            const movie = fresh.data.movie;
                            const freshCast: string[] = movie.cast ? JSON.parse(movie.cast) : [];
                            const freshCastProfiles: { name: string; character: string; profilePath: string | null }[] =
                              movie.castProfiles ? JSON.parse(movie.castProfiles) : [];
                            const freshGenres: string[] = movie.genres ? JSON.parse(movie.genres) : [];
                            setMetadata({
                              ...metadata,
                              genre: freshGenres.length > 0 ? freshGenres : metadata.genre,
                              synopsis: movie.plotFullKo || movie.plotFull || movie.overview || metadata.synopsis,
                              detailed_plot: movie.plotFull || metadata.detailed_plot,
                              detailed_plot_ko: movie.plotFullKo || metadata.detailed_plot_ko,
                              omdb_full_plot: movie.plotFull || metadata.omdb_full_plot,
                              wikipedia_plot: movie.wikiSummary || metadata.wikipedia_plot,
                              wikipedia_overview: movie.wikiOverview || metadata.wikipedia_overview,
                              has_wikipedia: !!movie.wikiSummary || metadata.has_wikipedia,
                              imdb_rating: movie.imdbRating || metadata.imdb_rating,
                              imdb_id: movie.imdbId || metadata.imdb_id,
                              director: movie.director || metadata.director,
                              writer: movie.writer || metadata.writer,
                              actors: freshCast.length > 0 ? freshCast.join(", ") : metadata.actors,
                              characters: freshCastProfiles.length > 0
                                ? freshCastProfiles.map((c) => ({ actor: c.name, character: c.character }))
                                : metadata.characters,
                              rated: movie.rated || metadata.rated,
                              awards: movie.awards || metadata.awards,
                              rotten_tomatoes: movie.rottenTomatoes || metadata.rotten_tomatoes,
                              metacritic: movie.metacritic || metadata.metacritic,
                              box_office: movie.boxOffice || metadata.box_office,
                            });
                            addLog(`[OK] 데이터 보강 완료 — 줄거리 ${movie.plotFull ? '✓' : '✗'} / 한글번역 ${movie.plotFullKo ? '✓' : '✗'} / IMDB ${movie.imdbRating || '✗'}`);
                          }
                          setSaveToast({ show: true, message: result.error || '데이터 보강 완료!', type: 'success' });
                        } else {
                          setSaveToast({ show: true, message: result.error || '보강 실패', type: 'fallback' });
                        }
                      } else {
                        // 검색으로 진입: 백엔드 API로 메타데이터 재검색
                        const res = await fetch(`${API_BASE}/metadata/search?title=${encodeURIComponent(metadata.title)}`);
                        const data = await res.json();
                        if (data && !data.error) {
                          setMetadata(data);
                          const plotLen = (data.detailed_plot || data.wikipedia_plot || data.synopsis || '').length;
                          addLog(`[OK] 메타데이터 재검색 완료 — 줄거리 ${plotLen}자 / Wikipedia ${data.has_wikipedia ? '✓' : '✗'}`);
                          setSaveToast({ show: true, message: '메타데이터 보강 완료!', type: 'success' });
                        } else {
                          setSaveToast({ show: true, message: '검색 결과 없음', type: 'fallback' });
                        }
                      }
                    } catch {
                      setSaveToast({ show: true, message: '보강 중 오류 발생', type: 'fallback' });
                    } finally {
                      setEnriching(false);
                      setTimeout(() => setSaveToast(prev => ({ ...prev, show: false })), 3000);
                    }
                  }}
                  disabled={enriching}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-[#1a232e] hover:bg-[#243040] border border-[#283039] hover:border-[#137fec]/50 rounded-lg text-xs text-gray-300 hover:text-white transition-all disabled:opacity-50"
                >
                  <Sparkles className={`w-3.5 h-3.5 ${enriching ? 'animate-pulse text-yellow-400' : 'text-[#137fec]'}`} />
                  {enriching ? '보강 중...' : '데이터 보강 (OMDB · 줄거리)'}
                </button>
              )}

              {/* 한글 번역 재실행 버튼 — 메타데이터 있으면 항상 표시 (라이브러리 영화만 동작) */}
              {metadata?.title && (
                <button
                  onClick={async () => {
                    setEnriching(true);
                    setSaveToast({ show: true, message: '한글 번역 초기화 후 재실행 중...', type: 'fallback' });
                    try {
                      const targetId = loadedMovieId || movieIdParam;
                      if (!targetId) {
                        setSaveToast({ show: true, message: '영화 ID를 찾을 수 없습니다', type: 'fallback' });
                        return;
                      }
                      const result = await resetAndEnrichMovie(targetId);
                      if (result.success) {
                        const fresh = await getMovieForTranslation(targetId);
                        if (fresh.success && fresh.data) {
                          const movie = fresh.data.movie;
                          setMetadata({
                            ...metadata,
                            synopsis: movie.plotFullKo || movie.plotFull || movie.overview || metadata.synopsis,
                            detailed_plot: movie.plotFull || metadata.detailed_plot,
                            detailed_plot_ko: movie.plotFullKo || metadata.detailed_plot_ko,
                          });
                          addLog(`[OK] 한글 번역 재실행 완료 — plotFullKo ${movie.plotFullKo ? `${movie.plotFullKo.length}자` : '✗'}`);
                        }
                        setSaveToast({ show: true, message: '한글 번역 재실행 완료!', type: 'success' });
                      } else {
                        setSaveToast({ show: true, message: result.error || '재번역 실패', type: 'fallback' });
                        addLog(`[ERR] 한글 번역 재실행 실패: ${result.error}`);
                      }
                    } catch {
                      setSaveToast({ show: true, message: '재번역 중 오류 발생', type: 'fallback' });
                    } finally {
                      setEnriching(false);
                      setTimeout(() => setSaveToast(prev => ({ ...prev, show: false })), 3000);
                    }
                  }}
                  disabled={enriching}
                  className="w-full flex items-center justify-center gap-2 py-2.5 bg-[#1a1a2e] hover:bg-[#24243e] border border-[#3d2d6e]/50 hover:border-[#8b5cf6]/60 rounded-lg text-xs text-gray-400 hover:text-purple-300 transition-all disabled:opacity-50"
                >
                  <RotateCcw className={`w-3.5 h-3.5 ${enriching ? 'animate-spin text-purple-400' : 'text-purple-500'}`} />
                  {enriching ? '재번역 중...' : '한글 번역 재실행'}
                </button>
              )}
            </div>

            {/* Persona Matrix */}
            <div className="space-y-4">
              <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest flex items-center gap-2">
                <Sliders size={12} /> Persona Matrix
              </h3>
              <div className="space-y-2">
                {strategyBlueprint?.character_personas && strategyBlueprint.character_personas.length > 0 ? (
                  strategyBlueprint.character_personas.map((persona, idx) => (
                    <div key={idx} className="bg-[#1a232e] border border-[#283039] p-3 rounded-xl">
                      <div className="flex items-center gap-2 mb-1">
                        <div className="size-6 bg-gradient-to-br from-[#137fec] to-[#8b5cf6] rounded-md flex items-center justify-center text-white font-bold text-[10px]">
                          {persona.name.charAt(0)}
                        </div>
                        <p className="text-xs font-bold text-white">{persona.name}</p>
                      </div>
                      <p className="text-[10px] text-[#137fec] font-mono">{persona.speech_style}</p>
                    </div>
                  ))
                ) : (
                  <div className="bg-[#1a232e] border border-[#283039] p-3 rounded-xl text-center">
                    <p className="text-xs text-gray-500">AI 분석 후 페르소나 표시</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="p-4 border-t border-[#283039] bg-[#0d1117]">
            {/* Hidden file inputs */}
            <input
              ref={srtInputRef}
              type="file"
              accept=".srt"
              onChange={handleSrtUpload}
              className="hidden"
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={handleVideoSelect}
              className="hidden"
            />

            {/* File Upload Section - Vertical Layout */}
            <div className="space-y-3">
              {/* Section Title */}
              <div className="flex items-center gap-2 mb-1">
                <Upload size={12} className="text-[#137fec]" />
                <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">파일 로드</span>
              </div>

              {/* Step 1: Subtitle Load */}
              <div className="relative">
                <div className="absolute -left-1 top-0 bottom-0 w-0.5 bg-gradient-to-b from-[#137fec] to-[#137fec]/30 rounded-full" />
                <div className="pl-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`size-5 rounded-full flex items-center justify-center text-[10px] font-bold ${srtFile ? 'bg-green-500 text-white' : 'bg-[#137fec] text-white'}`}>
                      {srtFile ? '✓' : '1'}
                    </div>
                    <span className="text-[10px] font-bold text-gray-400 uppercase">자막 파일</span>
                  </div>
                  <button
                    onClick={() => srtInputRef.current?.click()}
                    disabled={loading}
                    className="w-full bg-[#137fec] hover:bg-[#1589ff] text-white py-3 px-4 rounded-xl font-bold text-xs flex items-center gap-3 shadow-[0_10px_20px_rgba(19,127,236,0.2)] active:scale-[0.98] transition-all disabled:opacity-50 group"
                  >
                    <FileText size={18} className="flex-shrink-0" />
                    <div className="flex-1 text-left truncate">
                      {srtFile ? (
                        <span className="text-white/90">{srtFile.name}</span>
                      ) : (
                        <span>SRT 자막 불러오기</span>
                      )}
                    </div>
                    <FolderOpen size={14} className="flex-shrink-0 opacity-60 group-hover:opacity-100" />
                  </button>
                </div>
              </div>

              {/* Step 2: Video Load */}
              <div className="relative">
                <div className="absolute -left-1 top-0 bottom-0 w-0.5 bg-gradient-to-b from-[#283039] to-transparent rounded-full" />
                <div className="pl-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className={`size-5 rounded-full flex items-center justify-center text-[10px] font-bold ${videoFile ? 'bg-green-500 text-white' : 'bg-[#283039] text-gray-400 border border-[#3d4654]'}`}>
                      {videoFile ? '✓' : '2'}
                    </div>
                    <span className="text-[10px] font-bold text-gray-500 uppercase">비디오 파일 (선택)</span>
                  </div>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full bg-[#1a232e] hover:bg-[#283039] text-white py-3 px-4 rounded-xl font-bold text-xs flex items-center gap-3 border border-[#283039] hover:border-[#3d4654] active:scale-[0.98] transition-all group"
                  >
                    <FileVideo size={18} className="flex-shrink-0 text-gray-400 group-hover:text-[#137fec]" />
                    <div className="flex-1 text-left truncate">
                      {videoFile ? (
                        <span className="text-white/90">{videoFile.name.length > 25 ? videoFile.name.slice(0, 25) + '...' : videoFile.name}</span>
                      ) : (
                        <span className="text-gray-400">비디오 불러오기</span>
                      )}
                    </div>
                    <FolderOpen size={14} className="flex-shrink-0 text-gray-500 opacity-60 group-hover:opacity-100" />
                  </button>
                </div>
              </div>

              {/* Status Summary */}
              {(srtFile || videoFile) && (
                <div className="mt-3 pt-3 border-t border-[#283039]/50">
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-gray-500">로드 상태</span>
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded ${srtFile ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-500'}`}>
                        자막 {srtFile ? '✓' : '-'}
                      </span>
                      <span className={`px-2 py-0.5 rounded ${videoFile ? 'bg-green-500/20 text-green-400' : 'bg-gray-500/20 text-gray-500'}`}>
                        비디오 {videoFile ? '✓' : '-'}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* 🎬 Center Panel: The Cinema Engine */}
        <main className={`${mobileTab !== 'player' ? 'hidden' : ''} md:flex flex-1 flex flex-col ${isDarkMode ? 'bg-[#090e14]' : 'bg-white'} relative transition-colors duration-300`}>
          {/* Main Video Engine */}
          <div className="flex-1 relative flex items-center justify-center group/player">
            <div
              ref={videoContainerRef}
              className="w-full h-full bg-black relative flex items-center justify-center"
              style={{ isolation: 'isolate' }}
              onContextMenu={handleContextMenu}
              onMouseMove={resetControlsTimeout}
              onTouchStart={resetControlsTimeout}
              onMouseLeave={() => {
                // 마우스가 비디오 영역 벗어나면 재생 중일 때 즉시 숨김
                if (isPlaying && videoUrl) {
                  if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
                  setShowControls(false);
                  if (videoContainerRef.current) {
                    videoContainerRef.current.style.cursor = 'none';
                  }
                }
              }}
            >
              {/* 전체화면 상태 표시 - 제거됨 (디버그 완료) */}

              {videoUrl ? (
                <video
                  ref={videoRef}
                  preload="metadata"
                  src={isHlsMode ? undefined : videoUrl}
                  className="w-full h-full object-contain cursor-pointer"
                  style={{ zIndex: 1 }}
                  onClick={handleVideoClick}
                  onDoubleClick={(e) => e.preventDefault()}
                  onLoadedMetadata={() => {
                    console.log('[DEBUG] Video metadata loaded, duration:', videoRef.current?.duration);
                    addLog(`> Video ready (${Math.floor(videoRef.current?.duration || 0)}s)`);
                  }}
                  onError={async (e) => {
                    const video = e.currentTarget;
                    const errCode = video.error?.code;
                    console.warn('[VIDEO WARN] Native Error Code:', errCode);

                    // HLS.js가 관리 중일 때는 네이티브 onError 이벤트 무시
                    if (hlsRef.current) return;

                    // Blob URL (로컬 파일)은 HLS 변환 불가 → 코덱 에러 안내
                    if (videoUrl?.startsWith('blob:')) {
                      if (errCode === 4) {
                        addLog(`[ERROR] 이 파일의 코덱/형식이 브라우저에서 지원되지 않습니다.`);
                        addLog(`[INFO] MP4 (H.264 + AAC) 변환 권장: ffmpeg -i input.mkv -c:v libx264 -c:a aac output.mp4`);
                      } else {
                        addLog(`[ERROR] 비디오 로드 실패 (code: ${errCode})`);
                      }
                      return;
                    }

                    // HTTP URL: 코드 4이면 HLS 트랜스코딩으로 전환
                    if (errCode === 4 && videoUrl && !videoUrl.includes('type=hls')) {
                      addLog(`[WARN] 비디오 스트리밍 형식 최적화 (HLS 트랜스코딩) 연결중...`);
                      setVideoUrl(videoUrl.includes('?') ? `${videoUrl}&type=hls` : `${videoUrl}?type=hls`);
                    } else if (errCode === 4 && videoUrl?.includes('type=hls')) {
                      addLog(`[ERROR] HLS 스트리밍 로드에 실패했습니다. 형식 변환이 진행중일 수 있습니다.`);
                    }
                  }}
                  onTimeUpdate={handleTimeUpdate}
                  onSeeking={handleSeeking}
                  onSeeked={handleSeeked}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center opacity-40 pointer-events-none">
                  <Zap size={120} className="text-[#137fec] mb-4" />
                  <p className="text-gray-500 text-sm">Load a video file to begin</p>
                </div>
              )}

              {/* 🔤 Dual Subtitle Engine Overlay - 전체화면 지원 */}
              {subtitles.length > 0 && (
                <div
                  className="subtitle-overlay flex flex-col items-center gap-2 drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)] pointer-events-none absolute bottom-[10%] left-0 right-0 z-[9999]"
                  style={{ zIndex: 2147483647 }}
                >
                  {activeSubtitle ? (
                    <>
                      {/* 원문 자막 (both 또는 original 모드) - 배경 없음 */}
                      {(subtitleMode === 'both' || subtitleMode === 'original') && (
                        <p className="text-gray-200 text-2xl font-medium px-2"
                          style={{ textShadow: '2px 2px 4px #000, -2px -2px 4px #000, 2px -2px 4px #000, -2px 2px 4px #000, 0 0 8px #000' }}>
                          {activeSubtitle.en}
                        </p>
                      )}
                      {/* 번역 자막 (both 또는 translated 모드) - 배경 없음 */}
                      {(subtitleMode === 'both' || subtitleMode === 'translated') && (
                        <h2 className="text-white text-5xl font-bold tracking-tight px-2"
                          style={{ textShadow: '3px 3px 6px #000, -3px -3px 6px #000, 3px -3px 6px #000, -3px 3px 6px #000, 0 0 12px #000' }}>
                          {activeSubtitle.ko || (subtitleMode === 'translated' ? activeSubtitle.en : '')}
                        </h2>
                      )}
                    </>
                  ) : null}
                </div>
              )}

              {/* 자막 모드 선택 버튼 - 풀스크린에서 컨트롤과 함께 자동 숨김 */}
              {subtitles.length > 0 && (
                <div className={`absolute top-4 right-4 flex gap-1 z-40 transition-opacity duration-300 ${
                  showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
                  }`}>
                  <button
                    onClick={() => setSubtitleMode('original')}
                    className={`px-2 py-1 text-[10px] font-bold rounded backdrop-blur-sm ${subtitleMode === 'original' ? 'bg-[#137fec] text-white' : 'bg-black/40 text-gray-300 hover:text-white hover:bg-black/60'}`}
                  >
                    원문
                  </button>
                  <button
                    onClick={() => setSubtitleMode('both')}
                    className={`px-2 py-1 text-[10px] font-bold rounded backdrop-blur-sm ${subtitleMode === 'both' ? 'bg-[#137fec] text-white' : 'bg-black/40 text-gray-300 hover:text-white hover:bg-black/60'}`}
                  >
                    둘 다
                  </button>
                  <button
                    onClick={() => setSubtitleMode('translated')}
                    className={`px-2 py-1 text-[10px] font-bold rounded backdrop-blur-sm ${subtitleMode === 'translated' ? 'bg-[#137fec] text-white' : 'bg-black/40 text-gray-300 hover:text-white hover:bg-black/60'}`}
                  >
                    번역
                  </button>
                </div>
              )}

              {/* Hover Controls - Enhanced Player (INSIDE videoContainerRef for fullscreen) */}
              {/* 모달이 열려있으면 컨트롤 숨김 */}
              {!showStrategyModal && !showSettingsModal && !showHistoryModal && (
                <div
                  className={`video-controls absolute inset-x-0 bottom-0 p-6 bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300 ${
                    showControls ? 'controls-visible opacity-100' : 'controls-hidden opacity-0 pointer-events-none'
                    }`}
                  style={{ zIndex: 2147483647 }}
                  onMouseMove={resetControlsTimeout}
                >
                  <div className="flex flex-col gap-4">
                    {/* Seek Bar */}
                    <div
                      className="h-2 w-full bg-gray-800 rounded-full overflow-hidden cursor-pointer hover:h-3 transition-all"
                      onClick={(e) => {
                        if (videoRef.current && videoRef.current.duration) {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const clickX = e.clientX - rect.left;
                          const percentage = clickX / rect.width;
                          videoRef.current.currentTime = percentage * videoRef.current.duration;
                        }
                      }}
                    >
                      <div
                        className="h-full bg-[#137fec] shadow-[0_0_10px_#137fec] transition-all pointer-events-none"
                        style={{ width: videoRef.current ? `${(videoRef.current.currentTime / (videoRef.current.duration || 1)) * 100}%` : '0%' }}
                      />
                    </div>

                    {/* Control Row */}
                    <div className="flex items-center justify-between">
                      {/* Left Controls */}
                      <div className="flex items-center gap-3">
                        {/* -30s */}
                        <button
                          onClick={() => skipTime(-30)}
                          className="text-white/70 hover:text-white text-xs font-bold px-2 py-1 rounded hover:bg-white/10 transition"
                          title="30초 뒤로 (↓)"
                        >
                          -30s
                        </button>

                        {/* -10s */}
                        <Rewind
                          size={22}
                          className="text-white cursor-pointer hover:text-[#137fec] transition"
                          onClick={() => skipTime(-10)}
                        />

                        {/* Play/Pause */}
                        <button
                          onClick={() => {
                            if (videoRef.current) {
                              isPlaying ? videoRef.current.pause() : videoRef.current.play();
                            }
                          }}
                          className="size-12 bg-white rounded-full flex items-center justify-center text-black hover:scale-110 transition-transform"
                        >
                          {isPlaying ? <Pause size={24} fill="black" /> : <Play size={24} fill="black" className="translate-x-0.5" />}
                        </button>

                        {/* +10s */}
                        <FastForward
                          size={22}
                          className="text-white cursor-pointer hover:text-[#137fec] transition"
                          onClick={() => skipTime(10)}
                        />

                        {/* +30s */}
                        <button
                          onClick={() => skipTime(30)}
                          className="text-white/70 hover:text-white text-xs font-bold px-2 py-1 rounded hover:bg-white/10 transition"
                          title="30초 앞으로 (↑)"
                        >
                          +30s
                        </button>

                        {/* Time Display */}
                        <span className="text-sm font-mono text-white ml-3">
                          {currentTime.split(',')[0]} / {videoRef.current?.duration ?
                            `${String(Math.floor(videoRef.current.duration / 3600)).padStart(2, '0')}:${String(Math.floor((videoRef.current.duration % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(videoRef.current.duration % 60)).padStart(2, '0')}`
                            : '00:00:00'}
                        </span>
                      </div>

                      {/* Right Controls */}
                      <div className="flex items-center gap-3">
                        {/* Speed Control */}
                        <div className="relative">
                          <button
                            onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                            className="flex items-center gap-1 text-white hover:text-[#137fec] transition px-2 py-1 rounded hover:bg-white/10"
                          >
                            <Gauge size={18} />
                            <span className="text-xs font-bold">{playbackSpeed}x</span>
                          </button>
                          {showSpeedMenu && (
                            <div className="absolute bottom-full right-0 mb-2 bg-black/95 rounded-lg border border-gray-700 py-1 min-w-[80px]">
                              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(speed => (
                                <button
                                  key={speed}
                                  onClick={() => setSpeed(speed)}
                                  className={`w-full px-3 py-1.5 text-xs text-left hover:bg-[#137fec]/20 transition ${playbackSpeed === speed ? 'text-[#137fec] font-bold' : 'text-white'
                                    }`}
                                >
                                  {speed}x
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Volume Control */}
                        <div
                          className="relative flex items-center gap-2"
                          onMouseEnter={() => setShowVolumeSlider(true)}
                          onMouseLeave={() => setShowVolumeSlider(false)}
                        >
                          {volume > 0 ? (
                            <Volume2
                              size={20}
                              className="text-white cursor-pointer hover:text-[#137fec] transition"
                              onClick={() => {
                                setVolume(0);
                                if (videoRef.current) videoRef.current.volume = 0;
                              }}
                            />
                          ) : (
                            <VolumeX
                              size={20}
                              className="text-red-400 cursor-pointer hover:text-white transition"
                              onClick={() => {
                                setVolume(1);
                                if (videoRef.current) videoRef.current.volume = 1;
                              }}
                            />
                          )}
                          {showVolumeSlider && (
                            <input
                              type="range"
                              min="0"
                              max="1"
                              step="0.05"
                              value={volume}
                              onChange={(e) => {
                                const newVolume = parseFloat(e.target.value);
                                setVolume(newVolume);
                                if (videoRef.current) videoRef.current.volume = newVolume;
                              }}
                              className="w-20 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer accent-[#137fec]"
                            />
                          )}
                        </div>

                        {/* PiP */}
                        <button
                          onClick={togglePiP}
                          className={`text-white hover:text-[#137fec] transition p-1 rounded hover:bg-white/10 ${isPiP ? 'text-[#137fec]' : ''}`}
                          title="PIP 모드 (P)"
                        >
                          <PictureInPicture2 size={18} />
                        </button>

                        {/* Fullscreen */}
                        <button
                          onClick={toggleFullscreen}
                          className="text-white hover:text-[#137fec] transition p-1 rounded hover:bg-white/10"
                          title="전체화면 (F)"
                        >
                          {isFullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
                        </button>
                      </div>
                    </div>

                    {/* Keyboard Shortcuts Hint */}
                    {isFullscreen && (
                      <div className="text-center text-gray-500 text-[10px] mt-1">
                        ← → 10초 | ↑ ↓ 30초 | Space 재생 | F 전체화면 | M 음소거 | &lt; &gt; 속도
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 🎹 Pro-Grade Sync Timeline - 모바일에서 더 축소 */}
          <div className="h-[220px] md:h-[380px] bg-[#111418] border-t border-[#283039] flex flex-col">
            {/* Waveform Toolbar - 모바일에서 숨김 */}
            <div className="hidden md:flex h-10 border-b border-[#283039] items-center justify-between px-6 bg-[#0d1117]">
              <div className="flex items-center gap-4 text-[10px] font-mono text-gray-400">
                <span className="flex items-center gap-1.5">
                  <div className={`size-2 rounded-full ${subtitles.length > 0 ? 'bg-green-500' : 'bg-gray-500'}`} />
                  {subtitles.length > 0 ? 'LOADED' : 'NO DATA'}
                </span>
                <span>FPS: {metadata?.fps || '-'}</span>
                <span>{subtitles.length} blocks</span>
              </div>
              <div className="flex items-center gap-3">
                <button className="p-1.5 hover:text-white text-gray-500 hover:bg-[#283039] rounded transition-colors">
                  <Search size={14} />
                </button>
                <div className="flex items-center gap-2 bg-[#1a232e] rounded-lg px-2 py-1">
                  <button className="text-gray-500 hover:text-white">−</button>
                  <div className="w-16 h-1 bg-[#283039] rounded-full overflow-hidden">
                    <div className="w-1/2 h-full bg-[#137fec]" />
                  </div>
                  <button className="text-gray-500 hover:text-white">+</button>
                </div>
              </div>
            </div>

            {/* Waveform Visualization - Click to seek - 모바일에서 숨김 */}
            <div
              className="hidden md:block h-24 bg-[#0a0e12] relative overflow-hidden border-b border-[#283039] cursor-pointer"
              onClick={(e) => {
                if (videoRef.current && videoRef.current.duration) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const clickX = e.clientX - rect.left;
                  const percentage = clickX / rect.width;
                  videoRef.current.currentTime = percentage * videoRef.current.duration;
                }
              }}
            >
              {/* Grid Lines */}
              <div className="absolute inset-0 flex justify-between px-4 pointer-events-none opacity-20">
                {[...Array(10)].map((_, i) => (
                  <div key={i} className="w-px h-full bg-gray-600" />
                ))}
              </div>

              {/* Waveform Bars - OPTIMIZED: Pre-computed once */}
              <div className="absolute top-1/2 left-0 right-0 -translate-y-1/2 h-16 flex items-center justify-center gap-[2px] px-4">
                {waveformBars}
              </div>

              {/* Subtitle Blocks on Timeline */}
              <div className="absolute top-2 left-4 right-4 h-6 flex gap-1">
                {subtitles.slice(0, 5).map((s, idx) => {
                  // Deterministic width based on subtitle id to avoid hydration mismatch
                  const baseWidth = 10 + ((s.id * 7) % 15);
                  return (
                    <div
                      key={s.id}
                      onClick={() => setActiveSubtitleId(s.id)}
                      className={`h-full rounded text-[9px] flex items-center justify-center truncate px-2 cursor-pointer transition-all ${s.id === activeSubtitleId
                        ? 'bg-[#137fec]/40 border border-[#137fec] text-white shadow-[0_0_10px_rgba(19,127,236,0.3)]'
                        : 'bg-gray-700/50 border border-gray-600 text-gray-300 hover:bg-gray-600/50'
                        }`}
                      style={{ width: `${baseWidth}%`, marginLeft: idx === 0 ? '0%' : '0' }}
                    >
                      {s.en.slice(0, 20)}...
                    </div>
                  );
                })}
              </div>

              {/* Playhead */}
              <div
                className="absolute top-0 bottom-0 w-px bg-red-500 z-10 shadow-[0_0_8px_rgba(239,68,68,0.8)]"
                style={{ left: '50%' }}
              >
                <div className="absolute -top-0 -left-[5px] border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-red-500" />
              </div>
            </div>

            {/* Timecode Ruler - 모바일에서 숨김 */}
            <div className="hidden md:flex h-6 bg-[#0d1117] border-b border-[#283039] justify-between px-10 text-[10px] font-mono text-gray-500 items-center">
              <span>00:01:20</span>
              <span>00:01:22</span>
              <span className="text-[#137fec] font-bold">{currentTime.split(',')[0]}</span>
              <span>00:01:26</span>
              <span>00:01:28</span>
            </div>

            {/* Tab Bar with Sync Controls - Mobile Optimized */}
            <div className="h-10 md:h-12 border-b border-[#283039] flex items-center justify-between px-3 md:px-6 gap-2">
              {/* Left: Tabs */}
              <div className="flex items-center gap-2 md:gap-4">
                <button className="text-[9px] md:text-[10px] font-black tracking-widest text-[#137fec] flex items-center gap-1 uppercase">
                  <Sliders size={10} className="md:w-3 md:h-3" /> Sync
                </button>
                <button className="hidden md:flex text-[10px] font-black tracking-widest text-gray-500 hover:text-white items-center gap-1 uppercase transition-colors">
                  <Wand2 size={12} /> Batch
                </button>
              </div>

              {/* Center: Sync Controls - Compact on mobile */}
              <div className="flex items-center gap-1 md:gap-2 px-1.5 md:px-3 py-1 bg-[#1a232e] rounded-lg border border-[#283039]">
                <button
                  onClick={() => setSyncOffset(syncOffset - 500)}
                  className="w-6 h-6 bg-[#283039] hover:bg-[#137fec] rounded text-white text-xs font-bold transition-colors"
                >-</button>
                <span className="text-[10px] font-mono text-white w-14 text-center">
                  {syncOffset >= 0 ? '+' : ''}{(syncOffset / 1000).toFixed(1)}s
                </span>
                <button
                  onClick={() => setSyncOffset(syncOffset + 500)}
                  className="w-6 h-6 bg-[#283039] hover:bg-[#137fec] rounded text-white text-xs font-bold transition-colors"
                >+</button>
                <button
                  onClick={() => setSyncOffset(0)}
                  className="text-[8px] text-gray-500 hover:text-[#137fec] ml-1 hidden md:block"
                >Reset</button>
              </div>

              {/* Right: Status + Save */}
              <div className="flex items-center gap-2">
                <span className="text-[9px] md:text-[10px] font-mono text-gray-500">
                  {subtitles.length > 0 ? `${translatedCount}/${subtitles.length}` : '-'}
                </span>
                <Save size={14} className="text-[#137fec] cursor-pointer hover:scale-110 transition-transform" onClick={handleExportSrt} />
              </div>
            </div>

            {/* ====== VIRTUALIZED SUBTITLE TABLE ====== */}
            {/* Only renders ~30 visible rows instead of all 1000+ */}
            <div
              className="flex-1 overflow-y-auto custom-scrollbar pb-16 md:pb-0"
              onScroll={(e) => setTableScrollTop(e.currentTarget.scrollTop)}
            >
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-[#111418] z-10">
                  <tr className="text-[9px] text-gray-500 font-black uppercase tracking-widest border-b border-[#283039]">
                    <th className="hidden md:table-cell py-2 px-6 w-16 text-center">#</th>
                    <th className="hidden md:table-cell py-2 px-4 w-36">Timecode</th>
                    <th className="py-2 px-3 md:px-4">Source (EN)</th>
                    <th className="py-2 px-3 md:px-4">Translation (KO)</th>
                    <th className="py-2 px-3 md:px-6 w-10 md:w-20 text-right">✓</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#283039]/50">
                  {/* Virtualization spacer - top */}
                  {visibleSubtitles.offsetY > 0 && (
                    <tr style={{ height: visibleSubtitles.offsetY }}>
                      <td colSpan={5}></td>
                    </tr>
                  )}
                  {/* Only render visible rows */}
                  {visibleSubtitles.items.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => handleSubtitleClick(s.id)}
                      className={`group hover:bg-[#137fec]/5 transition-colors cursor-pointer ${s.id === activeSubtitleId ? 'bg-[#137fec]/10 border-l-2 border-[#137fec]' : ''}`}
                      style={{ height: ROW_HEIGHT }}
                    >
                      <td className={`hidden md:table-cell py-3 px-6 text-[10px] font-mono text-center ${s.id === activeSubtitleId ? 'text-[#137fec] font-bold' : 'text-gray-600'}`}>
                        {s.id}
                      </td>
                      <td className={`hidden md:table-cell py-3 px-4 text-[10px] font-mono ${s.id === activeSubtitleId ? 'text-[#137fec] font-bold' : 'text-gray-400'}`}>
                        {s.start} <br /> {s.end}
                      </td>
                      <td className="py-3 px-3 md:px-4 text-xs text-gray-400 italic max-w-0 overflow-hidden">
                        <div className="truncate">"{s.en}"</div>
                      </td>
                      <td className="py-3 px-3 md:px-4">
                        <input
                          type="text"
                          value={s.ko}
                          onChange={(e) => handleSubtitleEdit(s.id, 'ko', e.target.value)}
                          placeholder="번역을 입력하세요..."
                          className={`w-full bg-transparent border-none p-0 text-xs font-bold focus:outline-none focus:ring-0 ${s.ko ? 'text-white' : 'text-gray-500 italic'}`}
                        />
                      </td>
                      <td className="py-3 px-3 md:px-6 text-right">
                        {s.id === activeSubtitleId ? (
                          <div className="size-4 bg-[#137fec] rounded-full inline-flex items-center justify-center animate-pulse">
                            <CheckCircle2 size={10} className="text-white" />
                          </div>
                        ) : s.ko ? (
                          <CheckCircle2 size={14} className="text-green-500" />
                        ) : (
                          <CheckCircle2 size={14} className="text-gray-700" />
                        )}
                      </td>
                    </tr>
                  ))}
                  {/* Virtualization spacer - bottom */}
                  {visibleSubtitles.totalHeight - visibleSubtitles.offsetY - (visibleSubtitles.items.length * ROW_HEIGHT) > 0 && (
                    <tr style={{ height: visibleSubtitles.totalHeight - visibleSubtitles.offsetY - (visibleSubtitles.items.length * ROW_HEIGHT) }}>
                      <td colSpan={5}></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </main>

        {/* 📱 Mobile Log Panel */}
        {mobileTab === 'log' && (
          <div className={`md:hidden flex-1 flex flex-col overflow-hidden ${isDarkMode ? 'bg-[#111418]' : 'bg-gray-50'}`}>
            {/* Progress Ring (compact) */}
            {(loading || processingProgress > 0) && (
              <div className={`px-4 py-3 border-b ${isDarkMode ? 'border-[#283039] bg-[#0d1117]' : 'border-gray-200 bg-white'} flex items-center gap-3`}>
                <div className="size-3 border-2 border-[#137fec]/30 border-t-[#137fec] rounded-full animate-spin" />
                <div className="flex-1">
                  <div className="flex justify-between text-[10px] mb-1">
                    <span className={isDarkMode ? 'text-gray-400' : 'text-gray-600'}>번역 진행중...</span>
                    <span className="text-[#137fec] font-mono font-bold">{processingProgress}%</span>
                  </div>
                  <div className="h-1.5 bg-[#283039] rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-[#137fec] to-[#4da6ff] transition-all duration-300"
                      style={{ width: `${processingProgress}%` }} />
                  </div>
                </div>
                <span className="text-[10px] text-gray-500 font-mono">{currentBatch}/{totalBatches}</span>
              </div>
            )}
            {/* Metrics */}
            <div className={`px-4 py-2 border-b ${isDarkMode ? 'border-[#283039]' : 'border-gray-200'} grid grid-cols-3 gap-2`}>
              <div className={`${isDarkMode ? 'bg-[#0d1117]' : 'bg-white'} p-2 rounded-lg border ${isDarkMode ? 'border-[#283039]' : 'border-gray-200'} text-center`}>
                <div className="text-[9px] text-gray-500 uppercase mb-0.5">Batch</div>
                <div className="text-sm font-mono font-bold text-[#137fec]">
                  {currentBatch > 0 ? `${currentBatch}/${totalBatches}` : totalBatches > 0 ? `✓${totalBatches}` : '-'}
                </div>
              </div>
              <div className={`${isDarkMode ? 'bg-[#0d1117]' : 'bg-white'} p-2 rounded-lg border ${isDarkMode ? 'border-[#283039]' : 'border-gray-200'} text-center`}>
                <div className="text-[9px] text-gray-500 uppercase mb-0.5">Blocks</div>
                <div className="text-sm font-mono font-bold text-[#137fec]">{subtitles.length || '-'}</div>
              </div>
              <div className={`${isDarkMode ? 'bg-[#0d1117]' : 'bg-white'} p-2 rounded-lg border ${isDarkMode ? 'border-[#283039]' : 'border-gray-200'} text-center`}>
                <div className="text-[9px] text-gray-500 uppercase mb-0.5">Done</div>
                <div className="text-sm font-mono font-bold text-green-400">
                  {subtitles.filter(s => s.ko).length || '-'}
                </div>
              </div>
            </div>
            {/* Logic Gate Log */}
            <div className="flex-1 bg-black m-3 rounded-xl border border-[#283039] p-3 font-mono text-xs overflow-y-auto">
              <div className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2 flex items-center gap-2">
                <Terminal size={10} /> Logic Gate Log
              </div>
              <div className="space-y-1.5 text-gray-400">
                {logMessages.length === 0 ? (
                  <p className="text-gray-600 text-center mt-8">로그가 없습니다</p>
                ) : logMessages.map((msg, idx) => {
                  if (msg.startsWith('➜')) return (
                    <div key={idx}><span className="text-green-500">➜</span> <span className="text-[#137fec]">~init</span> {msg.slice(2).replace('~init', '')}</div>
                  );
                  if (msg.startsWith('[ERROR]')) return <div key={idx} className="text-red-400">{msg}</div>;
                  if (msg.startsWith('[INFO]')) return <div key={idx} className="text-blue-400">{msg}</div>;
                  if (msg.startsWith('⚠')) return <div key={idx}><span className="text-yellow-500">⚠</span> {msg.slice(2)}</div>;
                  if (msg.startsWith('>')) return <div key={idx} className="text-white">{msg}</div>;
                  return <div key={idx} className="text-gray-400">{msg}</div>;
                })}
              </div>
            </div>
          </div>
        )}

        {/* 📱 Mobile Intelligence Panel */}
        {mobileTab === 'intel' && (
          <div className={`md:hidden flex-1 flex flex-col overflow-hidden ${isDarkMode ? 'bg-[#111418]' : 'bg-gray-50'}`}>
            {/* Header */}
            <div className={`px-4 py-3 border-b ${isDarkMode ? 'border-[#283039] bg-[#0d1117]' : 'border-gray-200 bg-white'} flex items-center justify-between`}>
              <h2 className={`font-bold flex items-center gap-2 text-sm ${isDarkMode ? 'text-white' : 'text-gray-900'}`}>
                <Brain size={16} className="text-[#137fec]" />
                번역 전략 & Intelligence
              </h2>
              {strategyBlueprint && (
                <button
                  onClick={() => setShowStrategyModal(true)}
                  className="text-[10px] font-bold text-[#137fec] bg-[#137fec]/10 px-2 py-1 rounded-lg border border-[#137fec]/20 hover:bg-[#137fec]/20 transition-colors"
                >
                  전략 보기
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
              {/* Progress */}
              {(loading || processingProgress > 0) && (
                <div className={`p-3 rounded-xl border ${isDarkMode ? 'bg-[#0d1117] border-[#283039]' : 'bg-white border-gray-200'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <div className="size-2.5 border-2 border-[#137fec]/30 border-t-[#137fec] rounded-full animate-spin" />
                    <span className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">번역 진행중</span>
                    <span className="ml-auto text-sm font-mono font-bold text-[#137fec]">{processingProgress}%</span>
                  </div>
                  <div className="h-2 bg-[#283039] rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-[#137fec] to-[#4da6ff] transition-all duration-300"
                      style={{ width: `${processingProgress}%` }} />
                  </div>
                  <div className="mt-1 text-[10px] text-gray-500 text-right">{currentBatch}/{totalBatches} 배치</div>
                </div>
              )}

              {/* Metrics */}
              <div className="grid grid-cols-3 gap-2">
                <div className={`p-3 rounded-xl border text-center ${isDarkMode ? 'bg-[#0d1117] border-[#283039]' : 'bg-white border-gray-200'}`}>
                  <div className="text-[9px] text-gray-500 uppercase mb-1">Batch</div>
                  <div className="text-sm font-mono font-bold text-[#137fec]">
                    {currentBatch > 0 ? `${currentBatch}/${totalBatches}` : totalBatches > 0 ? `✓${totalBatches}` : '-'}
                  </div>
                </div>
                <div className={`p-3 rounded-xl border text-center ${isDarkMode ? 'bg-[#0d1117] border-[#283039]' : 'bg-white border-gray-200'}`}>
                  <div className="text-[9px] text-gray-500 uppercase mb-1">Blocks</div>
                  <div className="text-sm font-mono font-bold text-[#137fec]">{subtitles.length || '-'}</div>
                </div>
                <div className={`p-3 rounded-xl border text-center ${isDarkMode ? 'bg-[#0d1117] border-[#283039]' : 'bg-white border-gray-200'}`}>
                  <div className="text-[9px] text-gray-500 uppercase mb-1">Done</div>
                  <div className="text-sm font-mono font-bold text-green-400">{subtitles.filter(s => s.ko).length || '-'}</div>
                </div>
              </div>

              {/* Strategy Blueprint Summary */}
              {strategyBlueprint ? (
                <div className="space-y-3">
                  {/* Content Analysis */}
                  <div className={`p-3 rounded-xl border ${isDarkMode ? 'bg-[#0d1117] border-[#283039]' : 'bg-white border-gray-200'}`}>
                    <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                      <Wand2 size={10} /> 콘텐츠 분석
                    </h3>
                    <div className="space-y-1.5">
                      {strategyBlueprint.content_analysis?.estimated_title && (
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-gray-500">제목</span>
                          <span className="text-xs font-bold text-white">{strategyBlueprint.content_analysis.estimated_title}</span>
                        </div>
                      )}
                      {strategyBlueprint.content_analysis?.genre && (
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-gray-500">장르</span>
                          <span className="text-xs text-gray-300">{strategyBlueprint.content_analysis.genre}</span>
                        </div>
                      )}
                      {strategyBlueprint.content_analysis?.mood && (
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] text-gray-500">분위기</span>
                          <span className="text-xs text-gray-300">{strategyBlueprint.content_analysis.mood}</span>
                        </div>
                      )}
                      {strategyBlueprint.content_analysis?.summary && (
                        <p className="text-[11px] text-gray-400 mt-2 leading-relaxed">{strategyBlueprint.content_analysis.summary}</p>
                      )}
                    </div>
                  </div>

                  {/* Persona Matrix */}
                  {strategyBlueprint.character_personas && strategyBlueprint.character_personas.length > 0 && (
                    <div>
                      <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                        <Sliders size={10} /> Persona Matrix
                      </h3>
                      <div className="space-y-2">
                        {strategyBlueprint.character_personas.map((persona, idx) => (
                          <div key={idx} className={`p-3 rounded-xl border ${isDarkMode ? 'bg-[#0d1117] border-[#283039]' : 'bg-white border-gray-200'}`}>
                            <div className="flex items-center gap-2 mb-1">
                              <div className="size-6 bg-gradient-to-br from-[#137fec] to-[#8b5cf6] rounded-md flex items-center justify-center text-white font-bold text-[10px]">
                                {persona.name.charAt(0)}
                              </div>
                              <p className="text-xs font-bold text-white">{persona.name}</p>
                              {persona.gender && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#283039] text-gray-400">{persona.gender}</span>
                              )}
                            </div>
                            <p className="text-[10px] text-[#137fec] font-mono">{persona.speech_style}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Translation Rules */}
                  {strategyBlueprint.translation_rules && strategyBlueprint.translation_rules.length > 0 && (
                    <div className={`p-3 rounded-xl border ${isDarkMode ? 'bg-[#0d1117] border-[#283039]' : 'bg-white border-gray-200'}`}>
                      <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                        <CheckCircle2 size={10} /> 번역 규칙
                      </h3>
                      <ul className="space-y-1.5">
                        {strategyBlueprint.translation_rules.slice(0, 5).map((rule, idx) => (
                          <li key={idx} className="flex items-start gap-2 text-xs text-gray-300">
                            <CheckCircle2 size={12} className="text-green-500 mt-0.5 flex-shrink-0" />
                            {rule}
                          </li>
                        ))}
                        {strategyBlueprint.translation_rules.length > 5 && (
                          <button onClick={() => setShowStrategyModal(true)} className="text-[10px] text-[#137fec] mt-1">
                            +{strategyBlueprint.translation_rules.length - 5}개 더 보기
                          </button>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <div className={`flex flex-col items-center justify-center py-12 gap-3 ${isDarkMode ? 'text-gray-600' : 'text-gray-400'}`}>
                  <Brain size={32} className="opacity-30" />
                  <p className="text-xs text-center">자막 파일을 로드하면<br />AI가 번역 전략을 자동 생성합니다</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 🧠 Right Panel: Intelligence - 모바일에서는 숨김 */}
        {rightPanelCollapsed ? (
          /* Collapsed Strip */
          <aside className="hidden lg:flex w-[40px] bg-[#111418] border-l border-[#283039] flex-col items-center py-4 gap-4">
            <button onClick={() => setRightPanelCollapsed(false)}
              className="text-gray-500 hover:text-[#137fec] transition-colors" title="패널 열기">
              <Brain size={16} />
            </button>

            {/* Vertical Progress */}
            <div className="flex-1 flex flex-col items-center gap-2">
              <span className="text-[9px] font-mono font-bold text-[#137fec]" style={{ writingMode: 'vertical-rl' }}>
                {processingProgress}%
              </span>
              <div className="flex-1 w-1 bg-[#283039] rounded-full overflow-hidden">
                <div className="w-full bg-gradient-to-b from-[#137fec] to-[#4da6ff] transition-all duration-300 rounded-full"
                  style={{ height: `${processingProgress}%` }} />
              </div>
            </div>

            {/* Backend status dot */}
            <div className={`size-2 rounded-full ${backendConnected ? 'bg-green-500' : 'bg-gray-600'}`} />
          </aside>
        ) : (
          /* Expanded Panel */
          <aside className={`hidden lg:flex w-[380px] ${isDarkMode ? 'bg-[#111418] border-[#283039]' : 'bg-gray-50 border-gray-300'} border-l flex-col overflow-hidden transition-colors duration-300`}>
            {/* Panel Header */}
            <div className={`h-12 px-6 border-b ${isDarkMode ? 'border-[#283039] bg-[#0d1117]' : 'border-gray-300 bg-white'} flex items-center justify-between transition-colors duration-300`}>
              <h2 className={`${isDarkMode ? 'text-white' : 'text-gray-900'} font-bold flex items-center gap-2`}>
                <Brain size={18} className="text-[#137fec]" />
                Intelligence
              </h2>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <div className="size-2 rounded-full bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
                  <span className={`text-[10px] font-bold ${backendConnected ? 'text-green-400' : 'text-gray-500'}`}>{backendConnected ? 'READY' : 'OFFLINE'}</span>
                </div>
                <button onClick={() => setRightPanelCollapsed(true)}
                  className="text-gray-500 hover:text-white transition-colors" title="패널 접기">
                  <Minimize2 size={14} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar p-6 flex flex-col gap-8">
              {/* AI Processing Status Ring */}
              <div className="flex flex-col items-center gap-4">
                <div className="relative size-36 flex items-center justify-center">
                  <svg className="size-full -rotate-90" viewBox="0 0 36 36">
                    <path
                      className="text-[#283039]"
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    />
                    <path
                      className="text-[#137fec]"
                      style={{ filter: 'drop-shadow(0 0 6px rgba(19, 127, 236, 0.6))' }}
                      d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                      fill="none"
                      stroke="currentColor"
                      strokeDasharray={`${processingProgress}, 100`}
                      strokeLinecap="round"
                      strokeWidth="2"
                    />
                  </svg>
                  <div className="absolute flex flex-col items-center">
                    <span className="text-3xl font-black text-white font-mono">{processingProgress}%</span>
                    <span className="text-[10px] uppercase tracking-widest text-[#137fec] font-bold">
                      {processingProgress < 100 ? 'Processing' : 'Complete'}
                    </span>
                  </div>
                </div>

                {/* Metrics Grid */}
                <div className="w-full grid grid-cols-2 gap-3">
                  <div className="bg-[#0d1117] p-3 rounded-xl border border-[#283039]">
                    <div className="text-[9px] text-gray-500 font-bold uppercase tracking-widest mb-1">Batch</div>
                    <div className="text-lg font-mono font-bold text-[#137fec]">
                      {currentBatch > 0 ? (
                        <span className="flex items-center gap-1">
                          <span className="text-white">{currentBatch}</span>
                          <span className="text-gray-500">/</span>
                          <span>{totalBatches}</span>
                        </span>
                      ) : totalBatches > 0 ? (
                        <span className="text-green-400">✓ {totalBatches}</span>
                      ) : '-'}
                    </div>
                  </div>
                  <div className="bg-[#0d1117] p-3 rounded-xl border border-[#283039]">
                    <div className="text-[9px] text-gray-500 font-bold uppercase tracking-widest mb-1">Blocks</div>
                    <div className="text-lg font-mono font-bold text-[#137fec]">{subtitles.length > 0 ? subtitles.length : '-'}</div>
                  </div>
                </div>

                {/* Translation Progress Bar */}
                {currentBatch > 0 && (
                  <div className="w-full space-y-2">
                    <div className="flex justify-between text-[10px]">
                      <span className="text-gray-500">번역 진행중...</span>
                      <span className="text-[#137fec] font-mono font-bold">{processingProgress}%</span>
                    </div>
                    <div className="h-2 bg-[#283039] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-[#137fec] to-[#4da6ff] transition-all duration-300"
                        style={{ width: `${processingProgress}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-gray-500 text-center">
                      배치 {currentBatch} / {totalBatches} 처리중
                    </div>
                  </div>
                )}
              </div>

              {/* Persona Matrix */}
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Persona Matrix</h3>
                  <button className="text-[#137fec] hover:text-white text-[10px] font-bold flex items-center gap-1 transition-colors">
                    <Plus size={12} /> 추가
                  </button>
                </div>

                <div className="space-y-2">
                  {strategyBlueprint?.character_personas && strategyBlueprint.character_personas.length > 0 ? (
                    strategyBlueprint.character_personas.map((persona, idx) => (
                      <div key={idx} className="bg-[#1a232e] border border-[#283039] p-3 rounded-xl">
                        <div className="flex items-center gap-2 mb-1">
                          <div className="size-6 bg-gradient-to-br from-[#137fec] to-[#8b5cf6] rounded-md flex items-center justify-center text-white font-bold text-[10px]">
                            {persona.name.charAt(0)}
                          </div>
                          <p className="text-xs font-bold text-white">{persona.name}</p>
                          {persona.gender && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#283039] text-gray-400">{persona.gender}</span>
                          )}
                        </div>
                        <p className="text-[10px] text-[#137fec] font-mono">{persona.speech_style}</p>
                        {persona.relationships && (
                          <p className="text-[9px] text-gray-500 mt-1">{persona.relationships}</p>
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="bg-[#1a232e] p-6 rounded-xl border border-[#283039] text-center">
                      <p className="text-sm text-gray-500">페르소나가 없습니다</p>
                      <p className="text-xs text-gray-600 mt-1">AI 분석 후 자동 생성됩니다</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Logic Gate Log */}
              <div className="flex-1 flex flex-col min-h-[200px]">
                <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-3 flex items-center gap-2">
                  <Terminal size={12} /> Logic Gate Log
                </h3>
                <div className="flex-1 bg-black rounded-xl border border-[#283039] p-4 font-mono text-xs overflow-y-auto shadow-inner max-h-[250px]">
                  <div className="space-y-1.5 text-gray-400">
                    {logMessages.map((msg, idx) => {
                      let colorClass = 'text-gray-400';
                      let prefix = '';

                      if (msg.startsWith('➜')) {
                        return (
                          <div key={idx}>
                            <span className="text-green-500">➜</span> <span className="text-[#137fec]">~init</span> {msg.slice(2).replace('~init', '')}
                          </div>
                        );
                      } else if (msg.startsWith('[OK]')) {
                        colorClass = 'text-gray-600';
                      } else if (msg.startsWith('[ERROR]')) {
                        colorClass = 'text-red-400';
                      } else if (msg.startsWith('[INFO]')) {
                        colorClass = 'text-blue-400';
                      } else if (msg.startsWith('⚠')) {
                        return (
                          <div key={idx}>
                            <span className="text-yellow-500">⚠</span> <span className="text-white">{msg.slice(2)}</span>
                          </div>
                        );
                      } else if (msg.startsWith('>')) {
                        colorClass = 'text-white';
                      } else if (msg.startsWith('  -') || msg.startsWith('  ')) {
                        return <div key={idx} className="pl-4 text-gray-600">{msg.trim()}</div>;
                      }

                      return <div key={idx} className={colorClass}>{msg}</div>;
                    })}
                    <div className="animate-pulse text-[#137fec]">&gt; _</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Action Button */}
            <div className="p-4 border-t border-[#283039] bg-[#0d1117]">
              <button
                onClick={handleBatchTranslate}
                disabled={loading || strategyLoading || subtitles.length === 0}
                className="w-full py-4 bg-[#137fec] hover:bg-[#1589ff] text-white font-black text-sm rounded-xl shadow-[0_0_20px_rgba(19,127,236,0.3)] hover:shadow-[0_0_30px_rgba(19,127,236,0.5)] transition-all active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {strategyLoading ? (
                  <>
                    <div className="size-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    전략 생성 중...
                  </>
                ) : loading ? (
                  <>
                    <div className="size-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    번역 처리 중...
                  </>
                ) : (
                  <>
                    <Activity size={18} />
                    AI 자동 동기화 실행
                  </>
                )}
              </button>
            </div>
          </aside>
        )}
      </div>

      {/* ⚡ Global Command Bar */}
      <div className="h-14 bg-[#1a232e] border-t border-[#283039] px-6 flex items-center justify-between">
        <div className="flex items-center gap-10">
          <div className="flex flex-col">
            <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest">Translation Strategy</span>
            <span className="text-xs font-bold text-white flex items-center gap-1.5">
              {metadata?.genre?.length ? metadata.genre.join(' / ') : '장르 미설정'} <div className="size-1.5 rounded-full bg-[#137fec] shadow-neon" />
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest">Progress</span>
            <div className="flex items-center gap-3">
              <div className="w-32 h-1 bg-[#283039] rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#137fec] to-[#8b5cf6] transition-all duration-300"
                  style={{ width: `${processingProgress}%` }}
                />
              </div>
              <span className="text-[10px] font-mono text-gray-400">
                {processingProgress}% {loading && '(Processing...)'}
              </span>
            </div>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest">Subtitles</span>
            <span className="text-xs font-bold text-white">{subtitles.length} blocks loaded</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <button
            onClick={handleExportSrt}
            disabled={subtitles.length === 0}
            className="h-10 px-8 rounded-lg bg-white hover:bg-gray-100 text-[#101922] font-black text-xs flex items-center gap-2 shadow-xl hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
          >
            <Save size={14} /> EXPORT SRT
          </button>
        </div>
      </div>

      {/* ====== CONTEXT MENU (RIGHT-CLICK) ====== */}
      {showContextMenu && (
        <div
          className="fixed bg-[#1a232e] rounded-xl border border-[#283039] py-2 min-w-[220px] z-[99999] shadow-2xl"
          style={{ left: contextMenuPos.x, top: contextMenuPos.y }}
          onClick={() => setShowContextMenu(false)}
        >
          <div className="px-4 py-2 text-xs text-gray-400 border-b border-[#283039] font-bold uppercase tracking-wider">
            🎬 플레이어 옵션
          </div>

          {/* Audio Tracks */}
          <div className="px-4 py-2 text-xs text-gray-500 font-bold">오디오 트랙</div>
          {audioTracks.length > 0 ? (
            audioTracks.map((track) => (
              <button
                key={track.id}
                onClick={() => selectAudioTrack(track.id)}
                className={`w-full px-4 py-2 text-sm text-left hover:bg-[#137fec]/20 transition flex items-center gap-2 ${currentAudioTrack === track.id ? 'text-[#137fec]' : 'text-white'
                  }`}
              >
                {currentAudioTrack === track.id && <CheckCircle2 size={14} />}
                <span>{track.label}</span>
                <span className="text-gray-500 text-xs ml-auto">{track.language}</span>
              </button>
            ))
          ) : (
            <div className="px-4 py-2 text-sm text-gray-600">기본 오디오</div>
          )}

          <div className="border-t border-[#283039] my-2" />

          {/* Playback Speed */}
          <div className="px-4 py-2 text-xs text-gray-500 font-bold">재생 속도</div>
          <div className="flex flex-wrap gap-1 px-4 py-1">
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map(speed => (
              <button
                key={speed}
                onClick={() => setSpeed(speed)}
                className={`px-2 py-1 text-xs rounded ${playbackSpeed === speed ? 'bg-[#137fec] text-white' : 'bg-[#283039] text-gray-400 hover:text-white'
                  }`}
              >
                {speed}x
              </button>
            ))}
          </div>

          <div className="border-t border-[#283039] my-2" />

          {/* Quick Actions */}
          <button
            onClick={togglePiP}
            className="w-full px-4 py-2 text-sm text-left hover:bg-[#137fec]/20 text-white flex items-center gap-2"
          >
            <PictureInPicture2 size={14} /> PIP 모드
          </button>
          <button
            onClick={toggleFullscreen}
            className="w-full px-4 py-2 text-sm text-left hover:bg-[#137fec]/20 text-white flex items-center gap-2"
          >
            <Maximize2 size={14} /> 전체화면
          </button>
        </div>
      )}

      {/* ====== SETTINGS MODAL ====== */}
      {showSettingsModal && (
        <div className="fixed inset-0 bg-black/80 z-[99999] flex items-center justify-center" onClick={() => setShowSettingsModal(false)}>
          <div className="bg-[#111418] rounded-2xl border border-[#283039] w-[500px] max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-[#283039] flex items-center justify-between">
              <h2 className="text-white font-bold text-lg flex items-center gap-2">
                <Settings size={20} className="text-[#137fec]" /> 설정
              </h2>
              <button onClick={() => setShowSettingsModal(false)} className="text-gray-500 hover:text-white">
                <X size={20} />
              </button>
            </div>

            <div className="p-6 space-y-6 overflow-y-auto max-h-[60vh]">
              {/* Subtitle Settings */}
              <div className="space-y-4">
                <h3 className="text-sm font-bold text-[#137fec] uppercase tracking-wider">자막 설정</h3>

                <div className="space-y-2">
                  <label className="text-xs text-gray-400">자막 크기</label>
                  <div className="flex items-center gap-4">
                    <input
                      type="range"
                      min="50"
                      max="200"
                      value={subtitleFontSize}
                      onChange={(e) => setSubtitleFontSize(parseInt(e.target.value))}
                      className="flex-1 h-2 bg-[#283039] rounded-lg appearance-none cursor-pointer accent-[#137fec]"
                    />
                    <span className="text-white font-mono text-sm w-12">{subtitleFontSize}%</span>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-xs text-gray-400">자막 위치 (하단에서)</label>
                  <div className="flex items-center gap-4">
                    <input
                      type="range"
                      min="5"
                      max="30"
                      value={subtitlePosition}
                      onChange={(e) => setSubtitlePosition(parseInt(e.target.value))}
                      className="flex-1 h-2 bg-[#283039] rounded-lg appearance-none cursor-pointer accent-[#137fec]"
                    />
                    <span className="text-white font-mono text-sm w-12">{subtitlePosition}%</span>
                  </div>
                </div>
              </div>

              {/* Player Settings */}
              <div className="space-y-4">
                <h3 className="text-sm font-bold text-[#137fec] uppercase tracking-wider">플레이어 설정</h3>

                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-300">자동 재생</span>
                  <button className="w-12 h-6 bg-[#283039] rounded-full relative">
                    <div className="absolute left-1 top-1 w-4 h-4 bg-gray-500 rounded-full" />
                  </button>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-300">전체화면 컨트롤 자동 숨김</span>
                  <button className="w-12 h-6 bg-[#137fec] rounded-full relative">
                    <div className="absolute right-1 top-1 w-4 h-4 bg-white rounded-full" />
                  </button>
                </div>
              </div>

              {/* Keyboard Shortcuts */}
              <div className="space-y-4">
                <h3 className="text-sm font-bold text-[#137fec] uppercase tracking-wider">키보드 단축키</h3>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="flex justify-between bg-[#1a232e] p-2 rounded"><span className="text-gray-400">재생/일시정지</span><kbd className="text-[#137fec]">Space</kbd></div>
                  <div className="flex justify-between bg-[#1a232e] p-2 rounded"><span className="text-gray-400">10초 뒤로</span><kbd className="text-[#137fec]">←</kbd></div>
                  <div className="flex justify-between bg-[#1a232e] p-2 rounded"><span className="text-gray-400">10초 앞으로</span><kbd className="text-[#137fec]">→</kbd></div>
                  <div className="flex justify-between bg-[#1a232e] p-2 rounded"><span className="text-gray-400">30초 뒤로</span><kbd className="text-[#137fec]">↓</kbd></div>
                  <div className="flex justify-between bg-[#1a232e] p-2 rounded"><span className="text-gray-400">30초 앞으로</span><kbd className="text-[#137fec]">↑</kbd></div>
                  <div className="flex justify-between bg-[#1a232e] p-2 rounded"><span className="text-gray-400">전체화면</span><kbd className="text-[#137fec]">F</kbd></div>
                  <div className="flex justify-between bg-[#1a232e] p-2 rounded"><span className="text-gray-400">음소거</span><kbd className="text-[#137fec]">M</kbd></div>
                  <div className="flex justify-between bg-[#1a232e] p-2 rounded"><span className="text-gray-400">PIP 모드</span><kbd className="text-[#137fec]">P</kbd></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ====== HISTORY MODAL ====== */}
      {showHistoryModal && (
        <div className="fixed inset-0 bg-black/80 z-[99999] flex items-center justify-center" onClick={() => setShowHistoryModal(false)}>
          <div className="bg-[#111418] rounded-2xl border border-[#283039] w-[600px] max-h-[80vh] overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-[#283039] flex items-center justify-between">
              <h2 className="text-white font-bold text-lg flex items-center gap-2">
                <Bell size={20} className="text-[#137fec]" /> 번역 히스토리
              </h2>
              <button onClick={() => setShowHistoryModal(false)} className="text-gray-500 hover:text-white">
                <X size={20} />
              </button>
            </div>

            <div className="p-4 overflow-y-auto max-h-[60vh]">
              {translationHistory.length > 0 ? (
                <div className="space-y-2">
                  {translationHistory.map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between bg-[#1a232e] p-4 rounded-xl border border-[#283039] hover:border-[#137fec]/50 transition">
                      <div className="flex-1">
                        <div className="text-white font-medium text-sm">{item.title || item.id}</div>
                        <div className="text-gray-500 text-xs mt-1">
                          {item.date} • {item.count || '?'} blocks
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => downloadTranslation(item.id)}
                          className="px-3 py-1.5 bg-[#137fec] text-white text-xs font-bold rounded-lg hover:bg-[#137fec]/80 transition"
                        >
                          다운로드
                        </button>
                        <button
                          onClick={() => deleteTranslation(item.id)}
                          className="px-3 py-1.5 bg-red-500/20 text-red-400 text-xs font-bold rounded-lg hover:bg-red-500/30 transition"
                        >
                          삭제
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <Bell size={48} className="text-gray-700 mx-auto mb-4" />
                  <p className="text-gray-500">저장된 번역이 없습니다</p>
                  <p className="text-gray-600 text-sm mt-2">번역을 완료하면 자동으로 저장됩니다</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ====== MOBILE BOTTOM STATUS BAR ====== */}
      {/* 모바일 하단 상태바 - 번역 진행 상태 및 현재 시간 */}
      {subtitles.length > 0 && (
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-[9999] bg-[#0d1117]/95 backdrop-blur-sm border-t border-[#283039] px-4 py-2">
          <div className="flex items-center justify-between">
            {/* 번역 진행률 */}
            <div className="flex items-center gap-2">
              <div className="w-24 h-1.5 bg-[#283039] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#137fec] transition-all duration-300"
                  style={{ width: `${subtitles.length > 0 ? (subtitles.filter(s => s.ko && s.ko.trim()).length / subtitles.length) * 100 : 0}%` }}
                />
              </div>
              <span className="text-[10px] text-gray-400 font-mono">
                {subtitles.filter(s => s.ko && s.ko.trim()).length}/{subtitles.length}
              </span>
            </div>
            {/* 현재 시간 / 저장 버튼 */}
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-[#137fec] font-mono">{currentTime.split(',')[0]}</span>
              <button
                onClick={handleExportSrt}
                className="p-1.5 bg-[#137fec]/20 rounded-lg text-[#137fec] hover:bg-[#137fec]/30 transition-colors"
              >
                <Save size={14} />
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
