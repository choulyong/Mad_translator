"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Import, Loader2, Trash2, LayoutGrid, X, Search, ArrowUpDown, RefreshCw, Sparkles, Film, FileX2, HardDrive } from "lucide-react";
import { toast } from "sonner";
import type { Movie } from "@/lib/db/schema";
import type { ImportedMovie, NewFileInfo } from "@/app/actions";
import {
  getMovies,
  deleteMovie,
  deleteMovieWithFile,
  deleteAllMovies,
  scanForLibrary,
  importToLibrary,
  enrichAndImportBatch,
  scanSubtitles,
  enrichMovie,
  getEnrichTargets,
  detectNewFiles,
  enrichAndImportNewFile,
  addLibrarySource,
  getLibrarySourcesList,
  removeLibrarySource,
  detectNewMoviesInLibrary,
  moveUnselectedToNoChoice,
  getFileSizes,
} from "@/app/actions";
import { MovieCard } from "./movie-card";
import { MovieDetailDialog } from "./movie-detail-dialog";
import { FolderPickerDialog } from "./folder-picker-dialog";

export function LibraryClient() {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);

  // Search & Sort
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"latest" | "year" | "rating" | "name">("latest");

  // Delete state
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  // Refresh state
  const [refreshing, setRefreshing] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [enrichProgress, setEnrichProgress] = useState({ done: 0, total: 0, updated: 0 });
  const [enrichCurrentTitles, setEnrichCurrentTitles] = useState<string[]>([]);

  // Import state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [librarySources, setLibrarySources] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState("");
  const [scannedItems, setScannedItems] = useState<ImportedMovie[]>([]);
  const [showImportPreview, setShowImportPreview] = useState(false);
  const [importSelected, setImportSelected] = useState<Set<number>>(new Set());
  const [enrichImportProgress, setEnrichImportProgress] = useState({ done: 0, total: 0 });
  const [enrichImportCurrentTitle, setEnrichImportCurrentTitle] = useState("");
  const [refreshStatus, setRefreshStatus] = useState("");

  // New files detection state
  const [detectedNewFiles, setDetectedNewFiles] = useState<NewFileInfo[]>([]);
  const [showNewFilesPreview, setShowNewFilesPreview] = useState(false);
  const [newFilesSelected, setNewFilesSelected] = useState<Set<number>>(new Set());
  const [importingNewFiles, setImportingNewFiles] = useState(false);
  const [newFileProgress, setNewFileProgress] = useState({ done: 0, total: 0 });

  const loadMovies = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getMovies();
      setMovies(result.success ? result.data ?? [] : []);
    } catch {
      setMovies([]);
    }
    setLoading(false);
  }, []);

  // Silent reload — no loading spinner, preserves scroll position
  const reloadMovies = useCallback(async () => {
    try {
      const result = await getMovies();
      if (result.success) {
        setMovies(result.data ?? []);
        // Also update selectedMovie if it's currently open
        if (selectedMovie) {
          const updated = result.data?.find((m) => m.id === selectedMovie.id);
          if (updated) setSelectedMovie(updated);
        }
      }
    } catch {
      // ignore — silent reload failure
    }
  }, [selectedMovie]);

  useEffect(() => {
    loadMovies();
  }, [loadMovies]);

  // Load library sources on mount
  useEffect(() => {
    getLibrarySourcesList().then(setLibrarySources);
  }, []);

  const handleRemoveLibrarySource = async (sourcePath: string) => {
    await removeLibrarySource(sourcePath);
    const updated = await getLibrarySourcesList();
    setLibrarySources(updated);
    toast.success("소스 폴더 삭제됨");
  };

  // Individual delete
  const handleDelete = async (id: string) => {
    const result = await deleteMovie(id);
    if (result.success) {
      setMovies((prev) => prev.filter((m) => m.id !== id));
      setSelectedMovie(null);
      toast.success("삭제 완료");
    } else {
      toast.error(result.error ?? "삭제 실패");
    }
  };

  // Delete from card (without opening dialog)
  const handleCardDelete = async (id: string) => {
    const result = await deleteMovie(id);
    if (result.success) {
      setMovies((prev) => prev.filter((m) => m.id !== id));
      toast.success("삭제 완료");
    } else {
      toast.error(result.error ?? "삭제 실패");
    }
  };

  // ====== 중복 삭제 모달 ======
  interface DupGroup {
    tmdbId: number;
    title: string;
    entries: Array<{ movie: Movie; fileSize: number }>;
  }
  const [deletingDuplicates, setDeletingDuplicates] = useState(false);
  const [showDupModal, setShowDupModal] = useState(false);
  const [dupGroups, setDupGroups] = useState<DupGroup[]>([]);
  const [dupChecked, setDupChecked] = useState<Set<string>>(new Set()); // 체크 = 삭제 대상
  const [dupLoadingSize, setDupLoadingSize] = useState(false);
  const [showDupConfirm, setShowDupConfirm] = useState(false);

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "알 수 없음";
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(0)} KB`;
  }

  const handleDeleteDuplicates = async () => {
    const tmdbCount = new Map<number, Movie[]>();
    for (const movie of movies) {
      if (movie.tmdbId) {
        const existing = tmdbCount.get(movie.tmdbId) || [];
        existing.push(movie);
        tmdbCount.set(movie.tmdbId, existing);
      }
    }

    const groups: Array<{ tmdbId: number; title: string; list: Movie[] }> = [];
    for (const [tmdbId, list] of tmdbCount) {
      if (list.length > 1) groups.push({ tmdbId, title: list[0].title, list });
    }

    if (groups.length === 0) {
      toast.info("중복된 영화가 없습니다");
      return;
    }

    // 파일 크기 조회
    setDupLoadingSize(true);
    setShowDupModal(true);
    const allPaths = groups.flatMap(g => g.list.map(m => m.filePath));
    const sizeResult = await getFileSizes(allPaths);
    const sizes: Record<string, number> = sizeResult.success ? sizeResult.data! : {};
    setDupLoadingSize(false);

    // 그룹 구성: 용량 내림차순 정렬
    const finalGroups: DupGroup[] = groups.map(g => ({
      tmdbId: g.tmdbId,
      title: g.title,
      entries: [...g.list]
        .map(m => ({ movie: m, fileSize: sizes[m.filePath] ?? 0 }))
        .sort((a, b) => b.fileSize - a.fileSize),
    }));
    setDupGroups(finalGroups);

    // 기본 체크 상태: 가장 큰 파일 제외, 나머지 체크
    const checked = new Set<string>();
    for (const g of finalGroups) {
      for (let i = 1; i < g.entries.length; i++) {
        checked.add(g.entries[i].movie.id);
      }
    }
    setDupChecked(checked);
  };

  const executeDupDelete = async (deleteFiles: boolean) => {
    const toDelete = movies.filter(m => dupChecked.has(m.id));
    setShowDupConfirm(false);
    setShowDupModal(false);
    setDeletingDuplicates(true);
    let deleted = 0;
    for (const movie of toDelete) {
      const result = deleteFiles
        ? await deleteMovieWithFile(movie.id, movie.filePath)
        : await deleteMovie(movie.id);
      if (result.success) deleted++;
    }
    setDeletingDuplicates(false);
    await loadMovies();
    toast.success(`${deleted}개 중복 영화 ${deleteFiles ? "(파일 포함) " : ""}삭제 완료`);
  };

  // Delete all
  const handleDeleteAll = async () => {
    setDeletingAll(true);
    const result = await deleteAllMovies();
    if (result.success) {
      setMovies([]);
      toast.success("라이브러리 전체 삭제 완료");
    } else {
      toast.error(result.error ?? "전체 삭제 실패");
    }
    setDeletingAll(false);
    setConfirmDeleteAll(false);
  };

  // Refresh: 자막 동기화(조용히) + 새 영화 자동 감지 + 풀 보강
  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshStatus("새로고침 중...");
    try {
      // 1. 자막 동기화 (백그라운드, 메시지 없음)
      await scanSubtitles();

      // 2. 새 영화 감지 (파일시스템만, 즉시 완료)
      setRefreshStatus("새 영화 검색 중...");
      const newResult = await detectNewMoviesInLibrary();
      if (newResult.success && newResult.data && newResult.data.length > 0) {
        const newMovies = newResult.data;
        const total = newMovies.length;
        toast.info(`새 영화 ${total}개 발견, 정보 수집 중...`);

        // 3. 풀 보강 + DB 저장
        setEnrichImportProgress({ done: 0, total });
        const BATCH_SIZE = 3;
        let done = 0;

        for (let i = 0; i < newMovies.length; i += BATCH_SIZE) {
          const batch = newMovies.slice(i, i + BATCH_SIZE);
          const titles = batch.map((b) => b.title).join(", ");
          setRefreshStatus(`정보 수집 중 (${done}/${total}) — ${titles}`);
          setEnrichImportCurrentTitle(titles);

          const batchItems = batch.map((item) => ({
            fileName: item.fileName,
            filePath: item.filePath,
            folderName: item.folderName,
            title: item.title,
            year: item.year || undefined,
            subtitles: item.subtitles || [],
          }));

          await enrichAndImportBatch(batchItems);
          done += batch.length;
          setEnrichImportProgress({ done, total });
          if (done % 6 === 0) await reloadMovies();
        }

        setEnrichImportCurrentTitle("");
        toast.success(`${done}개 새 영화 추가 완료`);
      }

      await reloadMovies();
    } catch {
      toast.error("새로고침 실패");
    }
    setRefreshing(false);
    setRefreshStatus("");
    setEnrichImportProgress({ done: 0, total: 0 });
  };

  // 신규 파일 확인 임포트
  const handleConfirmNewFiles = async () => {
    const selected = detectedNewFiles.filter((_, i) => newFilesSelected.has(i));
    if (selected.length === 0) return;

    setImportingNewFiles(true);
    setNewFileProgress({ done: 0, total: selected.length });

    let done = 0;
    for (const file of selected) {
      await enrichAndImportNewFile(file);
      done++;
      setNewFileProgress({ done, total: selected.length });
    }

    toast.success(`${done}개 영화 추가 완료`);
    setShowNewFilesPreview(false);
    setDetectedNewFiles([]);
    setImportingNewFiles(false);
    await loadMovies();
  };

  const toggleNewFileItem = (index: number) => {
    setNewFilesSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  // Enrich: OMDB 데이터 보강 (실시간 진행률)
  const handleEnrich = async () => {
    setEnriching(true);
    setEnrichProgress({ done: 0, total: 0, updated: 0 });
    try {
      // 1) 보강 대상 목록 가져오기
      const targets = await getEnrichTargets();
      if (!targets.success || !targets.data) {
        toast.error(targets.error ?? "대상 조회 실패");
        setEnriching(false);
        return;
      }

      const { ids, total: totalMovies } = targets.data;
      if (ids.length === 0) {
        toast.success(`모든 영화가 이미 보강되어 있습니다 (${totalMovies}개)`);
        setEnriching(false);
        return;
      }

      setEnrichProgress({ done: 0, total: ids.length, updated: 0 });

      // 2) 3개씩 병렬 보강하며 실시간 카운트 + 제목 표시
      // ID → 제목 매핑 (미리 준비)
      const titleMap = new Map(movies.map((m) => [m.id, m.title]));
      let updated = 0;
      let done = 0;
      const CONCURRENCY = 3;
      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const batch = ids.slice(i, i + CONCURRENCY);
        // 배치 시작 전에 처리할 영화 제목 표시
        setEnrichCurrentTitles(batch.map((id) => titleMap.get(id) || "..."));
        const results = await Promise.allSettled(
          batch.map((id) => enrichMovie(id))
        );
        for (const r of results) {
          done++;
          if (r.status === "fulfilled" && r.value.success && !r.value.error?.includes("이미")) {
            updated++;
          }
        }
        setEnrichProgress({ done, total: ids.length, updated });
        // 매 5배치(15개)마다 중간 리로드 — UI에서 보강 결과 바로 확인 가능
        if (done % 15 === 0) await reloadMovies();
      }
      setEnrichCurrentTitles([]);

      toast.success(`보강 완료! ${updated}/${ids.length}개 업데이트 (전체 ${totalMovies}개)`);
      await reloadMovies();
    } catch {
      toast.error("보강 실패");
    }
    setEnriching(false);
  };

  // Import flow
  const handleFolderSelect = async (folderPath: string) => {
    setImporting(true);
    setImportProgress("폴더 스캔 중...");

    // 소스 폴더 기억 (새로고침 시 자동 재스캔용)
    await addLibrarySource(folderPath);

    // 라이브러리의 기존 TMDB ID 목록 가져오기
    const existingMovies = await getMovies();
    const existingTmdbIds = new Set(
      existingMovies.success && existingMovies.data
        ? existingMovies.data.filter((m) => m.tmdbId).map((m) => m.tmdbId)
        : []
    );

    const result = await scanForLibrary(folderPath);

    if (result.success && result.data) {
      setScannedItems(result.data);

      // 라이브러리에 없는 영화만 선택, 있는 영화는 선택 해제
      const initialSelected = new Set<number>();
      const alreadyInLibrary: string[] = [];

      result.data.forEach((item, index) => {
        if (item.tmdbId && existingTmdbIds.has(item.tmdbId)) {
          alreadyInLibrary.push(item.title);
        } else {
          initialSelected.add(index);
        }
      });

      setImportSelected(initialSelected);
      setShowImportPreview(true);

      if (alreadyInLibrary.length > 0) {
        toast.info(
          `${alreadyInLibrary.length}개 이미 라이브러리에 있음 (선택 해제됨): ${alreadyInLibrary.slice(0, 3).join(", ")}${alreadyInLibrary.length > 3 ? `...외 ${alreadyInLibrary.length - 3}개` : ""}`,
          { duration: 6000 }
        );
      }

      toast.success(`${result.data.length}개 영화 발견 (${result.data.length - alreadyInLibrary.length}개 선택 가능)`);
    } else {
      toast.error(result.error ?? "스캔 실패");
    }

    setImporting(false);
    setImportProgress("");
  };

  const handleConfirmImport = async () => {
    const selected = scannedItems.filter((_, i) => importSelected.has(i));
    if (selected.length === 0) {
      toast.info("가져올 영화를 선택하세요");
      return;
    }

    setImporting(true);
    const total = selected.length;
    setEnrichImportProgress({ done: 0, total });

    const BATCH_SIZE = 3;
    let done = 0;

    for (let i = 0; i < selected.length; i += BATCH_SIZE) {
      const batch = selected.slice(i, i + BATCH_SIZE);
      setEnrichImportCurrentTitle(batch.map((b) => b.title).join(", "));
      setImportProgress(`${done}/${total} 영화 정보 수집 + 저장 중...`);

      const batchItems = batch.map((item) => ({
        fileName: item.fileName,
        filePath: item.filePath,
        folderName: item.folderName,
        title: item.title,
        year: item.year || undefined,
        tmdbId: item.tmdbId,
        posterPath: item.posterPath,
        overview: item.overview,
        releaseDate: item.releaseDate,
        subtitles: item.subtitles || [],
      }));

      await enrichAndImportBatch(batchItems);
      done += batch.length;
      setEnrichImportProgress({ done, total });
      if (done % 6 === 0) await reloadMovies();
    }

    setEnrichImportCurrentTitle("");
    toast.success(`${done}개 라이브러리에 추가 완료`);

    // 선택되지 않은 영화를 nochoice 폴더로 이동
    const selectedIndices = Array.from(importSelected);
    const moveResult = await moveUnselectedToNoChoice(scannedItems, selectedIndices);

    if (moveResult.success && moveResult.data) {
      const { movedCount, movedFiles, failedFiles } = moveResult.data;
      let message = "";
      if (movedCount > 0) {
        message += `✅ nochoice 폴더로 이동 완료 (${movedCount}개):\n`;
        message += movedFiles.slice(0, 10).join("\n");
        if (movedFiles.length > 10) message += `\n...외 ${movedFiles.length - 10}개`;
      }
      if (failedFiles && failedFiles.length > 0) {
        if (message) message += "\n\n";
        message += `❌ 이동 실패 (${failedFiles.length}개):\n`;
        message += failedFiles.slice(0, 5).join("\n");
        if (failedFiles.length > 5) message += `\n...외 ${failedFiles.length - 5}개`;
      }
      if (movedCount === 0 && (!failedFiles || failedFiles.length === 0)) {
        message = "이동할 파일이 없습니다";
      }
      alert(message);
    }

    setShowImportPreview(false);
    setScannedItems([]);
    await loadMovies();
    setImporting(false);
    setImportProgress("");
    setEnrichImportProgress({ done: 0, total: 0 });
  };

  const toggleImportItem = (index: number) => {
    setImportSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const filteredMovies = useMemo(() => {
    let result = [...movies];

    // 검색 필터
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (m) =>
          m.title.toLowerCase().includes(q) ||
          m.originalName.toLowerCase().includes(q) ||
          (m.director && m.director.toLowerCase().includes(q)) ||
          (m.genres && m.genres.toLowerCase().includes(q))
      );
    }

    // 정렬
    switch (sortBy) {
      case "year":
        result.sort((a, b) => {
          const ya = a.releaseDate ? parseInt(a.releaseDate.slice(0, 4)) : 0;
          const yb = b.releaseDate ? parseInt(b.releaseDate.slice(0, 4)) : 0;
          return yb - ya;
        });
        break;
      case "rating":
        result.sort((a, b) => {
          const ra = a.imdbRating ? parseFloat(a.imdbRating) : 0;
          const rb = b.imdbRating ? parseFloat(b.imdbRating) : 0;
          return rb - ra;
        });
        break;
      case "name":
        result.sort((a, b) => a.title.localeCompare(b.title, "ko"));
        break;
      case "latest":
      default:
        // 기본: 추가일 최신순 (DB에서 이미 정렬됨)
        break;
    }

    return result;
  }, [movies, searchQuery, sortBy]);

  return (
    <>
      {/* Header */}
      <header className="min-h-[56px] md:h-16 flex flex-col md:flex-row md:items-center justify-between px-4 md:px-8 pl-14 md:pl-8 py-2 md:py-0 gap-2 md:gap-0 border-b border-border-dark bg-background-dark/80 backdrop-blur sticky top-0 z-40">
        <div className="flex items-center gap-3 md:gap-4">
          <h1 className="text-base md:text-lg font-semibold text-zinc-100">라이브러리</h1>
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-primary/20 text-primary border border-primary/20">
            {movies.length}개의 영화
          </span>
        </div>
        <div className="flex items-center gap-2">
          {importing && (
            <span className="text-xs text-zinc-400 mr-2">{importProgress}</span>
          )}

          {/* Delete All */}
          {movies.length > 0 && (
            <>
              {confirmDeleteAll ? (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={handleDeleteAll}
                    disabled={deletingAll}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg hover:bg-red-500/20 transition-colors disabled:opacity-50"
                  >
                    {deletingAll ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="w-3.5 h-3.5" />
                    )}
                    {movies.length}개 전체 삭제
                  </button>
                  <button
                    onClick={() => setConfirmDeleteAll(false)}
                    className="p-2 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDeleteAll(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-zinc-400 border border-border-dark rounded-lg hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/5 transition-colors"
                  title="라이브러리 전체 삭제"
                >
                  <Trash2 className="w-4 h-4" />
                  전체 삭제
                </button>
              )}
            </>
          )}

          {/* Refresh: 자막 동기화 */}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-zinc-400 border border-border-dark rounded-lg hover:text-primary hover:border-primary/30 hover:bg-primary/5 transition-colors disabled:opacity-50"
            title="새 영화 감지 + 라이브러리 동기화"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? (refreshStatus || "새로고침 중...") : "새로고침"}
          </button>

          {/* Delete Duplicates */}
          <button
            onClick={handleDeleteDuplicates}
            disabled={deletingDuplicates || movies.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-zinc-400 border border-border-dark rounded-lg hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/5 transition-colors disabled:opacity-50"
            title="중복된 영화 삭제 (같은 TMDB ID)"
          >
            <Trash2 className={`w-4 h-4 ${deletingDuplicates ? "animate-spin" : ""}`} />
            {deletingDuplicates ? "삭제 중..." : "중복 삭제"}
          </button>

          {/* Enrich: OMDB 데이터 보강 */}
          <div className="relative">
            <button
              onClick={handleEnrich}
              disabled={enriching}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-zinc-400 border border-border-dark rounded-lg hover:text-amber-400 hover:border-amber-400/30 hover:bg-amber-400/5 transition-colors disabled:opacity-50"
              title="OMDB 평점 · 줄거리 보강 (누락 항목)"
            >
              <Sparkles className={`w-4 h-4 ${enriching ? "animate-pulse" : ""}`} />
              {enriching
                ? enrichProgress.total > 0
                  ? `보강 중 ${enrichProgress.done}/${enrichProgress.total}`
                  : "대상 조회 중..."
                : "데이터 보강"}
            </button>
            {enriching && enrichCurrentTitles.length > 0 && (
              <div className="absolute top-full left-0 mt-1 px-2 py-1 bg-zinc-900 border border-amber-500/20 rounded text-[10px] text-amber-400/80 whitespace-nowrap z-10 max-w-[300px] truncate">
                {enrichCurrentTitles.join(", ")}
              </div>
            )}
          </div>

          {/* Scan / Import */}
          <button
            onClick={() => setPickerOpen(true)}
            disabled={importing}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg hover:bg-primary-dark transition-colors disabled:opacity-50"
          >
            {importing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Import className="w-4 h-4" />
            )}
            폴더에서 가져오기
          </button>
        </div>
      </header>

      {/* Library Sources - 소스 폴더 목록 */}
      {librarySources.length > 0 && (
        <div className="px-4 md:px-8 py-3 bg-surface-dark/50 border-b border-border-dark">
          <div className="text-xs text-zinc-500 mb-2">등록된 소스 폴더</div>
          <div className="flex flex-wrap gap-2">
            {librarySources.map((source) => (
              <div
                key={source}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-surface-darker border border-border-dark rounded-lg text-zinc-400"
              >
                <span className="truncate max-w-[200px] md:max-w-[300px]" title={source}>
                  {source.replace(/^\/\//, "\\\\").replace(/\//g, "\\")}
                </span>
                <button
                  onClick={() => handleRemoveLibrarySource(source)}
                  className="p-0.5 rounded hover:bg-red-500/20 hover:text-red-400 transition-colors"
                  title="소스 폴더 삭제"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {/* Import Preview */}
        {showImportPreview && (
          <div className="mb-4 md:mb-8 bg-surface-dark border border-border-dark rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-border-dark flex items-center justify-between bg-surface-darker">
              <h3 className="text-sm font-semibold text-zinc-200">
                가져올 영화 선택 ({importSelected.size}/{scannedItems.length})
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowImportPreview(false)}
                  className="px-3 py-1.5 text-xs font-medium text-zinc-400 border border-border-dark rounded-lg hover:bg-zinc-800 transition-colors"
                >
                  취소
                </button>
                <button
                  onClick={handleConfirmImport}
                  disabled={importing || importSelected.size === 0}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-primary rounded-lg hover:bg-primary-dark transition-colors disabled:opacity-50"
                >
                  {importing ? (
                    <Loader2 className="w-3 h-3 animate-spin inline mr-1" />
                  ) : null}
                  선택 항목 가져오기 ({importSelected.size})
                </button>
              </div>
            </div>
            {importing && enrichImportProgress.total > 0 && (
              <div className="px-5 py-2 border-b border-border-dark bg-surface-darker/50">
                <div className="flex items-center justify-between text-xs text-zinc-400 mb-1">
                  <span>{enrichImportCurrentTitle || "처리 중..."}</span>
                  <span>{enrichImportProgress.done}/{enrichImportProgress.total}</span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${(enrichImportProgress.done / enrichImportProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}
            <div className="max-h-80 overflow-y-auto divide-y divide-border-dark">
              {scannedItems.map((item, i) => (
                <label
                  key={i}
                  className={`flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-surface-darker/50 transition-colors ${
                    importSelected.has(i) ? "bg-primary/[0.03]" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={importSelected.has(i)}
                    onChange={() => toggleImportItem(i)}
                    className="accent-[#17cf5a] w-4 h-4"
                  />
                  {item.posterPath ? (
                    <img
                      src={`https://image.tmdb.org/t/p/w92${item.posterPath}`}
                      alt={item.title}
                      className="w-8 h-12 rounded object-cover shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-12 rounded bg-zinc-800 flex items-center justify-center shrink-0">
                      <Film className="w-4 h-4 text-zinc-600" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-200 font-medium truncate">
                      {item.title} {item.year && `(${item.year})`}
                    </p>
                    <p className="text-[11px] text-zinc-500 truncate font-[family-name:var(--font-mono)]">
                      {item.folderName ? `📁 ${item.folderName}/` : ""}{item.fileName}
                    </p>
                  </div>
                  {item.subtitles && item.subtitles.length > 0 && (
                    <span className="text-[10px] text-sky-400/70 shrink-0">
                      자막 {item.subtitles.length}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* New Files Preview */}
        {showNewFilesPreview && detectedNewFiles.length > 0 && (
          <div className="mb-4 md:mb-8 bg-surface-dark border border-emerald-500/20 rounded-xl overflow-hidden">
            <div className="px-5 py-3 border-b border-emerald-500/20 flex items-center justify-between bg-emerald-500/5">
              <h3 className="text-sm font-semibold text-emerald-300">
                새로 발견된 영화 ({newFilesSelected.size}/{detectedNewFiles.length})
              </h3>
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowNewFilesPreview(false); setDetectedNewFiles([]); }}
                  className="px-3 py-1.5 text-xs font-medium text-zinc-400 border border-border-dark rounded-lg hover:bg-zinc-800 transition-colors"
                >
                  취소
                </button>
                <button
                  onClick={handleConfirmNewFiles}
                  disabled={importingNewFiles || newFilesSelected.size === 0}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50"
                >
                  {importingNewFiles ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin inline mr-1" />
                      {newFileProgress.done}/{newFileProgress.total} 처리 중...
                    </>
                  ) : (
                    <>선택 항목 가져오기 ({newFilesSelected.size})</>
                  )}
                </button>
              </div>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-border-dark">
              {detectedNewFiles.map((file, i) => (
                <label
                  key={i}
                  className={`flex items-center gap-3 px-5 py-3 cursor-pointer hover:bg-surface-darker/50 transition-colors ${
                    newFilesSelected.has(i) ? "bg-emerald-500/[0.03]" : ""
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={newFilesSelected.has(i)}
                    onChange={() => toggleNewFileItem(i)}
                    className="accent-emerald-500 w-4 h-4"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-200 font-medium truncate">
                      {file.folderName || file.fileName}
                    </p>
                    <p className="text-[11px] text-zinc-500 truncate font-[family-name:var(--font-mono)]">
                      {file.filePath}
                    </p>
                  </div>
                  <span className="text-[10px] text-emerald-400/70 shrink-0 font-semibold">NEW</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Search & Sort */}
        {movies.length > 0 && !loading && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4 md:mb-6">
            <div className="relative flex-1 sm:max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="영화 검색 (제목, 감독, 장르...)"
                className="w-full bg-surface-dark border border-border-dark rounded-lg pl-10 pr-4 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1 bg-surface-dark border border-border-dark rounded-lg p-0.5 overflow-x-auto shrink-0">
              {(
                [
                  { value: "latest", label: "최신순" },
                  { value: "year", label: "출시년도" },
                  { value: "rating", label: "평점순" },
                  { value: "name", label: "이름순" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setSortBy(opt.value)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    sortBy === opt.value
                      ? "bg-primary/20 text-primary"
                      : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {searchQuery && (
              <span className="text-xs text-zinc-500">
                {filteredMovies.length}개 결과
              </span>
            )}
          </div>
        )}

        {/* Refresh import progress */}
        {refreshing && enrichImportProgress.total > 0 && (
          <div className="mb-4 md:mb-6 bg-surface-dark border border-primary/20 rounded-xl p-4">
            <div className="flex items-center justify-between text-xs mb-2">
              <span className="text-primary font-medium">새 영화 가져오는 중...</span>
              <span className="text-zinc-400">{enrichImportProgress.done}/{enrichImportProgress.total}</span>
            </div>
            <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${(enrichImportProgress.done / enrichImportProgress.total) * 100}%` }}
              />
            </div>
            {enrichImportCurrentTitle && (
              <p className="text-[11px] text-zinc-500 mt-1.5 truncate">{enrichImportCurrentTitle}</p>
            )}
          </div>
        )}

        {/* Movie Grid */}
        {loading ? (
          <div className="flex items-center justify-center py-32">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : movies.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-32 text-center">
            <LayoutGrid className="w-12 h-12 text-zinc-600 mb-4" />
            <h2 className="text-lg font-semibold text-zinc-300 mb-2">
              라이브러리가 비어있습니다
            </h2>
            <p className="text-sm text-zinc-500 mb-6">
              영화 폴더를 탐색하여 라이브러리에 추가하세요
            </p>
            <button
              onClick={() => setPickerOpen(true)}
              className="px-4 py-2 rounded-lg bg-primary/10 text-primary text-sm font-medium border border-primary/20 hover:bg-primary/20 transition-colors"
            >
              폴더에서 가져오기
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 md:gap-6">
            {filteredMovies.map((movie) => (
              <MovieCard
                key={movie.id}
                movie={movie}
                onClick={setSelectedMovie}
                onDelete={handleCardDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* Detail Dialog */}
      <MovieDetailDialog
        movie={selectedMovie}
        open={selectedMovie !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedMovie(null);
        }}
        onDelete={handleDelete}
        onUpdate={reloadMovies}
      />

      {/* Folder Picker */}
      <FolderPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(folderPath) => {
          setPickerOpen(false);
          handleFolderSelect(folderPath);
        }}
        initialPath="//192.168.0.2/torrent"
      />

      {/* ====== 중복 삭제 모달 ====== */}
      {showDupModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setShowDupModal(false)} />
          <div className="relative bg-[#0d1117] border border-[#283039] rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
            {/* 헤더 */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#283039]">
              <div>
                <h2 className="text-white font-bold text-lg">중복 영화 삭제</h2>
                <p className="text-zinc-500 text-xs mt-0.5">체크된 항목이 삭제됩니다. 용량이 큰 파일은 자동으로 유지됩니다.</p>
              </div>
              <button onClick={() => setShowDupModal(false)} className="text-zinc-500 hover:text-white p-1 rounded-lg hover:bg-white/5">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* 목록 */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {dupLoadingSize ? (
                <div className="flex items-center justify-center py-12 gap-3 text-zinc-400">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="text-sm">파일 크기 확인 중...</span>
                </div>
              ) : (
                dupGroups.map((group) => (
                  <div key={group.tmdbId} className="border border-[#283039] rounded-xl overflow-hidden">
                    <div className="px-4 py-2 bg-[#1a232e] flex items-center gap-2">
                      <Film className="w-3.5 h-3.5 text-[#137fec]" />
                      <span className="text-sm font-semibold text-white">{group.title}</span>
                      <span className="text-xs text-zinc-500">({group.entries.length}개 중복)</span>
                    </div>
                    <div className="divide-y divide-[#1e2a35]">
                      {group.entries.map((entry, idx) => {
                        const isKept = idx === 0; // 가장 큰 파일 = 유지
                        const checked = dupChecked.has(entry.movie.id);
                        return (
                          <label
                            key={entry.movie.id}
                            className={`flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors ${
                              checked ? "bg-red-500/5 hover:bg-red-500/10" : "hover:bg-white/3"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                const next = new Set(dupChecked);
                                e.target.checked ? next.add(entry.movie.id) : next.delete(entry.movie.id);
                                setDupChecked(next);
                              }}
                              className="mt-0.5 accent-red-500 w-4 h-4 flex-shrink-0"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm text-zinc-200 font-medium truncate">{entry.movie.originalName}</span>
                                {isKept && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 bg-emerald-500/20 text-emerald-400 rounded border border-emerald-500/30 flex-shrink-0">유지</span>
                                )}
                                {checked && (
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded border border-red-500/30 flex-shrink-0">삭제</span>
                                )}
                              </div>
                              <p className="text-[11px] text-zinc-600 truncate mt-0.5">{entry.movie.filePath}</p>
                              <div className="flex items-center gap-1 mt-1">
                                <HardDrive className="w-3 h-3 text-zinc-600" />
                                <span className={`text-[11px] font-mono ${isKept ? "text-emerald-500" : "text-zinc-500"}`}>
                                  {formatBytes(entry.fileSize)}
                                </span>
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* 푸터 */}
            {!dupLoadingSize && (
              <div className="flex items-center justify-between px-6 py-4 border-t border-[#283039]">
                <span className="text-sm text-zinc-500">
                  {dupChecked.size}개 선택됨
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowDupModal(false)}
                    className="px-4 py-2 text-sm text-zinc-400 hover:text-white border border-[#283039] rounded-lg hover:border-zinc-600 transition-colors"
                  >
                    취소
                  </button>
                  <button
                    disabled={dupChecked.size === 0}
                    onClick={() => setShowDupConfirm(true)}
                    className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                  >
                    <Trash2 className="w-4 h-4" />
                    삭제 ({dupChecked.size}개)
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ====== 삭제 방식 선택 확인 모달 ====== */}
      {showDupConfirm && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setShowDupConfirm(false)} />
          <div className="relative bg-[#0d1117] border border-[#283039] rounded-2xl w-full max-w-sm shadow-2xl p-6">
            <h3 className="text-white font-bold text-base mb-1">삭제 방식 선택</h3>
            <p className="text-zinc-400 text-sm mb-5">선택한 {dupChecked.size}개 항목을 어떻게 삭제하시겠습니까?</p>
            <div className="space-y-2">
              <button
                onClick={() => executeDupDelete(false)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-[#283039] hover:border-[#137fec]/50 hover:bg-[#137fec]/5 transition-colors text-left"
              >
                <FileX2 className="w-5 h-5 text-[#137fec] flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-white">목록에서만 삭제</p>
                  <p className="text-xs text-zinc-500">실제 파일은 유지, 라이브러리에서만 제거</p>
                </div>
              </button>
              <button
                onClick={() => executeDupDelete(true)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-xl border border-red-500/30 hover:border-red-500/60 hover:bg-red-500/5 transition-colors text-left"
              >
                <Trash2 className="w-5 h-5 text-red-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-red-400">파일까지 삭제</p>
                  <p className="text-xs text-zinc-500">디스크에서 영구 삭제 (복구 불가)</p>
                </div>
              </button>
            </div>
            <button
              onClick={() => setShowDupConfirm(false)}
              className="mt-3 w-full py-2 text-sm text-zinc-500 hover:text-white transition-colors"
            >
              취소
            </button>
          </div>
        </div>
      )}
    </>
  );
}
