"use client";

import { useState, useMemo, Fragment } from "react";
import { Check, FolderInput, FolderClosed, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { useScanStore } from "@/lib/store/scan-store";
import { moveFiles } from "@/app/actions";
import { FileRow } from "@/components/domain/file-row";
import { FolderPickerDialog } from "./folder-picker-dialog";

const DEFAULT_MOVE_PATH = "\\\\192.168.0.2\\torrent";

export function FileList() {
  const { files, selected, selectAll, selectDone, deselectAll, updateFileStatus, toggleFolderSelect } = useScanStore();

  console.log('[FileList] files.length:', files.length, 'selected.size:', selected.size);

  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [isMoving, setIsMoving] = useState(false);

  // 폴더별 그룹
  const folderGroups = useMemo(() => {
    console.log('[FileList] folderGroups creating, files:', files.length);
    const groups: { name: string; files: typeof files }[] = [];
    const map = new Map<string, typeof files>();

    for (const file of files) {
      const key = file.folderName || "_root";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(file);
    }

    for (const [name, groupFiles] of map) {
      console.log('[FileList] group:', name, 'count:', groupFiles.length);
      groups.push({ name, files: groupFiles });
    }
    console.log('[FileList] folderGroups result:', groups.length, 'groups');
    return groups;
  }, [files]);

  if (files.length === 0) {
    return (
      <div className="bg-surface-dark border border-border-dark rounded-xl p-12 text-center">
        <p className="text-sm text-zinc-500">
          스캔된 파일이 없습니다. 위에서 디렉토리를 스캔하세요.
        </p>
      </div>
    );
  }

  const selectableFiles = files.filter((f) => !["identifying", "renaming", "moved", "done"].includes(f.status));
  const selectedCount = selected.size;
  const allSelected = selectableFiles.length > 0 && selectableFiles.every((f) => selected.has(f.id));

  const readyCount = files.filter((f) => f.status === "ready").length;
  const doneCount = files.filter((f) => f.status === "done").length;
  const movedCount = files.filter((f) => f.status === "moved").length;
  const errorCount = files.filter((f) => f.status === "error").length;

  // 이동 대상: 선택된 모든 파일 (moved 제외)
  const movableSelected = files.filter((f) => selected.has(f.id) && f.status !== "moved");

  const handleToggleAll = () => {
    if (allSelected) deselectAll();
    else selectAll();
  };

  const handleMoveFiles = async (destinationPath: string) => {
    if (movableSelected.length === 0) return;

    setIsMoving(true);
    const filesToMove = movableSelected.map((f) => ({
      path: f.path,
      name: f.newName || f.name,
    }));

    const result = await moveFiles(filesToMove, destinationPath);

    if (result.success && result.data !== undefined) {
      const movedIds = movableSelected.slice(0, result.data).map((f) => f.id);
      movedIds.forEach((id) => updateFileStatus(id, "moved"));
      toast.success(`${result.data}/${movableSelected.length}개 파일 이동 완료`);
    } else {
      toast.error(result.error ?? "파일 이동 실패");
    }

    setIsMoving(false);
  };

  let globalIndex = 0;

  return (
    <div className="bg-surface-dark border border-border-dark rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-dark">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-zinc-200">스캔 결과</h2>
          <span className="text-xs text-zinc-500">{files.length}개 파일</span>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          {readyCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary">
              준비 {readyCount}
            </span>
          )}
          {doneCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary">
              완료 {doneCount}
            </span>
          )}
          {movedCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400">
              이동됨 {movedCount}
            </span>
          )}
          {errorCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-red-500/10 text-red-400">
              오류 {errorCount}
            </span>
          )}
        </div>
      </div>

      {/* Desktop Table */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full table-fixed">
          <thead>
            <tr className="bg-surface-darker text-left">
              <th className="px-3 py-2.5 w-10">
                <button
                  onClick={handleToggleAll}
                  className={`w-4.5 h-4.5 rounded border flex items-center justify-center transition-colors ${
                    allSelected
                      ? "bg-primary border-primary text-white"
                      : "border-zinc-600 hover:border-zinc-400"
                  }`}
                >
                  {allSelected && <Check className="w-3 h-3" />}
                </button>
              </th>
              <th className="pr-2 py-2.5 text-[11px] font-medium text-zinc-600 w-8">#</th>
              <th className="px-3 py-2.5 text-[11px] font-medium text-zinc-600 w-[25%]">원본 파일명</th>
              <th className="px-3 py-2.5 text-[11px] font-medium text-zinc-600">매칭 결과</th>
              <th className="px-3 py-2.5 text-[11px] font-medium text-zinc-600 w-20">크기</th>
              <th className="px-3 py-2.5 text-[11px] font-medium text-zinc-600 w-20">상태</th>
              <th className="px-3 py-2.5 w-16"></th>
            </tr>
          </thead>
          <tbody>
            {folderGroups.map((group) => {
              const selectableInGroup = group.files.filter((f) => f.status !== "moved" && f.status !== "identifying" && f.status !== "renaming");
              const allGroupSelected = selectableInGroup.length > 0 && selectableInGroup.every((f) => selected.has(f.id));
              const showFolderHeader = folderGroups.length > 1 && group.name !== "_root";

              return (
                <Fragment key={group.name}>
                  {showFolderHeader && (
                    <tr className="bg-surface-darker/70 border-b border-border-dark">
                      <td className="px-3 py-2" colSpan={7}>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => toggleFolderSelect(group.name)}
                            className={`w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 ${
                              allGroupSelected
                                ? "bg-blue-500 border-blue-500 text-white"
                                : "border-zinc-600 hover:border-zinc-400"
                            }`}
                          >
                            {allGroupSelected && <Check className="w-2.5 h-2.5" />}
                          </button>
                          <FolderClosed className="w-3.5 h-3.5 text-zinc-500" />
                          <span className="text-xs font-medium text-zinc-400">{group.name}</span>
                          <span className="text-[11px] text-zinc-600">{group.files.length}개</span>
                        </div>
                      </td>
                    </tr>
                  )}
                  {group.files.map((file) => {
                    const idx = globalIndex++;
                    return <FileRow key={file.id} file={file} index={idx} />;
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile Card View */}
      <div className="md:hidden divide-y divide-border-dark">
        {/* Select All bar */}
        <div className="flex items-center gap-3 px-4 py-2.5 bg-surface-darker">
          <button
            onClick={handleToggleAll}
            className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
              allSelected
                ? "bg-primary border-primary text-white"
                : "border-zinc-600 hover:border-zinc-400"
            }`}
          >
            {allSelected && <Check className="w-3 h-3" />}
          </button>
          <span className="text-xs text-zinc-500">전체 선택 ({files.length})</span>
        </div>
        {folderGroups.map((group) => {
          const showFolderHeader = folderGroups.length > 1 && group.name !== "_root";
          return (
            <Fragment key={group.name}>
              {showFolderHeader && (
                <div className="flex items-center gap-2 px-4 py-2 bg-surface-darker/70">
                  <FolderClosed className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="text-xs font-medium text-zinc-400">{group.name}</span>
                  <span className="text-[11px] text-zinc-600">{group.files.length}개</span>
                </div>
              )}
              {group.files.map((file) => {
                const isSelected = selected.has(file.id);
                const posterUrl = file.metadata?.posterPath
                  ? `https://image.tmdb.org/t/p/w92${file.metadata.posterPath}` : null;
                const statusLabel: Record<string, { text: string; cls: string }> = {
                  idle: { text: "대기", cls: "text-zinc-500" },
                  identifying: { text: "분석중", cls: "text-amber-400" },
                  ready: { text: "준비", cls: "text-primary" },
                  renaming: { text: "변경중", cls: "text-amber-400" },
                  done: { text: "완료", cls: "text-primary" },
                  moved: { text: "이동됨", cls: "text-blue-400" },
                  error: { text: "오류", cls: "text-red-400" },
                };
                const st = statusLabel[file.status] ?? statusLabel.idle;
                const sizeStr = file.size >= 1_073_741_824
                  ? `${(file.size / 1_073_741_824).toFixed(1)} GB`
                  : `${(file.size / 1_048_576).toFixed(0)} MB`;

                return (
                  <div
                    key={file.id}
                    className={`px-4 py-3 flex items-start gap-3 active:bg-zinc-800/50 ${isSelected ? "bg-primary/[0.03]" : ""}`}
                    onClick={() => useScanStore.getState().toggleSelect(file.id)}
                  >
                    <div className="pt-1 shrink-0">
                      <div className={`w-5 h-5 rounded border flex items-center justify-center ${
                        isSelected ? "bg-primary border-primary text-white" : "border-zinc-600"
                      }`}>
                        {isSelected && <Check className="w-3 h-3" />}
                      </div>
                    </div>
                    {posterUrl && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={posterUrl} alt="" className="w-10 h-14 rounded object-cover shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-zinc-200 truncate">
                        {file.newName || file.name}
                      </p>
                      {file.newName && (
                        <p className="text-[11px] text-zinc-600 truncate font-[family-name:var(--font-mono)]">
                          {file.name}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className={`text-[11px] font-medium ${st.cls}`}>{st.text}</span>
                        <span className="text-[11px] text-zinc-600">{sizeStr}</span>
                        {file.metadata?.imdbRating && (
                          <span className="text-[10px] text-amber-400">IMDb {file.metadata.imdbRating}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </div>

      {/* Move action bar - 선택된 파일이 있으면 항상 표시 */}
      {selectedCount > 0 && (
        <div className="px-4 py-3 border-t border-border-dark bg-blue-500/5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="flex items-center gap-3">
              <p className="text-xs text-blue-400">
                {selectedCount}개 선택됨
                {movableSelected.length < selectedCount && ` (이동 가능: ${movableSelected.length})`}
              </p>
              <button
                onClick={deselectAll}
                className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors underline underline-offset-2"
              >
                선택 해제
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleMoveFiles(DEFAULT_MOVE_PATH)}
                disabled={isMoving || movableSelected.length === 0}
                className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-lg hover:bg-blue-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isMoving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                기본 경로로 이동 ({movableSelected.length})
              </button>
              <button
                onClick={() => setShowFolderPicker(true)}
                disabled={isMoving || movableSelected.length === 0}
                className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-zinc-400 border border-border-dark rounded-lg hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <FolderInput className="w-3.5 h-3.5" />
                다른 폴더
              </button>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-zinc-500 font-[family-name:var(--font-mono)]">
            {DEFAULT_MOVE_PATH}
          </p>
        </div>
      )}

      <FolderPickerDialog
        open={showFolderPicker}
        onClose={() => setShowFolderPicker(false)}
        onSelect={handleMoveFiles}
        initialPath={DEFAULT_MOVE_PATH}
      />
    </div>
  );
}
