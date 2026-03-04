"use client";

import { useState } from "react";
import { PenLine, Loader2, FolderInput } from "lucide-react";
import { toast } from "sonner";
import { useScanStore } from "@/lib/store/scan-store";
import { processRename, moveFiles, moveToNoChoice } from "@/app/actions";
import { FolderPickerDialog } from "./folder-picker-dialog";

export function BatchActions() {
  const { files, selected, updateFileStatus, updateFileName, removeFiles } = useScanStore();
  const [isRenaming, setIsRenaming] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [progress, setProgress] = useState("");
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  const selectedReadyFiles = files.filter(
    (f) => f.status === "ready" && selected.has(f.id)
  );

  const selectedDoneFiles = files.filter(
    (f) => f.status === "done" && selected.has(f.id)
  );

  const handleRenameSelected = async () => {
    if (selectedReadyFiles.length === 0) {
      toast.info("변경할 파일을 선택하세요");
      return;
    }

    const filesWithMeta = selectedReadyFiles.filter(f => f.metadata);
    if (filesWithMeta.length === 0) {
      toast.error("메타데이터가 없습니다");
      return;
    }

    setIsRenaming(true);

    // 선택 안 된 파일들 (nochoice로 이동할 대상)
    const unselectedFiles = files.filter((f) => f.status === "ready" && !selected.has(f.id));

    // 1. 선택된 파일 이름 변경
    let successCount = 0;
    let errorCount = 0;
    const BATCH_SIZE = 100;

    for (let i = 0; i < filesWithMeta.length; i += BATCH_SIZE) {
      const batch = filesWithMeta.slice(i, i + BATCH_SIZE);
      setProgress(`이름 변경 중... (${Math.min(i + BATCH_SIZE, filesWithMeta.length)}/${filesWithMeta.length})`);

      // 배치 내 순차 처리 (네트워크 경로 안정성)
      for (const file of batch) {
        updateFileStatus(file.id, "renaming");
        try {
          const result = await processRename(file.path, file.metadata!, file.folderPath);
          if (result.success && result.data) {
            updateFileStatus(file.id, "done");
            updateFileName(file.id, result.data.newName);
            successCount++;
          } else {
            updateFileStatus(file.id, "error", { error: result.error || "failed" });
            errorCount++;
          }
        } catch (err) {
          updateFileStatus(file.id, "error", { error: err instanceof Error ? err.message : "failed" });
          errorCount++;
        }
      }
    }

    // 2. 선택 안 된 파일 nochoice 폴더로 이동
    if (unselectedFiles.length > 0) {
      setProgress("선택 안 된 파일 nochoice 폴더로 이동 중...");

      const unselectedPaths = unselectedFiles.map((f) => f.path);
      const result = await moveToNoChoice(unselectedPaths);

      if (result.success && result.data) {
        if (result.data.movedCount > 0) {
          // 이동 성공한 파일들을 목록에서 제거
          const movedIds = unselectedFiles.slice(0, result.data.movedCount).map((f) => f.id);
          removeFiles(movedIds);
          toast.info(`${result.data.movedCount}개 파일을 nochoice 폴더로 이동`);
        }
      }
    }

    setIsRenaming(false);
    setProgress("");
    toast.success(`${successCount}개 변경 완료, ${errorCount}개 실패`);
  };

  const handleMoveFiles = async (destinationPath: string) => {
    if (selectedDoneFiles.length === 0) return;

    setIsMoving(true);
    setProgress(`이동 중... 0/${selectedDoneFiles.length}`);

    const filesToMove = selectedDoneFiles.map((f) => ({
      path: f.path,
      name: f.newName || f.name,
    }));

    const result = await moveFiles(filesToMove, destinationPath);

    if (result.success && result.data !== undefined) {
      const movedCount = result.data;
      // 이동 성공한 파일들의 상태 변경
      const movedIds = selectedDoneFiles.slice(0, movedCount).map((f) => f.id);
      movedIds.forEach((id) => updateFileStatus(id, "moved"));
      toast.success(`${movedCount}/${selectedDoneFiles.length}개 파일 이동 완료`);
    } else {
      toast.error(result.error ?? "파일 이동 실패");
    }

    setIsMoving(false);
    setProgress("");
  };

  if (files.length === 0) return null;

  return (
    <div className="flex items-center gap-2 md:gap-3 flex-wrap">
      {(isRenaming || isMoving) && (
        <span className="text-xs text-zinc-400">{progress}</span>
      )}

      <button
        onClick={handleRenameSelected}
        disabled={isRenaming || isMoving || selectedReadyFiles.length === 0}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary rounded-lg shadow-[0_0_15px_-3px_rgba(23,207,90,0.3)] hover:bg-primary-dark transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
      >
        {isRenaming ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <PenLine className="w-4 h-4" />
        )}
        <span className="hidden md:inline">선택 항목 변경</span>
        <span className="md:hidden">변경</span>
        {selectedReadyFiles.length > 0 && ` (${selectedReadyFiles.length})`}
      </button>

      <button
        onClick={() => setShowFolderPicker(true)}
        disabled={isRenaming || isMoving || selectedDoneFiles.length === 0}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded-lg hover:bg-blue-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {isMoving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <FolderInput className="w-4 h-4" />
        )}
        <span className="hidden md:inline">폴더로 이동</span>
        <span className="md:hidden">이동</span>
        {selectedDoneFiles.length > 0 && ` (${selectedDoneFiles.length})`}
      </button>

      <FolderPickerDialog
        open={showFolderPicker}
        onClose={() => setShowFolderPicker(false)}
        onSelect={handleMoveFiles}
        initialPath="\\\\192.168.0.2\\torrent"
      />
    </div>
  );
}
