"use client";

import { useState } from "react";
import { Loader2, Check, RotateCcw, Pencil } from "lucide-react";
import type { FileItem } from "@/lib/types";
import { useScanStore } from "@/lib/store/scan-store";
import { formatFileSize } from "@/lib/utils";

interface FileRowProps {
  file: FileItem;
  index: number;
}

export function FileRow({ file, index }: FileRowProps) {
  const { selected, toggleSelect, updateFileStatus, updateFileName } = useScanStore();
  const isSelected = selected.has(file.id);
  const isSelectable = file.status !== "identifying" && file.status !== "renaming" && file.status !== "moved";

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");

  const handleRetry = () => {
    updateFileStatus(file.id, "idle", { error: undefined, metadata: undefined, newName: undefined });
  };

  const startEdit = () => {
    setEditValue(file.newName || "");
    setEditing(true);
  };

  const confirmEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== file.newName) {
      updateFileName(file.id, trimmed);
    }
    setEditing(false);
  };

  const posterUrl = file.metadata?.posterPath
    ? `https://image.tmdb.org/t/p/w92${file.metadata.posterPath}`
    : null;

  const rowBg = file.status === "moved"
    ? "bg-blue-500/5"
    : file.status === "done"
      ? "bg-primary/5"
      : file.status === "error"
        ? "bg-red-500/5"
        : isSelected
          ? "bg-primary/[0.03]"
          : "";

  return (
    <tr className={`border-b border-border-dark hover:bg-surface-darker/50 transition-colors ${rowBg}`}>
      {/* Checkbox */}
      <td className="px-3 py-3 w-10">
        {isSelectable ? (
          <button
            onClick={() => toggleSelect(file.id)}
            className={`w-4.5 h-4.5 rounded border flex items-center justify-center transition-colors ${
              isSelected
                ? "bg-primary border-primary text-white"
                : "border-zinc-600 hover:border-zinc-400"
            }`}
          >
            {isSelected && <Check className="w-3 h-3" />}
          </button>
        ) : file.status === "moved" ? (
          <div className="w-4.5 h-4.5 rounded bg-blue-500/20 flex items-center justify-center">
            <Check className="w-3 h-3 text-blue-400" />
          </div>
        ) : null}
      </td>

      {/* # */}
      <td className="pr-2 py-3 text-xs text-zinc-600 w-8">{index + 1}</td>

      {/* Original filename */}
      <td className="px-3 py-3">
        {file.folderName && (
          <span className="text-[11px] text-zinc-600 block truncate max-w-[240px]" title={file.folderName}>
            📁 {file.folderName}/
          </span>
        )}
        <span
          className={`text-sm font-[family-name:var(--font-mono)] block truncate max-w-[240px] ${
            file.status === "done" || file.status === "moved" ? "line-through text-zinc-600" : "text-zinc-300"
          }`}
          title={file.name}
        >
          {file.name}
        </span>
      </td>

      {/* Match result (editable) */}
      <td className="px-3 py-3">
        {file.status === "idle" && (
          <span className="text-xs text-zinc-700">&mdash;</span>
        )}

        {file.status === "identifying" && (
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            식별 중...
          </div>
        )}

        {(file.status === "ready" || file.status === "renaming" || file.status === "done" || file.status === "moved") &&
          file.metadata && (
            <div className="flex items-center gap-2">
              {posterUrl && (
                <img
                  src={posterUrl}
                  alt={file.metadata.title}
                  className="w-7 h-9 rounded object-cover shrink-0"
                />
              )}
              <div className="min-w-0 flex-1">
                {editing ? (
                  <input
                    autoFocus
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={confirmEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmEdit();
                      if (e.key === "Escape") setEditing(false);
                    }}
                    className="w-full bg-surface-darker border border-primary/30 rounded px-2 py-0.5 text-sm text-primary font-medium font-[family-name:var(--font-mono)] focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                ) : (
                  <div className="flex items-center gap-1 group/name">
                    <p
                      className="text-sm text-primary font-medium truncate max-w-[250px] cursor-text"
                      title={`${file.newName} (클릭하여 수정)`}
                      onClick={file.status === "ready" ? startEdit : undefined}
                    >
                      {file.newName}
                    </p>
                    {file.status === "ready" && (
                      <button
                        onClick={startEdit}
                        className="opacity-0 group-hover/name:opacity-100 p-0.5 text-zinc-500 hover:text-primary transition-all"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                )}
                <p className="text-[11px] text-zinc-500 truncate max-w-[280px]">
                  {file.metadata.title} ({file.metadata.year})
                  {file.metadata.imdbRating && (
                    <span className="ml-1.5 text-amber-400" title="IMDb">
                      IMDb {file.metadata.imdbRating}
                    </span>
                  )}
                  {file.metadata.rottenTomatoes && (
                    <span className="ml-1.5 text-red-400" title="Rotten Tomatoes">
                      RT {file.metadata.rottenTomatoes}
                    </span>
                  )}
                  {file.metadata.metacritic && (
                    <span className="ml-1.5 text-blue-400" title="Metacritic">
                      MC {file.metadata.metacritic}
                    </span>
                  )}
                </p>
              </div>
            </div>
          )}

        {file.status === "error" && (
          <span className="text-xs text-red-400">{file.error}</span>
        )}
      </td>

      {/* Size */}
      <td className="px-3 py-3 w-20">
        <span className="text-xs text-zinc-600">{formatFileSize(file.size)}</span>
      </td>

      {/* Status */}
      <td className="px-3 py-3 w-20">
        <StatusBadge status={file.status} />
      </td>

      {/* Action */}
      <td className="px-3 py-3 w-16 text-right">
        {file.status === "error" && (
          <button
            onClick={handleRetry}
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-red-400 bg-red-500/10 rounded hover:bg-red-500/20 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            재시도
          </button>
        )}
        {file.status === "renaming" && (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-primary inline-block" />
        )}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: FileItem["status"] }) {
  switch (status) {
    case "idle":
      return <span className="text-[11px] text-zinc-600">대기</span>;
    case "identifying":
      return <span className="text-[11px] text-amber-400">식별 중</span>;
    case "ready":
      return <span className="text-[11px] text-primary font-medium">준비</span>;
    case "renaming":
      return <span className="text-[11px] text-amber-400">변경 중</span>;
    case "done":
      return <span className="text-[11px] text-primary font-medium">완료</span>;
    case "moved":
      return <span className="text-[11px] text-blue-400 font-medium">이동됨</span>;
    case "error":
      return <span className="text-[11px] text-red-400">오류</span>;
  }
}
