"use client";

import { useState, useCallback, useEffect } from "react";
import {
  FolderOpen,
  FolderClosed,
  FolderPlus,
  ChevronRight,
  HardDrive,
  ArrowUp,
  Loader2,
  X,
  Network,
  Check,
} from "lucide-react";
import { browseDirectory, createFolder } from "@/app/actions";
import type { DirEntry } from "@/app/actions";

interface FolderPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  initialPath?: string;
}

export function FolderPickerDialog({
  open,
  onClose,
  onSelect,
  initialPath,
}: FolderPickerDialogProps) {
  const [currentPath, setCurrentPath] = useState("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkInput, setNetworkInput] = useState("");
  const [showNetworkInput, setShowNetworkInput] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  const loadDirectory = useCallback(async (dirPath?: string) => {
    setLoading(true);
    setError(null);

    const result = await browseDirectory(dirPath);

    if (result.success && result.data) {
      setCurrentPath(result.data.current);
      setParentPath(result.data.parent);
      setDirs(result.data.dirs);
    } else {
      setError(result.error ?? "알 수 없는 오류");
    }

    setLoading(false);
  }, []);

  const handleCreateFolder = async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed || !currentPath || creatingFolder) return;

    setCreatingFolder(true);
    const result = await createFolder(currentPath, trimmed);
    setCreatingFolder(false);

    if (result.success && result.data) {
      setShowNewFolder(false);
      setNewFolderName("");
      // 생성된 폴더로 자동 진입
      loadDirectory(result.data);
    } else {
      setError(result.error ?? "폴더 생성 실패");
    }
  };

  useEffect(() => {
    if (open) {
      setShowNetworkInput(false);
      setNetworkInput("");
      setShowNewFolder(false);
      setNewFolderName("");
      loadDirectory(initialPath || undefined);
    }
  }, [open, initialPath, loadDirectory]);

  if (!open) return null;

  const isUnc = currentPath.startsWith("\\\\") || currentPath.startsWith("//");
  const breadcrumbs = currentPath
    ? currentPath.replace(/^[\\/]{2}/, "").split(/[\\/]/).filter(Boolean)
    : [];

  const handleBreadcrumbClick = (index: number) => {
    if (index < 0) {
      loadDirectory(undefined);
      return;
    }
    const parts = breadcrumbs.slice(0, index + 1);
    if (isUnc) {
      loadDirectory("//" + parts.join("/"));
    } else {
      const isWindows = currentPath.includes("\\") || /^[A-Z]:/.test(currentPath);
      const targetPath = isWindows
        ? parts[0] + "\\" + parts.slice(1).join("\\")
        : "/" + parts.join("/");
      loadDirectory(targetPath);
    }
  };

  const handleNetworkConnect = () => {
    const trimmed = networkInput.trim();
    if (!trimmed) return;
    // Normalize to forward-slash UNC
    const cleaned = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
    const uncPath = "//" + cleaned;
    setShowNetworkInput(false);
    setNetworkInput("");
    loadDirectory(uncPath);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative w-full max-w-lg mx-2 md:mx-4 bg-surface-dark border border-border-dark rounded-xl shadow-2xl overflow-hidden max-h-[90vh] md:max-h-none flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-dark bg-surface-darker">
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-primary" />
            폴더 선택
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                if (currentPath) {
                  setShowNewFolder(!showNewFolder);
                  setShowNetworkInput(false);
                }
              }}
              disabled={!currentPath}
              className={`p-1.5 rounded-md transition-colors ${
                showNewFolder
                  ? "text-primary bg-primary/10"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
              }`}
              title="새 폴더 만들기"
            >
              <FolderPlus className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                setShowNetworkInput(!showNetworkInput);
                setShowNewFolder(false);
              }}
              className={`p-1.5 rounded-md transition-colors ${
                showNetworkInput
                  ? "text-primary bg-primary/10"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800"
              }`}
              title="네트워크 경로 (SMB)"
            >
              <Network className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Network input */}
        {showNetworkInput && (
          <div className="px-5 py-3 border-b border-border-dark bg-surface-darker/50">
            <label className="block text-xs text-zinc-500 mb-1.5">
              네트워크 경로 (SMB)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={networkInput}
                onChange={(e) => setNetworkInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleNetworkConnect();
                }}
                placeholder="\\\\서버이름\\공유폴더"
                className="flex-1 bg-surface-darker border border-border-dark rounded-lg px-3 py-1.5 text-sm font-[family-name:var(--font-mono)] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
              <button
                onClick={handleNetworkConnect}
                disabled={!networkInput.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-primary/20 border border-primary/30 rounded-lg text-primary hover:bg-primary/30 transition-colors disabled:opacity-50"
              >
                연결
              </button>
            </div>
          </div>
        )}

        {/* New folder input */}
        {showNewFolder && (
          <div className="px-5 py-3 border-b border-border-dark bg-surface-darker/50">
            <label className="block text-xs text-zinc-500 mb-1.5">
              새 폴더 이름
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                autoFocus
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreateFolder();
                  if (e.key === "Escape") {
                    setShowNewFolder(false);
                    setNewFolderName("");
                  }
                }}
                placeholder="폴더 이름 입력"
                className="flex-1 bg-surface-darker border border-border-dark rounded-lg px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-primary/50"
              />
              <button
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || creatingFolder}
                className="px-3 py-1.5 text-xs font-medium bg-primary/20 border border-primary/30 rounded-lg text-primary hover:bg-primary/30 transition-colors disabled:opacity-50 flex items-center gap-1"
              >
                {creatingFolder ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Check className="w-3 h-3" />
                )}
                생성
              </button>
            </div>
          </div>
        )}

        {/* Breadcrumb */}
        <div className="px-5 py-2.5 border-b border-border-dark bg-background-dark flex items-center gap-1 text-xs overflow-x-auto">
          <button
            onClick={() => handleBreadcrumbClick(-1)}
            className="shrink-0 px-1.5 py-0.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            {isUnc ? (
              <Network className="w-3.5 h-3.5" />
            ) : (
              <HardDrive className="w-3.5 h-3.5" />
            )}
          </button>
          {breadcrumbs.map((part, i) => (
            <span key={i} className="flex items-center gap-1 shrink-0">
              <ChevronRight className="w-3 h-3 text-zinc-600" />
              <button
                onClick={() => handleBreadcrumbClick(i)}
                className={`px-1.5 py-0.5 rounded transition-colors ${
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

        {/* Directory List */}
        <div className="max-h-60 md:max-h-80 overflow-y-auto flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
            </div>
          ) : error ? (
            <div className="px-5 py-8 text-center text-sm text-red-400">
              {error}
            </div>
          ) : (
            <div className="py-1">
              {/* Go up */}
              {parentPath !== null && (
                <button
                  onClick={() => loadDirectory(parentPath || undefined)}
                  className="w-full flex items-center gap-3 px-4 md:px-5 py-3 md:py-2.5 text-sm min-h-[44px] text-zinc-400 hover:bg-zinc-800/50 transition-colors"
                >
                  <ArrowUp className="w-4 h-4" />
                  <span>상위 폴더</span>
                </button>
              )}

              {dirs.length === 0 && parentPath === null && (
                <div className="px-5 py-8 text-center text-sm text-zinc-500">
                  하위 폴더가 없습니다
                </div>
              )}

              {dirs.map((dir) => (
                <button
                  key={dir.path}
                  onClick={() => loadDirectory(dir.path)}
                  className="w-full flex items-center gap-3 px-4 md:px-5 py-3 md:py-2.5 text-sm min-h-[44px] text-zinc-200 hover:bg-zinc-800/50 transition-colors group"
                >
                  <FolderClosed className="w-4 h-4 text-zinc-500 group-hover:text-primary transition-colors shrink-0" />
                  <span className="truncate text-left">{dir.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border-dark bg-surface-darker">
          <p className="text-xs text-zinc-500 truncate max-w-[180px] md:max-w-[260px] font-[family-name:var(--font-mono)]">
            {currentPath || "드라이브를 선택하세요"}
          </p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs font-medium text-zinc-400 border border-border-dark rounded-lg hover:bg-zinc-800 transition-colors"
            >
              취소
            </button>
            <button
              onClick={() => {
                if (currentPath) {
                  onSelect(currentPath);
                  onClose();
                }
              }}
              disabled={!currentPath}
              className="px-4 py-1.5 text-xs font-medium text-white bg-primary/20 border border-primary/30 rounded-lg hover:bg-primary/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              선택
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
