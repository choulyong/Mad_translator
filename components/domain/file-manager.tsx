"use client";

import { useState, useCallback, useEffect } from "react";
import {
  FolderClosed,
  FolderOpen,
  FileText,
  ArrowUp,
  Copy,
  Scissors,
  ClipboardPaste,
  Trash2,
  Pencil,
  FolderPlus,
  RefreshCw,
  Loader2,
  Check,
  ChevronRight,
  HardDrive,
  Network,
  Film,
  FileVideo,
  FileImage,
  FileArchive,
  File,
  Files,
} from "lucide-react";
import { toast } from "sonner";
import { useFileManagerStore } from "@/lib/store/file-manager-store";
import {
  listDirectory,
  copyItems,
  deleteItems,
  renameItem,
  moveItems,
  createFolder,
  scanDuplicates,
} from "@/app/actions";
import type { FMEntry } from "@/app/actions";
import { formatFileSize } from "@/lib/utils";
import { FolderPickerDialog } from "./folder-picker-dialog";

function getFileIcon(entry: FMEntry) {
  if (entry.isDirectory) return FolderClosed;
  const ext = entry.name.split(".").pop()?.toLowerCase() || "";
  if (["mkv", "mp4", "avi", "wmv", "mov", "flv", "webm"].includes(ext)) return FileVideo;
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"].includes(ext)) return FileImage;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return FileArchive;
  if (["srt", "smi", "ass", "ssa", "sub", "txt", "nfo"].includes(ext)) return FileText;
  return File;
}

function getFileIconColor(entry: FMEntry) {
  if (entry.isDirectory) return "text-amber-400";
  const ext = entry.name.split(".").pop()?.toLowerCase() || "";
  if (["mkv", "mp4", "avi", "wmv", "mov", "flv", "webm"].includes(ext)) return "text-blue-400";
  if (["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"].includes(ext)) return "text-pink-400";
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "text-orange-400";
  if (["srt", "smi", "ass", "ssa", "sub"].includes(ext)) return "text-green-400";
  return "text-zinc-500";
}

