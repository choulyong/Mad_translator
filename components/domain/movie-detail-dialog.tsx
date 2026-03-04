"use client";

import Image from "next/image";
import { Film, X, Trash2, Save, Pencil, Star, Clock, Clapperboard, Users, Award, ExternalLink, Play, Pause, DollarSign, Globe, PenTool, Subtitles, Search, Download, Loader2, Rewind, FastForward, Volume2, VolumeX, Maximize2, Minimize2, PictureInPicture2, Gauge, RefreshCw, Languages, Sparkles, FolderOutput } from "lucide-react";
import type { Movie } from "@/lib/db/schema";
import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { updateMovie, searchOnlineSubtitles, downloadOnlineSubtitle, searchMoviesForReidentify, reidentifyMovie, scanSubtitlesSingle, deleteSubtitleFile, enrichMovie, resetAndEnrichMovie, readSubtitleFile, moveMovieFolder } from "@/app/actions";
import type { MovieMetadata } from "@/lib/types";
import { toast } from "sonner";

interface OnlineSubtitle {
  id: string;
  fileName: string;
  language: string;
  languageCode: string;
  source: "opensubtitles" | "subdl";
  downloadId: string;
  rating?: number;
  downloadCount?: number;
  hearingImpaired?: boolean;
  release?: string;
}

interface MovieDetailDialogProps {
  movie: Movie | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete?: (id: string) => void;
  onUpdate?: () => void;
}