export function FileManager() {
  const {
    currentPath,
    parentPath,
    entries,
    selected,
    loading,
    error,
    clipboard,
    setDirectory,
    setLoading,
    setError,
    toggleSelect,
    selectAll,
    deselectAll,
    setClipboard,
    clearClipboard,
  } = useFileManagerStore();

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newFolderMode, setNewFolderMode] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [moveMode, setMoveMode] = useState<"move" | "copy">("move");
  const [addressInput, setAddressInput] = useState(currentPath);
  const [addressEditing, setAddressEditing] = useState(false);
  const [duplicateMode, setDuplicateMode] = useState(false);
  const [duplicateGroups, setDuplicateGroups] = useState<FMEntry[][]>([]);
  const [duplicateLoading, setDuplicateLoading] = useState(false);
  const [duplicateSelected, setDuplicateSelected] = useState<Set<string>>(new Set());

  const loadDir = useCallback(
    async (dirPath: string) => {
      setLoading(true);
      setError(null);
      const result = await listDirectory(dirPath);
      if (result.success && result.data) {
        setDirectory(result.data.current, result.data.parent, result.data.entries);
        setAddressInput(result.data.current);
      } else {
        setError(result.error ?? "디렉토리를 읽을 수 없습니다");
      }
      setLoading(false);
    },
    [setDirectory, setLoading, setError]
  );

  // 초기 로드
  useEffect(() => {
    loadDir(currentPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => loadDir(currentPath);

  // 중복 파일 탐색
  const handleScanDuplicates = async () => {
    setDuplicateLoading(true);
    const result = await scanDuplicates(currentPath);
    if (result.success && result.data) {
      setDuplicateGroups(result.data.duplicates);
      setDuplicateMode(true);
      setDuplicateSelected(new Set());
      if (result.data.totalDuplicates === 0) {
        toast.info("중복 파일이 없습니다");
      } else {
        toast.info(`${result.data.totalDuplicates}개의 중복 파일 발견`);
      }
    } else {
      toast.error(result.error ?? "중복 탐색 실패");
    }
    setDuplicateLoading(false);
  };

  // 중복 파일 삭제
  const handleDeleteDuplicates = async () => {
    if (duplicateSelected.size === 0) {
      toast.info("삭제할 파일을 선택하세요");
      return;
    }

    const pathsToDelete = Array.from(duplicateSelected);
    const result = await deleteItems(pathsToDelete);

    if (result.success) {
      toast.success(`${result.data}개 파일 삭제 완료`);
      // 다시 중복 탐색
      handleScanDuplicates();
    } else {
      toast.error(result.error ?? "삭제 실패");
    }
  };

  // 중복 모드 종료
  const handleExitDuplicateMode = () => {
    setDuplicateMode(false);
    setDuplicateGroups([]);
    setDuplicateSelected(new Set());
  };

  const handleDoubleClick = (entry: FMEntry) => {
    if (entry.isDirectory) {
      loadDir(entry.path);
    }
  };

  const handleGoUp = () => {
    if (parentPath) loadDir(parentPath);
  };

  // 주소 입력으로 이동
  const handleAddressSubmit = () => {
    const trimmed = addressInput.trim();
    if (trimmed && trimmed !== currentPath) {
      loadDir(trimmed);
    }
    setAddressEditing(false);
  };

  // 복사
  const handleCopy = () => {
    if (selected.size === 0) return;
    setClipboard(Array.from(selected), "copy");
    toast.success(`${selected.size}개 항목 복사됨`);
  };

  // 잘라내기
  const handleCut = () => {
    if (selected.size === 0) return;
    setClipboard(Array.from(selected), "move");
    toast.success(`${selected.size}개 항목 잘라내기`);
  };

  // 붙여넣기
  const handlePaste = async () => {
    if (!clipboard) return;
    setLoading(true);

    if (clipboard.mode === "copy") {
      const result = await copyItems(clipboard.paths, currentPath);
      if (result.success) {
        toast.success(`${result.data}개 항목 복사 완료`);
      } else {
        toast.error(result.error ?? "복사 실패");
      }
    } else {
      const result = await moveItems(clipboard.paths, currentPath);
      if (result.success) {
        toast.success(`${result.data}개 항목 이동 완료`);
        clearClipboard();
      } else {
        toast.error(result.error ?? "이동 실패");
      }
    }

    loadDir(currentPath);
  };

  // 삭제
  const handleDelete = async () => {
    if (selected.size === 0) return;
    const paths = Array.from(selected);
    setLoading(true);

    const result = await deleteItems(paths);
    if (result.success) {
      toast.success(`${result.data}개 항목 삭제됨`);
    } else {
      toast.error(result.error ?? "삭제 실패");
    }

    loadDir(currentPath);
  };

  // 이름 변경 시작
  const startRename = () => {
    if (selected.size !== 1) return;
    const selectedPath = Array.from(selected)[0];
    const entry = entries.find((e) => e.path === selectedPath);
    if (!entry) return;
    setRenamingPath(selectedPath);
    setRenameValue(entry.name);
  };

  // 이름 변경 확정
  const confirmRename = async () => {
    if (!renamingPath) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingPath(null);
      return;
    }

    setLoading(true);
    const result = await renameItem(renamingPath, trimmed);
    if (result.success) {
      toast.success("이름 변경 완료");
    } else {
      toast.error(result.error ?? "이름 변경 실패");
    }
    setRenamingPath(null);
    loadDir(currentPath);
  };

  // 새 폴더
  const handleCreateFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setNewFolderMode(false);
      return;
    }

    setLoading(true);
    const result = await createFolder(currentPath, trimmed);
    if (result.success) {
      toast.success(`폴더 "${trimmed}" 생성됨`);
    } else {
      toast.error(result.error ?? "폴더 생성 실패");
    }
    setNewFolderMode(false);
    setNewFolderName("");
    loadDir(currentPath);
  };

  // 이동 대상 폴더 선택
  const handleMoveTo = (destPath: string) => {
    setMovePickerOpen(false);
    const paths = Array.from(selected);
    if (paths.length === 0) return;

    (async () => {
      setLoading(true);
      if (moveMode === "move") {
        const result = await moveItems(paths, destPath);
        if (result.success) {
          toast.success(`${result.data}개 항목 이동 완료`);
        } else {
          toast.error(result.error ?? "이동 실패");
        }
      } else {
        const result = await copyItems(paths, destPath);
        if (result.success) {
          toast.success(`${result.data}개 항목 복사 완료`);
        } else {
          toast.error(result.error ?? "복사 실패");
        }
      }
      loadDir(currentPath);
    })();
  };

  const selectedCount = selected.size;
  const allSelected = entries.length > 0 && entries.every((e) => selected.has(e.path));

  // 브레드크럼
  const isUnc = currentPath.startsWith("\\\\");
  const breadcrumbs = currentPath
    ? currentPath.replace(/^\\\\/, "").split(/[\\/]/).filter(Boolean)
    : [];

  const handleBreadcrumbClick = (index: number) => {
    const parts = breadcrumbs.slice(0, index + 1);
    if (isUnc) {
      loadDir("\\\\" + parts.join("\\"));
    } else {
      const isWindows = currentPath.includes("\\") || /^[A-Z]:/.test(currentPath);
      const targetPath = isWindows
        ? parts[0] + "\\" + parts.slice(1).join("\\")
        : "/" + parts.join("/");
      loadDir(targetPath);
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Single scroll container */}
      <div className="flex-1 overflow-auto min-h-0">
        {/* Sticky toolbar + address bar group */}
        <div className="sticky top-0 z-10">
          {/* Toolbar */}
          <div className="flex items-center gap-1 px-3 py-2 border-b border-border-dark bg-surface-darker overflow-x-auto">
            <button
              onClick={handleGoUp}
              disabled={!parentPath || loading}
              className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="상위 폴더"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
            <button
              onClick={refresh}
              disabled={loading}
              className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-30"
              title="새로고침"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
            </button>

            <div className="w-px h-5 bg-border-dark mx-1" />

            <button
              onClick={() => setNewFolderMode(true)}
              disabled={loading}
              className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-30"
              title="새 폴더"
            >
              <FolderPlus className="w-4 h-4" />
            </button>
            <button
              onClick={handleScanDuplicates}
              disabled={loading || duplicateLoading}
              className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-30"
              title="중복 파일 탐색"
            >
              {duplicateLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Files className="w-4 h-4" />
              )}
            </button>

            <div className="w-px h-5 bg-border-dark mx-1" />

            <button
              onClick={handleCut}
              disabled={selectedCount === 0 || loading}
              className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="잘라내기 (이동)"
            >
              <Scissors className="w-4 h-4" />
            </button>
            <button
              onClick={handleCopy}
              disabled={selectedCount === 0 || loading}
              className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="복사"
            >
              <Copy className="w-4 h-4" />
            </button>
            <button
              onClick={handlePaste}
              disabled={!clipboard || loading}
              className={`p-1.5 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                clipboard
                  ? "text-primary hover:text-primary hover:bg-primary/10"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800"
              }`}
              title={clipboard ? `붙여넣기 (${clipboard.mode === "copy" ? "복사" : "이동"} ${clipboard.paths.length}개)` : "붙여넣기"}
            >
              <ClipboardPaste className="w-4 h-4" />
            </button>

            <div className="w-px h-5 bg-border-dark mx-1" />

            <button
              onClick={startRename}
              disabled={selectedCount !== 1 || loading}
              className="p-1.5 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="이름 변경"
            >
              <Pencil className="w-4 h-4" />
            </button>
            <button
              onClick={handleDelete}
              disabled={selectedCount === 0 || loading}
              className="p-1.5 rounded-md text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="삭제"
            >
              <Trash2 className="w-4 h-4" />
            </button>

            <div className="w-px h-5 bg-border-dark mx-1" />

            {/* 이동/복사 대상 선택 */}
            <button
              onClick={() => {
                setMoveMode("move");
                setMovePickerOpen(true);
              }}
              disabled={selectedCount === 0 || loading}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-zinc-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="선택 항목을 다른 폴더로 이동"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              이동
            </button>
            <button
              onClick={() => {
                setMoveMode("copy");
                setMovePickerOpen(true);
              }}
              disabled={selectedCount === 0 || loading}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-zinc-400 hover:text-green-400 hover:bg-green-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              title="선택 항목을 다른 폴더로 복사"
            >
              <Copy className="w-3.5 h-3.5" />
              복사
            </button>
          </div>

          {/* Address bar */}
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-dark bg-surface-dark">
            {addressEditing ? (
              <input
                autoFocus
                value={addressInput}
                onChange={(e) => setAddressInput(e.target.value)}
                onBlur={handleAddressSubmit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddressSubmit();
                  if (e.key === "Escape") {
                    setAddressInput(currentPath);
                    setAddressEditing(false);
                  }
                }}
                className="flex-1 bg-surface-darker border border-primary/30 rounded px-2 py-1 text-xs font-[family-name:var(--font-mono)] text-zinc-200 focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            ) : (
              <div
                className="flex-1 flex items-center gap-0.5 overflow-x-auto text-xs cursor-pointer"
                onClick={() => setAddressEditing(true)}
              >
                <span className="shrink-0 p-0.5 text-zinc-500">
                  {isUnc ? <Network className="w-3.5 h-3.5" /> : <HardDrive className="w-3.5 h-3.5" />}
                </span>
                {breadcrumbs.map((part, i) => (
                  <span key={i} className="flex items-center gap-0.5 shrink-0">
                    <ChevronRight className="w-3 h-3 text-zinc-600" />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleBreadcrumbClick(i);
                      }}
                      className={`px-1 py-0.5 rounded transition-colors ${
                        i === breadcrumbs.length - 1
                          ? "text-zinc-200 font-medium"
                          : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
                      }`}
                    >
                      {part}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Clipboard indicator */}
          {clipboard && (
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-dark bg-background-dark text-xs">
              <span className="text-primary">
                {clipboard.mode === "copy" ? "복사" : "이동"} 대기: {clipboard.paths.length}개 항목
              </span>
              <button
                onClick={clearClipboard}
                className="text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                취소
              </button>
            </div>
          )}

          {/* New folder input */}
          {newFolderMode && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border-dark bg-surface-darker">
              <FolderPlus className="w-4 h-4 text-primary shrink-0" />
              <input
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateFolder();
                  if (e.key === "Escape") {
                    setNewFolderMode(false);
                    setNewFolderName("");
                  }
                }}
                onBlur={handleCreateFolder}
                placeholder="새 폴더 이름"
                className="flex-1 bg-surface-darker border border-primary/30 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
            </div>
          )}
        </div>

        {/* File list */}
        {loading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-sm text-red-400">{error}</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b border-border-dark bg-surface-darker">
                <th className="px-2 py-2 w-8">
                  <button
                    onClick={allSelected ? deselectAll : selectAll}
                    className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                      allSelected
                        ? "bg-primary border-primary text-white"
                        : "border-zinc-600 hover:border-zinc-400"
                    }`}
                  >
                    {allSelected && <Check className="w-2.5 h-2.5" />}
                  </button>
                </th>
                <th className="px-2 py-2 font-medium text-zinc-500">이름</th>
                <th className="px-2 py-2 font-medium text-zinc-500 w-16 md:w-24 text-right">크기</th>
                <th className="px-2 py-2 font-medium text-zinc-500 w-28 hidden md:table-cell">수정일</th>
              </tr>
            </thead>
            <tbody>
              {/* 중복 파일 모드 */}
              {duplicateMode && (
                <>
                  <tr className="border-b border-border-dark bg-surface-darker">
                    <td colSpan={5} className="px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-zinc-400">
                          중복 파일 {duplicateGroups.length}개 그룹, {duplicateSelected.size}개 선택됨
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleScanDuplicates}
                            disabled={duplicateLoading}
                            className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded transition-colors"
                          >
                            다시 검색
                          </button>
                          <button
                            onClick={handleDeleteDuplicates}
                            disabled={duplicateSelected.size === 0}
                            className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors disabled:opacity-50"
                          >
                            선택 삭제 ({duplicateSelected.size})
                          </button>
                          <button
                            onClick={handleExitDuplicateMode}
                            className="px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 rounded transition-colors"
                          >
                            닫기
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                  {duplicateGroups.map((group, groupIdx) => (
                    <tr key={groupIdx} className="border-b border-border-dark/30">
                      <td colSpan={5} className="px-3 py-2 bg-red-900/10">
                        <div className="text-xs text-red-400 mb-1">그룹 {groupIdx + 1}: {group.length}개 파일</div>
                        {group.map((file) => {
                          const isSelected = duplicateSelected.has(file.path);
                          return (
                            <div
                              key={file.path}
                              className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer ${
                                isSelected ? "bg-red-900/30" : "hover:bg-zinc-800"
                              }`}
                              onClick={() => {
                                const newSelected = new Set(duplicateSelected);
                                if (isSelected) {
                                  newSelected.delete(file.path);
                                } else {
                                  newSelected.add(file.path);
                                }
                                setDuplicateSelected(newSelected);
                              }}
                            >
                              <div
                                className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                                  isSelected
                                    ? "bg-red-600 border-red-600 text-white"
                                    : "border-zinc-600"
                                }`}
                              >
                                {isSelected && <Check className="w-2.5 h-2.5" />}
                              </div>
                              <File className="w-4 h-4 text-zinc-500 shrink-0" />
                              <span className="text-sm text-zinc-300 truncate flex-1">{file.name}</span>
                              <span className="text-xs text-zinc-500">{formatFileSize(file.size)}</span>
                            </div>
                          );
                        })}
                      </td>
                    </tr>
                  ))}
                </>
              )}
              {/* 일반 파일 목록 */}
              {!duplicateMode && entries.map((entry) => {
                const isSelected = selected.has(entry.path);
                const isRenaming = renamingPath === entry.path;
                const Icon = getFileIcon(entry);
                const iconColor = getFileIconColor(entry);
                const isCut = clipboard?.mode === "move" && clipboard.paths.includes(entry.path);

                return (
                  <tr
                    key={entry.path}
                    className={`border-b border-border-dark/50 hover:bg-surface-darker/50 cursor-pointer transition-colors ${
                      isSelected ? "bg-primary/[0.06]" : ""
                    } ${isCut ? "opacity-50" : ""}`}
                    onClick={() => toggleSelect(entry.path)}
                    onDoubleClick={() => handleDoubleClick(entry)}
                  >
                    <td className="px-2 py-2 md:py-1.5">
                      <div
                        className={`w-5 h-5 md:w-4 md:h-4 rounded border flex items-center justify-center transition-colors ${
                          isSelected
                            ? "bg-primary border-primary text-white"
                            : "border-zinc-600"
                        }`}
                      >
                        {isSelected && <Check className="w-2.5 h-2.5" />}
                      </div>
                    </td>
                    <td className="px-2 py-2 md:py-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon className={`w-4 h-4 shrink-0 ${iconColor}`} />
                        {isRenaming ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onBlur={confirmRename}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") confirmRename();
                              if (e.key === "Escape") setRenamingPath(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                            className="flex-1 bg-surface-darker border border-primary/30 rounded px-1.5 py-0.5 text-xs text-zinc-200 font-[family-name:var(--font-mono)] focus:outline-none focus:ring-1 focus:ring-primary/50"
                          />
                        ) : (
                          <span className="truncate text-zinc-200 font-[family-name:var(--font-mono)]">
                            {entry.name}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-2 md:py-1.5 text-right text-zinc-500">
                      {entry.isDirectory ? "--" : formatFileSize(entry.size)}
                    </td>
                    <td className="px-2 py-2 md:py-1.5 text-zinc-500 hidden md:table-cell">
                      {formatDate(entry.modifiedAt)}
                    </td>
                  </tr>
                );
              })}
              {entries.length === 0 && !loading && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-zinc-500">
                    빈 폴더입니다
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-border-dark bg-surface-darker text-[11px] text-zinc-500">
        <span>{entries.length}개 항목</span>
        <span>
          {selectedCount > 0 && `${selectedCount}개 선택`}
        </span>
      </div>

      {/* 이동/복사 대상 폴더 선택 다이얼로그 */}
      <FolderPickerDialog
        open={movePickerOpen}
        onClose={() => setMovePickerOpen(false)}
        onSelect={handleMoveTo}
        initialPath={currentPath}
      />
    </div>
  );
}