export function MovieDetailDialog({
  movie,
  open,
  onOpenChange,
  onDelete,
  onUpdate,
}: MovieDetailDialogProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editOverview, setEditOverview] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxAlt, setLightboxAlt] = useState("");
  const [subSearching, setSubSearching] = useState(false);
  const [subResults, setSubResults] = useState<OnlineSubtitle[]>([]);
  const [subDownloading, setSubDownloading] = useState<string | null>(null);
  const [showSubSearch, setShowSubSearch] = useState(false);
  const [showPlayer, setShowPlayer] = useState(false);
  const [showReidentify, setShowReidentify] = useState(false);
  const [reSearchQuery, setReSearchQuery] = useState("");
  const [reSearchResults, setReSearchResults] = useState<MovieMetadata[]>([]);
  const [reSearching, setReSearching] = useState(false);
  const [reidentifying, setReidentifying] = useState<number | null>(null);
  const [subtitleRefreshing, setSubtitleRefreshing] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [deletingSub, setDeletingSub] = useState<string | null>(null);
  const [subDeleteConfirm, setSubDeleteConfirm] = useState<{ filePath: string; fileName: string } | null>(null);
  const [expandedSub, setExpandedSub] = useState<string | null>(null);
  const [expandedSubContent, setExpandedSubContent] = useState<string | null>(null);
  const [loadingSub, setLoadingSub] = useState(false);
  const [showMoveFolder, setShowMoveFolder] = useState(false);
  const [moveFolderDest, setMoveFolderDest] = useState("");
  const [movingFolder, setMovingFolder] = useState(false);

  useEffect(() => {
    if (!open) {
      setEditing(false);
      setConfirmDelete(false);
      setLightboxSrc(null);
      setShowSubSearch(false);
      setSubResults([]);
      setShowPlayer(false);
      setShowReidentify(false);
      setReSearchResults([]);
      setReidentifying(null);
      setShowMoveFolder(false);
      setMoveFolderDest("");
      return;
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showPlayer) {
          setShowPlayer(false);
        } else if (lightboxSrc) {
          setLightboxSrc(null);
        } else {
          onOpenChange(false);
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onOpenChange, lightboxSrc, showPlayer]);

  useEffect(() => {
    if (movie) {
      setEditTitle(movie.title);
      setEditOverview(movie.overview || "");
      setReSearchQuery(movie.title);
    }
  }, [movie]);

  if (!open || !movie) return null;

  const year = movie.releaseDate ? new Date(movie.releaseDate).getFullYear() : null;
  const genres: string[] = movie.genres ? JSON.parse(movie.genres) : [];
  const castList: string[] = movie.cast ? JSON.parse(movie.cast) : [];
  const castProfiles: { name: string; character: string; profilePath: string | null }[] =
    movie.castProfiles ? JSON.parse(movie.castProfiles) : [];
  const countries: string[] = movie.productionCountries ? JSON.parse(movie.productionCountries) : [];
  const subtitleFiles: { fileName: string; filePath: string; language: "ko" | "en" | "unknown"; preview: string }[] =
    movie.subtitleFiles ? JSON.parse(movie.subtitleFiles) : [];

  /** 텍스트를 표시용 문단 배열로 분리 */
  const splitParagraphs = (text: string): string[] => {
    if (!text) return [];
    // 이중 개행 → 문단 분리
    if (text.includes('\n\n')) {
      return text.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
    }
    // 단일 개행 → 줄 분리
    if (text.includes('\n')) {
      return text.split('\n').map(p => p.trim()).filter(Boolean);
    }
    // 개행 없음 → 문장 부호 기준으로 3문장씩 문단 그룹핑
    const parts = text.split(/(?<=[.!?。！？])\s+/);
    if (parts.length <= 2) return [text];
    const groups: string[] = [];
    for (let i = 0; i < parts.length; i += 3) {
      const chunk = parts.slice(i, i + 3).join(' ').trim();
      if (chunk) groups.push(chunk);
    }
    return groups.length > 0 ? groups : [text];
  };

  const formatMoney = (v: number | null) => {
    if (!v || v === 0) return null;
    if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(1)}B`;
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
    return `$${v.toLocaleString()}`;
  };

  const formattedDate = movie.createdAt
    ? new Date(movie.createdAt).toLocaleDateString("ko-KR", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  const handleSave = async () => {
    const result = await updateMovie(movie.id, {
      title: editTitle,
      overview: editOverview,
    });
    if (result.success) {
      toast.success("수정 완료");
      setEditing(false);
      onUpdate?.();
    } else {
      toast.error(result.error ?? "수정 실패");
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
        onClick={() => onOpenChange(false)}
      />

      <div className="fixed inset-2 md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:max-w-xl md:w-full md:max-h-[85vh] bg-surface-dark border border-border-dark rounded-xl z-50 md:mx-4 flex flex-col">
        {/* Top buttons - always visible above scroll */}
        <div className="absolute top-3 right-3 flex items-center gap-1 z-20">
          {!editing && onDelete && (
            <>
              <button
                onClick={() => setEditing(true)}
                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
                title="수정"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                onClick={async () => {
                  setSubtitleRefreshing(true);
                  const result = await scanSubtitlesSingle(movie.id);
                  if (result.success) {
                    toast.success(`자막 동기화 완료 (${result.data?.found || 0}개 발견)`);
                    onUpdate?.();
                  } else {
                    toast.error(result.error ?? "자막 동기화 실패");
                  }
                  setSubtitleRefreshing(false);
                }}
                disabled={subtitleRefreshing}
                className={`p-1.5 rounded-md transition-colors ${subtitleRefreshing ? "text-sky-400 bg-sky-500/10" : "text-zinc-500 hover:text-sky-400 hover:bg-sky-500/10"}`}
                title="자막 새로고침"
              >
                <Subtitles className={`w-4 h-4 ${subtitleRefreshing ? "animate-pulse" : ""}`} />
              </button>
              <button
                onClick={() => setShowMoveFolder((v) => !v)}
                className={`p-1.5 rounded-md transition-colors ${showMoveFolder ? "text-orange-400 bg-orange-500/10" : "text-zinc-500 hover:text-orange-400 hover:bg-orange-500/10"}`}
                title="폴더 이동"
              >
                <FolderOutput className="w-4 h-4" />
              </button>
              <button
                onClick={() => setShowReidentify((v) => !v)}
                className={`p-1.5 rounded-md transition-colors ${showReidentify ? "text-primary bg-primary/10" : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"}`}
                title="재탐색"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
              {confirmDelete ? (
                <button
                  onClick={() => {
                    onDelete(movie.id);
                    setConfirmDelete(false);
                  }}
                  className="px-2 py-1 text-[11px] font-medium text-red-400 bg-red-500/10 border border-red-500/20 rounded hover:bg-red-500/20 transition-colors"
                >
                  삭제 확인
                </button>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="p-1.5 rounded-md text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  title="삭제"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </>
          )}
          <button
            onClick={() => onOpenChange(false)}
            className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable content area */}
        <div className="overflow-y-auto flex-1 rounded-xl">
        {/* Backdrop banner */}
        {movie.backdropPath && (
          <div className="relative w-full h-36 overflow-hidden rounded-t-xl">
            <Image
              src={`https://image.tmdb.org/t/p/w780${movie.backdropPath}`}
              alt=""
              fill
              sizes="600px"
              className="object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-surface-dark via-surface-dark/50 to-transparent" />
          </div>
        )}

        <div className={movie.backdropPath ? "px-6 pb-6 -mt-12 relative" : "p-6"}>
        {/* Header */}
        <div className="flex gap-6">
          <div
            className={`w-32 aspect-[2/3] rounded-lg overflow-hidden flex-shrink-0 relative bg-surface-darker ${movie.posterPath ? "cursor-zoom-in" : ""}`}
            onClick={() => {
              if (movie.posterPath) {
                setLightboxSrc(`https://image.tmdb.org/t/p/original${movie.posterPath}`);
                setLightboxAlt(movie.title);
              }
            }}
          >
            {movie.posterPath ? (
              <Image
                src={`https://image.tmdb.org/t/p/w342${movie.posterPath}`}
                alt={movie.title}
                fill
                sizes="128px"
                className="object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Film className="w-8 h-8 text-zinc-700" />
              </div>
            )}
            {/* Play button overlay on poster */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setShowPlayer(true);
              }}
              className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 hover:opacity-100 transition-opacity rounded-lg"
              title="영화 재생"
            >
              <div className="w-12 h-12 rounded-full bg-primary/90 flex items-center justify-center shadow-lg shadow-primary/30">
                <Play className="w-6 h-6 text-white fill-white ml-0.5" />
              </div>
            </button>
          </div>

          <div className="flex-1 min-w-0">
            {editing ? (
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full bg-surface-darker border border-border-dark rounded px-2 py-1 text-lg font-bold text-zinc-100 focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            ) : (
              <h2 className="text-xl font-bold text-zinc-100 leading-tight">
                {movie.title}
              </h2>
            )}
            {movie.tagline && (
              <p className="text-xs text-zinc-500 italic mt-1">&ldquo;{movie.tagline}&rdquo;</p>
            )}
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {year && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-zinc-800 text-zinc-300">
                  {year}
                </span>
              )}
              {movie.rating && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  <Star className="w-3 h-3" />
                  {Number(movie.rating).toFixed(1)}
                </span>
              )}
              {movie.runtime && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-zinc-800 text-zinc-400">
                  <Clock className="w-3 h-3" />
                  {movie.runtime}분
                </span>
              )}
              {movie.rated && (
                <span className="px-2 py-0.5 rounded text-xs font-bold bg-orange-500/10 text-orange-400 border border-orange-500/20">
                  {movie.rated}
                </span>
              )}
            </div>
            {/* External Ratings */}
            {(movie.imdbRating || movie.rottenTomatoes || movie.metacritic) && (
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {movie.imdbRating && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                    IMDb {movie.imdbRating}
                  </span>
                )}
                {movie.rottenTomatoes && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-red-500/10 text-red-400 border border-red-500/20">
                    RT {movie.rottenTomatoes}
                  </span>
                )}
                {movie.metacritic && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold bg-blue-500/10 text-blue-400 border border-blue-500/20">
                    MC {movie.metacritic}
                  </span>
                )}
              </div>
            )}
            {genres.length > 0 && (
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                {genres.map((g) => (
                  <span key={g} className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-zinc-800/80 text-zinc-400 border border-zinc-700/50">
                    {g}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Move Folder Panel */}
        {showMoveFolder && !editing && (
          <div className="mt-4 border border-orange-500/30 rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-orange-500/5 flex items-center gap-2">
              <FolderOutput className="w-3.5 h-3.5 text-orange-400" />
              <span className="text-xs font-medium text-orange-400">폴더 이동</span>
            </div>
            <div className="p-3">
              <p className="text-[11px] text-zinc-500 mb-2">
                현재 위치: <span className="text-zinc-400 font-mono">{movie.filePath.substring(0, movie.filePath.lastIndexOf("\\")) || movie.filePath.substring(0, movie.filePath.lastIndexOf("/"))}</span>
              </p>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!moveFolderDest.trim() || movingFolder) return;
                  setMovingFolder(true);
                  const result = await moveMovieFolder(movie.id, moveFolderDest.trim());
                  if (result.success) {
                    toast.success("폴더 이동 완료");
                    setShowMoveFolder(false);
                    setMoveFolderDest("");
                    onUpdate?.();
                  } else {
                    toast.error(result.error ?? "이동 실패");
                  }
                  setMovingFolder(false);
                }}
                className="flex gap-2"
              >
                <input
                  value={moveFolderDest}
                  onChange={(e) => setMoveFolderDest(e.target.value)}
                  placeholder="목적지 경로 (예: //192.168.0.2/torrent/movies)"
                  className="flex-1 bg-surface-darker border border-border-dark rounded px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-orange-500/50 font-mono"
                />
                <button
                  type="submit"
                  disabled={movingFolder || !moveFolderDest.trim()}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-orange-500 rounded hover:bg-orange-600 transition-colors disabled:opacity-50 flex items-center gap-1"
                >
                  {movingFolder ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderOutput className="w-3.5 h-3.5" />}
                  이동
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Re-identify Panel */}
        {showReidentify && !editing && (
          <div className="mt-4 border border-primary/30 rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-primary/5 flex items-center gap-2">
              <RefreshCw className="w-3.5 h-3.5 text-primary" />
              <span className="text-xs font-medium text-primary">영화 재탐색</span>
            </div>
            <div className="p-3">
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!reSearchQuery.trim() || reSearching) return;
                  setReSearching(true);
                  setReSearchResults([]);
                  const result = await searchMoviesForReidentify(reSearchQuery.trim());
                  if (result.success && result.data) {
                    setReSearchResults(result.data);
                    if (result.data.length === 0) toast.info("검색 결과가 없습니다");
                  } else {
                    toast.error(result.error ?? "검색 실패");
                  }
                  setReSearching(false);
                }}
                className="flex gap-2"
              >
                <input
                  value={reSearchQuery}
                  onChange={(e) => setReSearchQuery(e.target.value)}
                  placeholder="영화 제목을 입력하세요..."
                  className="flex-1 bg-surface-darker border border-border-dark rounded px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
                <button
                  type="submit"
                  disabled={reSearching || !reSearchQuery.trim()}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded hover:bg-primary-dark transition-colors disabled:opacity-50 flex items-center gap-1"
                >
                  {reSearching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                  검색
                </button>
              </form>

              {/* Search Results */}
              {reSearchResults.length > 0 && (
                <div className="mt-3 max-h-64 overflow-y-auto space-y-2">
                  {reSearchResults.map((r) => {
                    const isApplying = reidentifying === r.tmdbId;
                    return (
                      <button
                        key={r.tmdbId}
                        disabled={reidentifying !== null}
                        onClick={async () => {
                          if (!confirm(`"${r.title} (${r.year || "연도 불명"})"(으)로 변경하시겠습니까?`)) return;
                          setReidentifying(r.tmdbId);
                          const result = await reidentifyMovie(movie.id, r.tmdbId);
                          if (result.success) {
                            toast.success("영화 정보가 갱신되었습니다");
                            setShowReidentify(false);
                            setReSearchResults([]);
                            onUpdate?.();
                          } else {
                            toast.error(result.error ?? "재식별 실패");
                          }
                          setReidentifying(null);
                        }}
                        className={`w-full flex gap-3 p-2 rounded-lg text-left transition-colors ${
                          isApplying
                            ? "bg-primary/10 border border-primary/30"
                            : "hover:bg-surface-darker border border-transparent hover:border-border-dark"
                        } disabled:opacity-50`}
                      >
                        {/* Poster thumbnail */}
                        <div className="w-[45px] h-[67px] rounded overflow-hidden flex-shrink-0 bg-surface-darker relative">
                          {r.posterPath ? (
                            <Image
                              src={`https://image.tmdb.org/t/p/w92${r.posterPath}`}
                              alt={r.title}
                              fill
                              sizes="45px"
                              className="object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Film className="w-4 h-4 text-zinc-700" />
                            </div>
                          )}
                        </div>
                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-zinc-200 truncate">
                            {r.title}
                            {r.year && <span className="text-zinc-500 font-normal ml-1">({r.year})</span>}
                          </p>
                          {r.overview && (
                            <p className="text-[11px] text-zinc-500 leading-relaxed mt-0.5 line-clamp-2">
                              {r.overview}
                            </p>
                          )}
                          <span className="text-[10px] text-zinc-600 mt-0.5 block">TMDB ID: {r.tmdbId}</span>
                        </div>
                        {/* Loading indicator */}
                        {isApplying && (
                          <div className="flex items-center shrink-0">
                            <Loader2 className="w-4 h-4 animate-spin text-primary" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* No results */}
              {!reSearching && reSearchResults.length === 0 && reSearchQuery && (
                <p className="text-[11px] text-zinc-600 mt-2 text-center">검색 버튼을 눌러 TMDB에서 검색하세요</p>
              )}
            </div>
          </div>
        )}

        {/* Overview */}
        {editing ? (
          <textarea
            value={editOverview}
            onChange={(e) => setEditOverview(e.target.value)}
            rows={3}
            className="w-full mt-4 bg-surface-darker border border-border-dark rounded px-3 py-2 text-sm text-zinc-300 focus:outline-none focus:ring-1 focus:ring-primary/50 resize-none"
            placeholder="줄거리..."
          />
        ) : (
          (movie.plotFullKo || movie.plotFull || movie.overview) && (
            <div className="mt-4 space-y-2">
              {splitParagraphs(movie.plotFullKo || movie.plotFull || movie.overview || '').map((para, i) => (
                <p key={i} className="text-sm text-zinc-400 leading-relaxed whitespace-pre-line">
                  {para}
                </p>
              ))}
            </div>
          )
        )}

        {/* Wiki Summary (영화 개요) */}
        {!editing && movie.wikiOverview && (
          <div className="mt-4">
            <div className="flex items-center gap-1.5 mb-1.5">
              <Globe className="w-3.5 h-3.5 text-emerald-500" />
              <span className="text-[11px] font-medium text-emerald-400">Summary</span>
            </div>
            <div className="space-y-1.5">
              {splitParagraphs(movie.wikiOverview).map((para, i) => (
                <p key={i} className="text-xs text-zinc-500 leading-relaxed whitespace-pre-line">
                  {para}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Enrich: 개별 보강 버튼 — 항상 표시 */}
        {!editing && (
          <div className="flex flex-wrap gap-2 mt-3">
            <button
              onClick={async () => {
                setEnriching(true);
                const result = await enrichMovie(movie.id);
                if (result.success) {
                  toast.success(result.error || "데이터 보강 완료");
                  onUpdate?.();
                } else {
                  toast.error(result.error ?? "보강 실패");
                }
                setEnriching(false);
              }}
              disabled={enriching}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg hover:bg-amber-500/20 transition-colors disabled:opacity-50"
            >
              <Sparkles className={`w-3.5 h-3.5 ${enriching ? "animate-pulse" : ""}`} />
              {enriching ? "보강 중..." : "데이터 보강 (줄거리 한글 번역)"}
            </button>

            <button
              onClick={async () => {
                setEnriching(true);
                const result = await resetAndEnrichMovie(movie.id);
                if (result.success) {
                  toast.success("한글 번역 재실행 완료");
                  onUpdate?.();
                } else {
                  toast.error(result.error ?? "재번역 실패");
                }
                setEnriching(false);
              }}
              disabled={enriching}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-400 bg-purple-500/10 border border-purple-500/20 rounded-lg hover:bg-purple-500/20 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${enriching ? "animate-spin" : ""}`} />
              {enriching ? "재번역 중..." : "한글 번역 재실행"}
            </button>
          </div>
        )}

        {/* Trailer */}
        {!editing && movie.trailerUrl && (
          <a
            href={movie.trailerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 text-xs font-medium text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg hover:bg-red-500/20 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            예고편 보기
          </a>
        )}

        {/* Director & Writer */}
        {!editing && (movie.director || movie.writer) && (
          <div className="mt-4 space-y-2">
            {movie.director && (
              <div className="flex items-start gap-2">
                <Clapperboard className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" />
                <div>
                  <span className="text-[11px] text-zinc-500 block">감독</span>
                  <span className="text-sm text-zinc-300">{movie.director}</span>
                </div>
              </div>
            )}
            {movie.writer && (
              <div className="flex items-start gap-2">
                <PenTool className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" />
                <div>
                  <span className="text-[11px] text-zinc-500 block">각본</span>
                  <span className="text-sm text-zinc-300">{movie.writer}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Cast Profiles with Photos */}
        {!editing && castProfiles.length > 0 && (
          <div className="mt-4">
            <div className="flex items-center gap-1.5 mb-2">
              <Users className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-[11px] text-zinc-500">출연진</span>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin -mx-2 px-2">
              {castProfiles.map((actor, i) => (
                <div key={i} className="flex flex-col items-center gap-1 shrink-0 w-16">
                  <div
                    className={`w-14 h-14 rounded-full overflow-hidden bg-zinc-800 border border-zinc-700 ${actor.profilePath ? "cursor-zoom-in hover:border-primary/50 hover:ring-2 hover:ring-primary/20 transition-all" : ""}`}
                    onClick={() => {
                      if (actor.profilePath) {
                        setLightboxSrc(`https://image.tmdb.org/t/p/h632${actor.profilePath}`);
                        setLightboxAlt(actor.name);
                      }
                    }}
                  >
                    {actor.profilePath ? (
                      <Image
                        src={`https://image.tmdb.org/t/p/w185${actor.profilePath}`}
                        alt={actor.name}
                        width={56}
                        height={56}
                        className="object-cover w-full h-full"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-zinc-600 text-lg font-bold">
                        {actor.name.charAt(0)}
                      </div>
                    )}
                  </div>
                  <span className="text-[10px] text-zinc-300 text-center leading-tight truncate w-full">
                    {actor.name}
                  </span>
                  {actor.character && (
                    <span className="text-[9px] text-zinc-500 text-center leading-tight truncate w-full">
                      {actor.character}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Fallback cast list (no profiles) */}
        {!editing && castProfiles.length === 0 && castList.length > 0 && (
          <div className="flex items-start gap-2 mt-4">
            <Users className="w-3.5 h-3.5 text-zinc-500 mt-0.5 shrink-0" />
            <div>
              <span className="text-[11px] text-zinc-500 block">출연</span>
              <span className="text-sm text-zinc-300">{castList.join(", ")}</span>
            </div>
          </div>
        )}

        {/* Awards */}
        {!editing && movie.awards && (
          <div className="flex items-start gap-2 mt-3">
            <Award className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
            <span className="text-xs text-zinc-400">{movie.awards}</span>
          </div>
        )}

        {/* Financial & Production Info */}
        {!editing && (formatMoney(movie.budget) || formatMoney(movie.revenue) || movie.boxOffice || countries.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {formatMoney(movie.budget) && (
              <div className="flex items-center gap-1">
                <DollarSign className="w-3 h-3 text-zinc-500" />
                <span className="text-[11px] text-zinc-500">제작비</span>
                <span className="text-[11px] text-zinc-300 font-medium">{formatMoney(movie.budget)}</span>
              </div>
            )}
            {formatMoney(movie.revenue) && (
              <div className="flex items-center gap-1">
                <DollarSign className="w-3 h-3 text-emerald-500" />
                <span className="text-[11px] text-zinc-500">수익</span>
                <span className="text-[11px] text-emerald-400 font-medium">{formatMoney(movie.revenue)}</span>
              </div>
            )}
            {movie.boxOffice && (
              <div className="flex items-center gap-1">
                <DollarSign className="w-3 h-3 text-zinc-500" />
                <span className="text-[11px] text-zinc-500">북미 박스오피스</span>
                <span className="text-[11px] text-zinc-300 font-medium">{movie.boxOffice}</span>
              </div>
            )}
            {countries.length > 0 && (
              <div className="flex items-center gap-1">
                <Globe className="w-3 h-3 text-zinc-500" />
                <span className="text-[11px] text-zinc-500">제작</span>
                <span className="text-[11px] text-zinc-300">{countries.join(", ")}</span>
              </div>
            )}
          </div>
        )}

        {/* Subtitles */}
        {!editing && (
          <div className="mt-4">
            <div className="flex items-center gap-1.5 mb-2">
              <Subtitles className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-[11px] text-zinc-500">자막 파일 ({subtitleFiles.length})</span>
              <button
                onClick={async () => {
                  setSubtitleRefreshing(true);
                  const result = await scanSubtitlesSingle(movie.id);
                  if (result.success) {
                    toast.success(`자막 동기화 완료 (${result.data?.found || 0}개 발견)`);
                    onUpdate?.();
                  } else {
                    toast.error(result.error ?? "자막 동기화 실패");
                  }
                  setSubtitleRefreshing(false);
                }}
                disabled={subtitleRefreshing}
                className="ml-auto p-1 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50"
                title="자막 새로고침"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${subtitleRefreshing ? "animate-spin" : ""}`} />
              </button>
            </div>
            {subtitleFiles.length > 0 ? (
              <div className="space-y-2">
                {subtitleFiles.map((sub, i) => {
                  const langLabel = sub.language === "ko" ? "한글" : sub.language === "en" ? "English" : "기타";
                  const langColor = sub.language === "ko" ? "text-sky-400 bg-sky-500/10 border-sky-500/20" : sub.language === "en" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" : "text-zinc-400 bg-zinc-500/10 border-zinc-500/20";
                  const isDeleting = deletingSub === sub.filePath;
                  return (
                    <div key={i} className="border border-border-dark rounded-lg overflow-hidden">
                      <div className="px-3 py-1.5 bg-surface-darker flex items-center justify-between gap-1">
                        <span className="text-[11px] text-zinc-400 truncate font-mono flex-1 mr-1">{sub.fileName}</span>
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold border shrink-0 ${langColor}`}>
                          {langLabel}
                        </span>
                        <button
                          onClick={() => setSubDeleteConfirm({ filePath: sub.filePath, fileName: sub.fileName })}
                          disabled={isDeleting}
                          className="p-0.5 rounded text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 shrink-0"
                          title="자막 삭제"
                        >
                          {isDeleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      {sub.preview && (
                        expandedSub === sub.filePath ? (
                          <div className="relative">
                            <pre className="px-3 py-2 text-[11px] text-zinc-500 leading-relaxed whitespace-pre-wrap max-h-[60vh] overflow-y-auto font-mono bg-zinc-950/50">
                              {loadingSub ? "로딩 중..." : (expandedSubContent || sub.preview)}
                            </pre>
                            <button
                              onClick={() => { setExpandedSub(null); setExpandedSubContent(null); }}
                              className="absolute top-1 right-1 px-2 py-0.5 text-[9px] text-zinc-400 bg-zinc-800 rounded hover:bg-zinc-700 transition-colors"
                            >
                              접기
                            </button>
                          </div>
                        ) : (
                          <pre
                            className="px-3 py-2 text-[11px] text-zinc-500 leading-relaxed whitespace-pre-wrap max-h-24 overflow-hidden font-mono bg-zinc-950/50 cursor-pointer hover:bg-zinc-950/70 transition-colors"
                            onClick={async () => {
                              setExpandedSub(sub.filePath);
                              setLoadingSub(true);
                              const result = await readSubtitleFile(sub.filePath);
                              if (result.success && result.data) {
                                setExpandedSubContent(result.data);
                              }
                              setLoadingSub(false);
                            }}
                            title="클릭하여 전체 보기"
                          >
                            {sub.preview}
                          </pre>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-[11px] text-zinc-600">자막 파일이 없습니다</p>
            )}
          </div>
        )}

        {/* 한글 자막 번역 Button */}
        {!editing && subtitleFiles.some(s => s.language === "en" || s.language === "unknown") && (
          <button
            onClick={() => router.push(`/translate?movieId=${movie.id}`)}
            className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 text-xs font-medium text-sky-400 bg-sky-500/10 border border-sky-500/20 rounded-lg hover:bg-sky-500/20 transition-colors"
          >
            <Languages className="w-3.5 h-3.5" />
            한글 자막 번역
          </button>
        )}

        {/* Online Subtitle Search */}
        {!editing && movie.imdbId && (
          <div className="mt-4">
            {!showSubSearch ? (
              <button
                onClick={async () => {
                  setShowSubSearch(true);
                  setSubSearching(true);
                  const result = await searchOnlineSubtitles(movie.imdbId!);
                  if (result.success && result.data) {
                    setSubResults(result.data);
                    if (result.data.length === 0) toast.info("검색 결과 없음");
                  } else {
                    toast.error(result.error ?? "자막 검색 실패");
                  }
                  setSubSearching(false);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-violet-400 bg-violet-500/10 border border-violet-500/20 rounded-lg hover:bg-violet-500/20 transition-colors"
              >
                <Search className="w-3.5 h-3.5" />
                인터넷에서 자막 검색
              </button>
            ) : (
              <div className="border border-violet-500/20 rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-violet-500/5 flex items-center justify-between">
                  <span className="text-xs font-medium text-violet-400 flex items-center gap-1.5">
                    <Search className="w-3.5 h-3.5" />
                    온라인 자막 검색
                    {subSearching && <Loader2 className="w-3 h-3 animate-spin" />}
                  </span>
                  <div className="flex items-center gap-2">
                    {subResults.length > 0 && (
                      <span className="text-[10px] text-zinc-500">{subResults.length}개 결과</span>
                    )}
                    <button
                      onClick={() => { setShowSubSearch(false); setSubResults([]); }}
                      className="text-zinc-500 hover:text-zinc-300"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {subResults.length > 0 && (
                  <div className="max-h-52 overflow-y-auto divide-y divide-border-dark">
                    {subResults.map((sub) => {
                      const isKo = sub.language.toLowerCase().includes("ko") || sub.languageCode.toLowerCase() === "ko";
                      const isEn = sub.language.toLowerCase().includes("en") || sub.languageCode.toLowerCase() === "en";
                      const langLabel = isKo ? "한글" : isEn ? "EN" : sub.language;
                      const langColor = isKo ? "text-sky-400 bg-sky-500/10" : isEn ? "text-emerald-400 bg-emerald-500/10" : "text-zinc-400 bg-zinc-500/10";
                      const isDownloading = subDownloading === sub.id;

                      return (
                        <div key={`${sub.source}-${sub.id}`} className="px-3 py-2 hover:bg-surface-darker/50 transition-colors">
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-[11px] text-zinc-300 truncate">{sub.release || sub.fileName}</p>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${langColor}`}>{langLabel}</span>
                                <span className="text-[9px] text-zinc-600">{sub.source === "opensubtitles" ? "OpenSub" : "SubDL"}</span>
                                {sub.downloadCount ? (
                                  <span className="text-[9px] text-zinc-600">{sub.downloadCount.toLocaleString()} DL</span>
                                ) : null}
                                {sub.hearingImpaired && (
                                  <span className="text-[9px] text-zinc-600">HI</span>
                                )}
                              </div>
                            </div>
                            <button
                              onClick={async () => {
                                setSubDownloading(sub.id);
                                const result = await downloadOnlineSubtitle(movie.id, sub);
                                if (result.success) {
                                  toast.success("자막 다운로드 완료");
                                  onUpdate?.();
                                } else {
                                  toast.error(result.error ?? "다운로드 실패");
                                }
                                setSubDownloading(null);
                              }}
                              disabled={isDownloading}
                              className="p-1.5 rounded-md text-violet-400 hover:bg-violet-500/20 transition-colors disabled:opacity-50 shrink-0"
                              title="다운로드"
                            >
                              {isDownloading ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <Download className="w-4 h-4" />
                              )}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {!subSearching && subResults.length === 0 && (
                  <div className="px-3 py-4 text-center text-[11px] text-zinc-500">
                    검색 결과가 없습니다
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Wiki link */}
        {!editing && movie.wikiUrl && (
          <a
            href={movie.wikiUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 mt-3 text-xs text-primary/70 hover:text-primary transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
            한국어 위키피디아
          </a>
        )}

        {/* Edit buttons */}
        {editing && (
          <div className="flex justify-end gap-2 mt-3">
            <button
              onClick={() => setEditing(false)}
              className="px-3 py-1.5 text-xs font-medium text-zinc-400 border border-border-dark rounded-lg hover:bg-zinc-800 transition-colors"
            >
              취소
            </button>
            <button
              onClick={handleSave}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary-dark transition-colors"
            >
              <Save className="w-3 h-3" />
              저장
            </button>
          </div>
        )}

        <div className="border-t border-border-dark my-4" />

        {/* File info */}
        <div className="font-mono text-xs grid gap-2">
          <div className="grid grid-cols-[auto_1fr] gap-x-3">
            <span className="text-zinc-500">Original</span>
            <span className="text-zinc-300 truncate">{movie.originalName}</span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3">
            <span className="text-zinc-500">Current</span>
            <span className="text-zinc-300 truncate">{movie.newName}</span>
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3">
            <span className="text-zinc-500">Path</span>
            <span className="text-zinc-300 truncate">{movie.filePath}</span>
          </div>
          {formattedDate && (
            <div className="grid grid-cols-[auto_1fr] gap-x-3">
              <span className="text-zinc-500">Added</span>
              <span className="text-zinc-300">{formattedDate}</span>
            </div>
          )}
        </div>
        </div>
      </div>{/* end scrollable */}
      </div>{/* end main container */}

      {/* Video Player — full-featured */}
      {showPlayer && (
        <VideoPlayer
          movieId={movie.id}
          title={movie.title}
          onClose={() => setShowPlayer(false)}
        />
      )}

      {/* Subtitle delete confirm popup */}
      {subDeleteConfirm && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setSubDeleteConfirm(null)}>
          <div className="bg-surface-dark border border-border-dark rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <p className="text-sm text-zinc-200 font-medium mb-1">자막 삭제</p>
            <p className="text-xs text-zinc-400 mb-4 break-all">{subDeleteConfirm.fileName}</p>
            <div className="flex flex-col gap-2">
              <button
                disabled={deletingSub !== null}
                onClick={async () => {
                  setDeletingSub(subDeleteConfirm.filePath);
                  const result = await deleteSubtitleFile(movie.id, subDeleteConfirm.filePath, false);
                  if (result.success) {
                    toast.success("DB에서 제거됨 (파일 유지)");
                    onUpdate?.();
                  } else {
                    toast.error(result.error ?? "삭제 실패");
                  }
                  setDeletingSub(null);
                  setSubDeleteConfirm(null);
                }}
                className="w-full px-4 py-2 text-sm font-medium text-zinc-200 bg-zinc-800 border border-zinc-700 rounded-lg hover:bg-zinc-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {deletingSub === subDeleteConfirm.filePath ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                DB에서만 제거 (파일은 유지)
              </button>
              <button
                disabled={deletingSub !== null}
                onClick={async () => {
                  setDeletingSub(subDeleteConfirm.filePath);
                  const result = await deleteSubtitleFile(movie.id, subDeleteConfirm.filePath, true);
                  if (result.success) {
                    toast.success("디스크 + DB 모두 삭제됨");
                    onUpdate?.();
                  } else {
                    toast.error(result.error ?? "삭제 실패");
                  }
                  setDeletingSub(null);
                  setSubDeleteConfirm(null);
                }}
                className="w-full px-4 py-2 text-sm font-medium text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg hover:bg-red-500/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {deletingSub === subDeleteConfirm.filePath ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                디스크에서도 삭제
              </button>
              <button
                onClick={() => setSubDeleteConfirm(null)}
                className="w-full px-4 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                취소
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-md cursor-zoom-out"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            onClick={() => setLightboxSrc(null)}
            className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
          <p className="absolute bottom-6 left-1/2 -translate-x-1/2 text-sm text-zinc-400 pointer-events-none">
            {lightboxAlt}
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxSrc}
            alt={lightboxAlt}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            style={{ cursor: "default" }}
          />
        </div>
      )}
    </>
  );
}

/* ─── Full-featured Video Player ─── */

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "00:00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function VideoPlayer({ movieId, title, onClose }: { movieId: string; title: string; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const [showVolumeSlider, setShowVolumeSlider] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [isPiP, setIsPiP] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasSubtitleTrack, setHasSubtitleTrack] = useState(false);
  const [subtitlesOn, setSubtitlesOn] = useState(true);
  const [subtitleSize, setSubtitleSize] = useState<"sm" | "md" | "lg" | "xl">("lg");
  const [showSubtitleSizeMenu, setShowSubtitleSizeMenu] = useState(false);
  const [videoSrc, setVideoSrc] = useState(`/api/stream/${movieId}`);
  // Stream mode: probing → native | direct | hls | remux
  const [streamMode, setStreamMode] = useState<"probing" | "native" | "direct" | "hls" | "remux">("probing");
  const hlsRef = useRef<{ destroy(): void } | null>(null);

  // Auto-hide controls (Netflix/Standard player behavior)
  const resetControlsTimeout = useCallback(() => {
    setShowControls(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);

    // 재생 중이면 항상 3초 타이머 (전체화면/일반 모드 모두)
    if (isPlaying) {
      controlsTimerRef.current = setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  }, [isPlaying]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          isPlaying ? v.pause() : v.play().catch(() => {});
          break;
        case "ArrowLeft":
          e.preventDefault();
          v.currentTime = Math.max(0, v.currentTime - 10);
          break;
        case "ArrowRight":
          e.preventDefault();
          v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
          break;
        case "ArrowUp":
          e.preventDefault();
          v.currentTime = Math.min(v.duration || 0, v.currentTime + 30);
          break;
        case "ArrowDown":
          e.preventDefault();
          v.currentTime = Math.max(0, v.currentTime - 30);
          break;
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "m":
          e.preventDefault();
          if (v.volume > 0) {
            v.volume = 0;
            setVolume(0);
          } else {
            v.volume = 1;
            setVolume(1);
          }
          break;
        case "Escape":
          e.preventDefault();
          if (isFullscreen) {
            document.exitFullscreen?.();
          } else {
            onClose();
          }
          break;
        case "<":
        case ",":
          e.preventDefault();
          setSpeed(Math.max(0.25, playbackSpeed - 0.25));
          break;
        case ">":
        case ".":
          e.preventDefault();
          setSpeed(Math.min(2, playbackSpeed + 0.25));
          break;
      }
      resetControlsTimeout();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, isFullscreen, playbackSpeed, onClose]);

  // Fullscreen change listener
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", handleFsChange);
    return () => document.removeEventListener("fullscreenchange", handleFsChange);
  }, []);

  // Subtitle cues (custom renderer — <track> elements are unreliable in React)
  const [subtitleCues, setSubtitleCues] = useState<{ start: number; end: number; text: string }[]>([]);
  const [activeSubtitle, setActiveSubtitle] = useState("");

  // Check for embedded subtitles and fetch VTT
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const trackRes = await fetch(`/api/stream/${movieId}?type=subtitle-tracks`);
        const trackData = await trackRes.json();
        if (cancelled) return;
        if (!trackData.tracks || trackData.tracks.length === 0) return;
        setHasSubtitleTrack(true);

        // Fetch VTT content
        const vttRes = await fetch(`/api/stream/${movieId}?type=subtitles`);
        if (cancelled) return;
        const vttText = await vttRes.text();

        // Parse VTT — handles both HH:MM:SS.mmm and MM:SS.mmm formats
        const parseVttTime = (s: string): number => {
          const parts = s.trim().split(":");
          if (parts.length === 3) {
            // HH:MM:SS.mmm
            const [h, m, rest] = parts;
            const [sec, ms] = rest.split(/[.,]/);
            return +h * 3600 + +m * 60 + +sec + +(ms || "0") / 1000;
          } else if (parts.length === 2) {
            // MM:SS.mmm
            const [m, rest] = parts;
            const [sec, ms] = rest.split(/[.,]/);
            return +m * 60 + +sec + +(ms || "0") / 1000;
          }
          return 0;
        };

        const cues: { start: number; end: number; text: string }[] = [];
        const blocks = vttText.split(/\n\n+/);
        for (const block of blocks) {
          const lines = block.trim().split("\n");
          for (let i = 0; i < lines.length; i++) {
            const arrowIdx = lines[i].indexOf("-->");
            if (arrowIdx !== -1) {
              const startStr = lines[i].slice(0, arrowIdx).trim();
              const endStr = lines[i].slice(arrowIdx + 3).trim();
              const start = parseVttTime(startStr);
              const end = parseVttTime(endStr);
              // Strip HTML tags like <i>, <b> but keep text content
              const text = lines.slice(i + 1).join("\n").trim().replace(/<\/?[^>]+>/g, "");
              if (text && end > start) cues.push({ start, end, text });
              break;
            }
          }
        }
        if (!cancelled) setSubtitleCues(cues);
      } catch {
        // no subtitles available
      }
    })();
    return () => { cancelled = true; };
  }, [movieId]);

  // Update active subtitle based on currentTime
  useEffect(() => {
    if (!subtitlesOn || subtitleCues.length === 0) {
      setActiveSubtitle("");
      return;
    }
    const cue = subtitleCues.find((c) => currentTime >= c.start && currentTime <= c.end);
    setActiveSubtitle(cue?.text || "");
  }, [currentTime, subtitlesOn, subtitleCues]);

  // Detect stream mode on mount → initialize HLS or direct stream
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/stream/${movieId}?type=status`);
        const data = await res.json();
        if (cancelled) return;

        const mode: "native" | "direct" | "hls" | "remux" = data.mode || "remux";
        setStreamMode(mode);

        if (mode === "hls") {
          // Dynamically load hls.js (browser-only)
          const { default: Hls } = await import("hls.js");
          if (cancelled || !videoRef.current) return;

          if (Hls.isSupported()) {
            const hls = new Hls({ enableWorker: true, lowLatencyMode: false });
            hlsRef.current = hls;
            hls.loadSource(`/api/stream/${movieId}?type=hls`);
            hls.attachMedia(videoRef.current);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
              if (!cancelled) videoRef.current?.play().catch(() => {});
            });
            hls.on(Hls.Events.ERROR, (_, errData) => {
              if (errData.fatal) setError("HLS 재생 오류: " + errData.details);
            });
          } else if (videoRef.current.canPlayType("application/vnd.apple.mpegurl")) {
            // Safari native HLS support
            setVideoSrc(`/api/stream/${movieId}?type=hls`);
          }
        }
        // native / direct: videoSrc already set correctly, nothing else needed
      } catch {
        setStreamMode("remux"); // fallback
      }
    })();

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movieId]);

  // Poll for remux completion (AVI/legacy format)
  useEffect(() => {
    if (streamMode !== "remux") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/stream/${movieId}?type=status`);
        const data = await res.json();
        if (data.ready) {
          clearInterval(interval);
          const v = videoRef.current;
          const time = v?.currentTime || 0;
          const wasPlaying = !v?.paused;
          setVideoSrc(`/api/stream/${movieId}?t=${Date.now()}`);
          setStreamMode("native");
          setTimeout(() => {
            const v2 = videoRef.current;
            if (v2 && time > 0) {
              v2.currentTime = time;
              if (wasPlaying) v2.play().catch(() => {});
            }
          }, 500);
        }
      } catch {}
    }, 5000);
    return () => clearInterval(interval);
  }, [movieId, streamMode]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      containerRef.current?.requestFullscreen?.();
    }
  };

  const togglePiP = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setIsPiP(false);
      } else {
        await v.requestPictureInPicture();
        setIsPiP(true);
      }
    } catch {}
  };

  const setSpeed = (speed: number) => {
    const v = videoRef.current;
    if (v) v.playbackRate = speed;
    setPlaybackSpeed(speed);
    setShowSpeedMenu(false);
  };

  const skipTime = (seconds: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + seconds));
    resetControlsTimeout();
  };

  const handleSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percentage = (e.clientX - rect.left) / rect.width;
    v.currentTime = percentage * v.duration;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      ref={containerRef}
      className={`fixed inset-0 z-[110] bg-black flex flex-col group/player transition-all duration-200 ${
        !showControls && isPlaying ? "cursor-none" : "cursor-default"
      }`}
      onMouseMove={resetControlsTimeout}
      onClick={(e) => {
        // Click on backdrop (not controls) toggles play
        if (e.target === e.currentTarget) {
          const v = videoRef.current;
          if (v) isPlaying ? v.pause() : v.play().catch(() => {});
        }
      }}
    >
      {/* Video element */}
      <video
        ref={videoRef}
        src={videoSrc}
        preload="metadata"
        playsInline
        className="absolute inset-0 w-full h-full object-contain"
        onClick={() => {
          const v = videoRef.current;
          if (v) isPlaying ? v.pause() : v.play().catch(() => {});
          resetControlsTimeout();
        }}
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (v) {
            setDuration(v.duration);
            setIsLoading(false);
            v.play().catch(() => {});
            resetControlsTimeout();
          }
        }}
        onTimeUpdate={() => {
          const v = videoRef.current;
          if (v) setCurrentTime(v.currentTime);
        }}
        onPlay={() => {
          setIsPlaying(true);
          resetControlsTimeout();
        }}
        onPause={() => {
          setIsPlaying(false);
          setShowControls(true); // Always show controls when paused
        }}
        onWaiting={() => setIsLoading(true)}
        onCanPlay={() => setIsLoading(false)}
        onError={(e) => {
          const v = e.currentTarget;
          // Log all errors for debugging
          const errorCode = v.error?.code;
          const errorMsg = v.error?.message;
          console.error(`[Video Error] networkState: ${v.networkState}, errorCode: ${errorCode}, message: ${errorMsg}, src: ${v.src}`);

          // Show error for serious issues
          if (v.networkState === v.NETWORK_NO_SOURCE || v.networkState === v.NETWORK_EMPTY ||
              (v.error && (errorCode === 4 || errorCode === 2 || errorCode === 3))) {
            setError(`비디오를 재생할 수 없습니다 (Error: ${errorCode}). 잠시 후 다시 시도해주세요.`);
          }
        }}
      />

      {/* Custom subtitle overlay */}
      {subtitlesOn && activeSubtitle && (
        <div className="absolute bottom-20 md:bottom-24 inset-x-0 z-10 flex justify-center pointer-events-none px-8">
          <p
            className={`text-white font-semibold text-center leading-relaxed max-w-[85%] ${
              subtitleSize === "sm" ? "text-base md:text-lg" :
              subtitleSize === "md" ? "text-lg md:text-2xl" :
              subtitleSize === "lg" ? "text-xl md:text-3xl" :
              "text-2xl md:text-4xl"
            }`}
            style={{
              textShadow: "0 0 8px rgba(0,0,0,1), 0 0 4px rgba(0,0,0,1), 2px 2px 4px rgba(0,0,0,0.9)",
            }}
            dangerouslySetInnerHTML={{ __html: activeSubtitle.replace(/\n/g, "<br/>") }}
          />
        </div>
      )}

      {/* Loading spinner */}
      {isLoading && !error && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <Loader2 className="w-12 h-12 animate-spin text-primary" />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={onClose} className="px-4 py-2 bg-zinc-800 text-zinc-200 rounded-lg text-sm hover:bg-zinc-700">
            닫기
          </button>
        </div>
      )}

      {/* Mode indicator */}
      {streamMode === "remux" && !isLoading && !error && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 px-3 py-1.5 bg-black/70 rounded-full text-xs text-amber-400 flex items-center gap-2 pointer-events-none">
          <Loader2 className="w-3 h-3 animate-spin" />
          변환 중... 완료 후 탐색 가능
        </div>
      )}

      {/* Top bar — title + close */}
      <div
        className={`absolute top-0 inset-x-0 z-20 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-300 ${
          showControls ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onMouseEnter={() => {
          if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
        }}
        onMouseLeave={resetControlsTimeout}
      >
        <p className="text-sm text-zinc-200 truncate font-medium">{title}</p>
        <button
          onClick={onClose}
          className="p-2 rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Bottom controls */}
      <div
        className={`absolute bottom-0 inset-x-0 z-20 p-4 md:p-6 bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300 ${
          showControls ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onMouseMove={resetControlsTimeout}
        onMouseEnter={() => {
          if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
        }}
        onMouseLeave={resetControlsTimeout}
      >
        <div className="flex flex-col gap-3">
          {/* Seek bar */}
          <div
            className="h-1.5 w-full bg-zinc-700 rounded-full overflow-hidden cursor-pointer hover:h-2.5 transition-all"
            onClick={handleSeekClick}
          >
            <div
              className="h-full bg-primary shadow-[0_0_8px_rgba(23,207,90,0.5)] transition-all pointer-events-none"
              style={{ width: `${progress}%` }}
            />
          </div>

          {/* Control row */}
          <div className="flex items-center justify-between">
            {/* Left controls */}
            <div className="flex items-center gap-2 md:gap-3">
              {/* -30s (desktop only) */}
              <button
                onClick={() => skipTime(-30)}
                className="hidden md:block text-white/70 hover:text-white text-xs font-bold px-2 py-1 rounded hover:bg-white/10 transition"
              >
                -30s
              </button>

              {/* -10s */}
              <button onClick={() => skipTime(-10)} className="text-white hover:text-primary transition p-1">
                <Rewind className="w-5 h-5" />
              </button>

              {/* Play/Pause */}
              <button
                onClick={() => {
                  const v = videoRef.current;
                  if (v) isPlaying ? v.pause() : v.play().catch(() => {});
                }}
                className="w-10 h-10 md:w-12 md:h-12 bg-white rounded-full flex items-center justify-center text-black hover:scale-110 transition-transform"
              >
                {isPlaying ? <Pause className="w-5 h-5 md:w-6 md:h-6" fill="black" /> : <Play className="w-5 h-5 md:w-6 md:h-6 ml-0.5" fill="black" />}
              </button>

              {/* +10s */}
              <button onClick={() => skipTime(10)} className="text-white hover:text-primary transition p-1">
                <FastForward className="w-5 h-5" />
              </button>

              {/* +30s (desktop only) */}
              <button
                onClick={() => skipTime(30)}
                className="hidden md:block text-white/70 hover:text-white text-xs font-bold px-2 py-1 rounded hover:bg-white/10 transition"
              >
                +30s
              </button>

              {/* Time display */}
              <span className="text-xs md:text-sm font-mono text-white ml-2">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            {/* Right controls */}
            <div className="flex items-center gap-2 md:gap-3">
              {/* Subtitle toggle + size control */}
              <div className="relative flex items-center">
                <button
                  onClick={() => {
                    if (subtitleCues.length === 0 && !hasSubtitleTrack) {
                      toast.info("이 영화에는 내장 자막이 없습니다");
                      return;
                    }
                    setSubtitlesOn(prev => !prev);
                  }}
                  className={`p-1 rounded hover:bg-white/10 transition ${subtitlesOn && subtitleCues.length > 0 ? "text-primary" : "text-white/50"}`}
                  title="자막 켜기/끄기"
                >
                  <Subtitles className="w-4 h-4 md:w-5 md:h-5" />
                </button>
                {subtitlesOn && subtitleCues.length > 0 && (
                  <button
                    onClick={() => setShowSubtitleSizeMenu(prev => !prev)}
                    className="text-[10px] text-zinc-400 hover:text-white ml-0.5 px-1 rounded hover:bg-white/10 transition"
                    title="자막 크기"
                  >
                    {subtitleSize === "sm" ? "가" : subtitleSize === "md" ? "가" : subtitleSize === "lg" ? "가" : "가"}
                    <span className="text-[7px] align-super">{subtitleSize === "sm" ? "S" : subtitleSize === "md" ? "M" : subtitleSize === "lg" ? "L" : "XL"}</span>
                  </button>
                )}
                {showSubtitleSizeMenu && (
                  <div className="absolute bottom-full right-0 mb-2 bg-black/95 rounded-lg border border-zinc-700 py-1 min-w-[90px]">
                    {([["sm", "작게"], ["md", "보통"], ["lg", "크게"], ["xl", "매우 크게"]] as const).map(([size, label]) => (
                      <button
                        key={size}
                        onClick={() => { setSubtitleSize(size); setShowSubtitleSizeMenu(false); }}
                        className={`w-full px-3 py-1.5 text-xs text-left hover:bg-primary/20 transition ${
                          subtitleSize === size ? "text-primary font-bold" : "text-white"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Speed control */}
              <div className="relative">
                <button
                  onClick={() => setShowSpeedMenu(!showSpeedMenu)}
                  className="flex items-center gap-1 text-white hover:text-primary transition px-2 py-1 rounded hover:bg-white/10"
                >
                  <Gauge className="w-4 h-4" />
                  <span className="text-xs font-bold hidden md:inline">{playbackSpeed}x</span>
                </button>
                {showSpeedMenu && (
                  <div className="absolute bottom-full right-0 mb-2 bg-black/95 rounded-lg border border-zinc-700 py-1 min-w-[80px]">
                    {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(speed => (
                      <button
                        key={speed}
                        onClick={() => setSpeed(speed)}
                        className={`w-full px-3 py-1.5 text-xs text-left hover:bg-primary/20 transition ${
                          playbackSpeed === speed ? "text-primary font-bold" : "text-white"
                        }`}
                      >
                        {speed}x
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Volume */}
              <div
                className="relative flex items-center gap-1"
                onMouseEnter={() => setShowVolumeSlider(true)}
                onMouseLeave={() => setShowVolumeSlider(false)}
              >
                <button
                  onClick={() => {
                    const v = videoRef.current;
                    if (!v) return;
                    if (volume > 0) { v.volume = 0; setVolume(0); }
                    else { v.volume = 1; setVolume(1); }
                  }}
                  className="text-white hover:text-primary transition p-1"
                >
                  {volume > 0 ? <Volume2 className="w-4 h-4 md:w-5 md:h-5" /> : <VolumeX className="w-4 h-4 md:w-5 md:h-5 text-red-400" />}
                </button>
                {showVolumeSlider && (
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={volume}
                    onChange={(e) => {
                      const newVol = parseFloat(e.target.value);
                      setVolume(newVol);
                      if (videoRef.current) videoRef.current.volume = newVol;
                    }}
                    className="w-16 h-1 bg-zinc-600 rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                )}
              </div>

              {/* PiP (desktop only) */}
              <button
                onClick={togglePiP}
                className={`hidden md:block p-1 rounded hover:bg-white/10 transition ${isPiP ? "text-primary" : "text-white"}`}
                title="PIP 모드"
              >
                <PictureInPicture2 className="w-4 h-4" />
              </button>

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className="text-white hover:text-primary transition p-1 rounded hover:bg-white/10"
                title="전체화면"
              >
                {isFullscreen ? <Minimize2 className="w-4 h-4 md:w-5 md:h-5" /> : <Maximize2 className="w-4 h-4 md:w-5 md:h-5" />}
              </button>
            </div>
          </div>

          {/* Keyboard shortcuts hint (fullscreen only) */}
          {isFullscreen && (
            <div className="text-center text-zinc-500 text-[10px]">
              ← → 10초 | ↑ ↓ 30초 | Space 재생 | F 전체화면 | M 음소거 | &lt; &gt; 속도
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
