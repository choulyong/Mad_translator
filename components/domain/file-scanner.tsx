"use client";

import { useState, useTransition } from "react";
import { FolderOpen, ScanSearch, Loader2, ChevronRight, Check, Folder, FileVideo, Pencil, X, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { useScanStore } from "@/lib/store/scan-store";
import { scanDirectory, identifyMovie, previewDirectory } from "@/app/actions";
import type { SubfolderInfo } from "@/app/actions";
import { buildMovieFilename, getExtension } from "@/lib/utils";
import { FolderPickerDialog } from "./folder-picker-dialog";

export function FileScanner() {
  const {
    path: storePath,
    files,
    setPath,
    setFiles,
    isScanning,
    setIsScanning,
    updateFileStatus,
    updateFileName,
    selectReady,
    selected,  // 파일 선택 추가
  } = useScanStore();
  const [inputValue, setInputValue] = useState(storePath);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [progress, setProgress] = useState("");

  // Preview state
  const [previewing, setPreviewing] = useState(false);
  const [rootVideoCount, setRootVideoCount] = useState(0);
  const [rootVideoFiles, setRootVideoFiles] = useState<string[]>([]);
  const [subfolders, setSubfolders] = useState<SubfolderInfo[]>([]);
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [selectedRootFiles, setSelectedRootFiles] = useState<Set<string>>(new Set());
  const [showPreview, setShowPreview] = useState(false);
  const [isPending, startTransition] = useTransition(); // 폴더 선택 응답성 개선

  // 편집 상태: 파일명 편집 (key = 원본 파일/폴더명, value = 편집된 이름)
  const [editedRootFiles, setEditedRootFiles] = useState<Map<string, string>>(new Map());
  const [editedFolders, setEditedFolders] = useState<Map<string, string>>(new Map());
  const [editingFile, setEditingFile] = useState<string | null>(null); // 현재 편집 중인 파일명
  const [editingValue, setEditingValue] = useState("");

  /** Step 1: 폴더 미리보기 */
  const handlePreview = async () => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      toast.error("경로를 입력하세요");
      return;
    }

    setPreviewing(true);
    const result = await previewDirectory(trimmed);
    setPreviewing(false);

    if (!result.success || !result.data) {
      toast.error(result.error ?? "미리보기 실패");
      return;
    }

    const { rootVideoCount: rootCount, rootVideoFiles: rootFiles, subfolders: subs } = result.data;
    setRootVideoCount(rootCount);
    setRootVideoFiles(rootFiles || []);
    setSubfolders(subs);
    setSelectedFolders(new Set(subs.map((s) => s.name)));
    setShowPreview(true);

    if (rootCount === 0 && subs.length === 0) {
      toast.info("비디오 파일이 없는 폴더입니다");
      setShowPreview(false);
    }
  };

  const toggleFolder = (name: string) => {
    startTransition(() => {
      setSelectedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    });
  };

  const toggleAll = () => {
    startTransition(() => {
      if (selectedFolders.size === subfolders.length) {
        setSelectedFolders(new Set());
      } else {
        setSelectedFolders(new Set(subfolders.map((s) => s.name)));
      }
    });
  };

  /** Step 2: 선택된 폴더로 스캔 + 자동 식별 */
  const handleScan = async () => {
    console.log("[스캐너] handleScan 시작! showPreview:", showPreview, "inputValue:", inputValue);
    try {
    const trimmed = inputValue.trim();
    setPath(trimmed);
    setIsScanning(true);
    setProgress("스캔 중...");
    setShowPreview(false);

    // selectedFolders가 있으면 해당 폴더만, 없으면 전체 스캔 (undefined 전달)
    // subfolders.length > 0 조건 제거: 루트 폴더에만 파일이 있어도 _root 선택 시 스캔됨
    const folders = selectedFolders.size > 0
      ? Array.from(selectedFolders)
      : undefined;

    // 파일이 선택되어 있으면 선택된 파일의 경로만 추출하여 백엔드에 전달
    // 이렇게 하면 선택된 파일만 스캔함 (전체 스캔 후 필터링 대신)
    let selectedFilePaths: string[] | undefined;

    // 1. 먼저 폴더 선택 미리보기에서 선택한 루트 파일 확인 (selectedRootFiles)
    if (selectedRootFiles.size > 0 && rootVideoFiles.length > 0) {
      selectedFilePaths = rootVideoFiles
        .filter((f) => selectedRootFiles.has(f))
        .map((f) => {
          // UNC 경로 처리
          if (trimmed.startsWith("//")) {
            return trimmed.replace(/\/+$/, "") + "/" + f;
          }
          return trimmed.replace(/\\+$/, "") + "\\" + f;
        });
      console.log("[스캐너] 선택된 루트 파일 경로 (selectedRootFiles):", selectedFilePaths.length, "개");
    }
    // 2. 폴더 선택 미리보기에 선택이 없으면 useScanStore의 selected 확인
    else if (selected.size > 0 && files.length > 0) {
      selectedFilePaths = files
        .filter((f) => selected.has(f.id))
        .map((f) => f.path);
      console.log("[스캐너] 선택된 파일 경로 (selected):", selectedFilePaths.length, "개");
    }

    console.log("[스캐너] scanDirectory 호출, folders:", folders, "selectedFilePaths:", selectedFilePaths?.length);
    const result = await scanDirectory(trimmed, folders, undefined, selectedFilePaths);

    console.log("[스캐너] scanDirectory 결과:", result.success, result.data?.length || result.error);

    if (!result.success || !result.data) {
      toast.error(result.error ?? "스캔 실패");
      setIsScanning(false);
      setProgress("");
      return;
    }

    let scannedFiles = result.data;

    console.log("[스캐너] scannedFiles:", scannedFiles.length, "첫 번째 folderName:", scannedFiles[0]?.folderName);
    setFiles(scannedFiles);
    toast.success(`${scannedFiles.length}개 파일 발견. 제목 조회 중...`);

    // 제목만 빠르게 조회 (포스터/기타 정보 제외)
    let successCount = 0;
    for (let i = 0; i < scannedFiles.length; i++) {
      const file = scannedFiles[i];
      setProgress(`제목 조회 중... (${i + 1}/${scannedFiles.length})`);
      updateFileStatus(file.id, "identifying");

      const idResult = await identifyMovie(file.name);

      if (idResult.success && idResult.data) {
        // 제목만 사용, 포스터/기타 정보는 나중에 필요시 조회
        const ext = getExtension(file.name);
        const newName = buildMovieFilename(idResult.data.title, idResult.data.year, ext);
        updateFileStatus(file.id, "ready", { metadata: { ...idResult.data, posterPath: null } });
        updateFileName(file.id, newName);
        successCount++;
      } else {
        updateFileStatus(file.id, "idle", { error: undefined });
      }
    }

    selectReady();
    setIsScanning(false);
    setProgress("");
    toast.success(`${successCount}/${scannedFiles.length}개 제목 조회 완료`);
    toast.success(`${successCount}/${scannedFiles.length}개 식별 완료`);
    } catch (err) {
      console.error("[스캐너] handleScan 오류:", err);
      toast.error("스캔 중 오류 발생");
      setIsScanning(false);
      setProgress("");
    }
  };

  const totalSelected = rootVideoCount + subfolders
    .filter((s) => selectedFolders.has(s.name))
    .reduce((sum, s) => sum + s.videoCount, 0);

  return (
    <>
      <div className="bg-surface-dark border border-border-dark rounded-xl p-6">
        <label className="block text-sm font-medium text-zinc-400 mb-2">
          디렉토리 경로
        </label>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <FolderOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
            <input
              type="text"
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                if (showPreview) setShowPreview(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handlePreview();
              }}
              placeholder="스캔할 폴더 경로를 입력하세요..."
              className="w-full bg-surface-darker border border-border-dark rounded-lg pl-10 pr-4 py-2.5 text-sm font-[family-name:var(--font-mono)] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-all"
            />
          </div>
          <button
            onClick={() => setPickerOpen(true)}
            disabled={isScanning}
            className="flex items-center gap-2 px-4 py-2.5 bg-zinc-800 border border-border-dark rounded-lg text-sm font-medium text-zinc-300 hover:bg-zinc-700 hover:text-white transition-colors disabled:opacity-50"
            title="폴더 찾아보기"
          >
            <FolderOpen className="w-4 h-4 text-primary" />
            찾아보기
          </button>
          <button
            onClick={async () => {
              console.log("[스캐너] 버튼 클릭, showPreview:", showPreview);
              // 먼저 미리보기(폴더 선택)를 표시하고, 그 다음 스캔 시작
              if (!inputValue.trim()) {
                toast.error("경로를 입력하세요");
                return;
              }
              if (!showPreview) {
                // 미리보기가 안 보이면 먼저 폴더 선택 화면 표시
                handlePreview();
                return;
              }
              // 미리보기가 보이고 있으면 스캔 시작
              console.log("[스캐너] 스캔 시작, 경로:", inputValue);
              if (!inputValue.trim()) {
                return;
              }
              // 바로 스캔 시작 (미리보기 건너뛰기)
              const trimmed = inputValue.trim();
              setPath(trimmed);
              setIsScanning(true);
              setProgress("스캔 중...");
              setShowPreview(false);

              // 폴더가 선택되었으면 해당 폴더만, 아니면 전체 스캔
              // subfolders.length > 0 조건 제거: 루트 폴더에만 파일이 있어도 _root 선택 시 스캔됨
              let folders: string[] | undefined;
              if (selectedFolders.size > 0) {
                folders = Array.from(selectedFolders);
                if (folders.length === 0) folders = undefined;
              }

              // 편집된 폴더명을 Map으로 변환
              const folderNameMap: Record<string, string> = {};
              editedFolders.forEach((editedName, originalName) => {
                folderNameMap[originalName] = editedName;
              });

              // 파일이 선택되어 있으면 선택된 파일의 경로만 추출하여 백엔드에 전달
              let selectedFilePaths2: string[] | undefined;

              // 1. 먼저 폴더 선택 미리보기에서 선택한 루트 파일 확인 (selectedRootFiles)
              if (selectedRootFiles.size > 0 && rootVideoFiles.length > 0) {
                selectedFilePaths2 = rootVideoFiles
                  .filter((f) => selectedRootFiles.has(f))
                  .map((f) => {
                    // UNC 경로 처리
                    if (trimmed.startsWith("//")) {
                      return trimmed.replace(/\/+$/, "") + "/" + f;
                    }
                    return trimmed.replace(/\\+$/, "") + "\\" + f;
                  });
                console.log("[스캐너] 선택된 루트 파일 경로 (selectedRootFiles):", selectedFilePaths2.length, "개");
              }
              // 2. 폴더 선택 미리보기에 선택이 없으면 useScanStore의 selected 확인
              else if (selected.size > 0 && files.length > 0) {
                selectedFilePaths2 = files
                  .filter((f) => selected.has(f.id))
                  .map((f) => f.path);
                console.log("[스캐너] 선택된 파일 경로 (selected):", selectedFilePaths2.length, "개");
              }

              console.log("[스캐너] scanDirectory 호출, folders:", folders, "folderNameMap:", folderNameMap, "selectedFilePaths:", selectedFilePaths2?.length);
              const result = await scanDirectory(trimmed, folders, Object.keys(folderNameMap).length > 0 ? folderNameMap : undefined, selectedFilePaths2);

              console.log("[스캐너] scanDirectory 결과:", result.success, result.data?.length || result.error);

              if (!result.success || !result.data) {
                toast.error(result.error ?? "스캔 실패");
                setIsScanning(false);
                setProgress("");
                return;
              }

              let scannedFiles = result.data;

              // 파일이 선택되어 있으면 선택된 파일만 필터링
              if (selected.size > 0) {
                console.log("[스캐너] 선택된 파일 필터링:", selected.size, "개");
                scannedFiles = scannedFiles.filter((f) => selected.has(f.id));
                console.log("[스캐너] 필터링 후 파일 수:", scannedFiles.length);
              }

              console.log("[스캐너] scannedFiles:", scannedFiles.length, "첫 번째:", scannedFiles[0]?.name);
              setFiles(scannedFiles);
              toast.success(`${scannedFiles.length}개 파일 발견. 제목 조회 중...`);

              // 배치로 병렬 처리 (부하 방지)
              const BATCH_SIZE = 100;
              let successCount = 0;

              for (let i = 0; i < scannedFiles.length; i += BATCH_SIZE) {
                const batch = scannedFiles.slice(i, i + BATCH_SIZE);
                setProgress(`제목 조회 중... (${Math.min(i + BATCH_SIZE, scannedFiles.length)}/${scannedFiles.length})`);

                const results = await Promise.allSettled(
                  batch.map(async (file) => {
                    updateFileStatus(file.id, "identifying");
                    const lookupName = editedRootFiles.has(file.name) ? editedRootFiles.get(file.name)! : file.name;
                    const idResult = await identifyMovie(lookupName);
                    return { file, idResult };
                  })
                );

                for (const r of results) {
                  if (r.status === "fulfilled" && r.value.idResult.success && r.value.idResult.data) {
                    const { file, idResult } = r.value;
                    const data = idResult.data!;
                    const ext = getExtension(file.name);
                    const newName = buildMovieFilename(data.title, data.year, ext);
                    updateFileStatus(file.id, "ready", {
                      metadata: {
                        tmdbId: data.tmdbId || 0,
                        title: data.title,
                        originalTitle: data.originalTitle || data.title,
                        year: data.year,
                        releaseDate: data.releaseDate || "",
                        posterPath: null,
                        overview: data.overview || "",
                      }
                    });
                    updateFileName(file.id, newName);
                    successCount++;
                  } else if (r.status === "fulfilled") {
                    updateFileStatus(r.value.file.id, "idle", { error: undefined });
                  }
                }
              }

              selectReady();
              setIsScanning(false);
              setProgress("");
              toast.success(`${successCount}/${scannedFiles.length}개 제목 조회 완료`);
            }}
            disabled={isScanning || !inputValue.trim()}
            className="flex items-center gap-2 px-5 py-2.5 bg-zinc-800 border border-border-dark rounded-lg text-sm font-medium text-white hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isScanning ? (
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
            ) : (
              <ScanSearch className="w-4 h-4 text-primary" />
            )}
            {progress || "스캔"}
          </button>
        </div>

        {/* Subfolder Preview */}
        {showPreview && (subfolders.length > 0 || rootVideoCount > 0) && (
          <div className="mt-4 border border-border-dark rounded-lg overflow-hidden">
            {/* Root videos - 전체 파일을 개별 선택 항목으로 표시 */}
            {rootVideoCount > 0 && (
              <div className="border-b border-border-dark">
                <div className="flex items-center justify-between px-4 py-2 bg-primary/[0.03] border-b border-border-dark/50">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        if (selectedFolders.has("_root")) {
                          selectedFolders.delete("_root");
                          setSelectedFolders(new Set(selectedFolders));
                        } else {
                          setSelectedFolders(new Set([...selectedFolders, "_root"]));
                        }
                      }}
                      className={`w-4.5 h-4.5 rounded border flex items-center justify-center transition-colors ${
                        selectedFolders.has("_root")
                          ? "bg-primary border-primary text-white"
                          : "border-zinc-600 hover:border-zinc-400"
                      }`}
                    >
                      {selectedFolders.has("_root") && <Check className="w-3 h-3" />}
                    </button>
                    <FolderOpen className="w-4 h-4 text-primary" />
                    <span className="text-sm text-zinc-200 font-medium">상위 폴더 (루트)</span>
                  </div>
                  <span className="text-xs text-zinc-500">{rootVideoCount}개 파일</span>
                </div>
                {/* 전체 루트 파일을 개별 선택 행으로 표시 */}
                <div className="max-h-64 overflow-y-auto divide-y divide-border-dark/50">
                  {rootVideoFiles.map((file, idx) => {
                    const isSelected = selectedRootFiles.has(file);
                    const editedName = editedRootFiles.get(file);
                    const displayName = editedName || file;
                    const isEditing = editingFile === file;

                    return (
                      <div key={idx} className={`flex items-center gap-2 px-4 py-1.5 hover:bg-surface-darker/30 ${isSelected ? 'bg-primary/10' : ''}`}>
                        <button
                          onClick={() => {
                            const newSet = new Set(selectedRootFiles);
                            if (newSet.has(file)) newSet.delete(file);
                            else newSet.add(file);
                            setSelectedRootFiles(newSet);
                          }}
                          className={`w-4 h-4 rounded border flex items-center justify-center transition-colors shrink-0 ${
                            isSelected
                              ? "bg-primary border-primary text-white"
                              : "border-zinc-600 hover:border-zinc-400"
                          }`}
                        >
                          {isSelected && <Check className="w-2.5 h-2.5" />}
                        </button>
                        <FileVideo className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        {isEditing ? (
                          <div className="flex items-center gap-1 flex-1 min-w-0">
                            <input
                              type="text"
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  if (editingValue.trim()) {
                                    setEditedRootFiles(new Map(editedRootFiles).set(file, editingValue.trim()));
                                  }
                                  setEditingFile(null);
                                } else if (e.key === 'Escape') {
                                  setEditingFile(null);
                                }
                              }}
                              autoFocus
                              className="flex-1 min-w-0 bg-zinc-800 border border-primary rounded px-1.5 py-0.5 text-xs text-zinc-200 font-[family-name:var(--font-mono)] focus:outline-none"
                            />
                            <button
                              onClick={() => {
                                if (editingValue.trim()) {
                                  setEditedRootFiles(new Map(editedRootFiles).set(file, editingValue.trim()));
                                }
                                setEditingFile(null);
                              }}
                              className="text-green-500 hover:text-green-400 shrink-0"
                            >
                              <CheckCircle className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => setEditingFile(null)}
                              className="text-zinc-500 hover:text-zinc-400 shrink-0"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <span className="text-xs text-zinc-300 truncate flex-1 font-[family-name:var(--font-mono)]">{displayName}</span>
                            <button
                              onClick={() => {
                                setEditingFile(file);
                                setEditingValue(editedName || file);
                              }}
                              className="text-zinc-600 hover:text-primary shrink-0"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Subfolders header */}
            {subfolders.length > 0 && (
              <div className="flex items-center justify-between px-4 py-2 bg-surface-darker border-b border-border-dark">
                <div className="flex items-center gap-2">
                  <button
                    onClick={toggleAll}
                    className={`w-4.5 h-4.5 rounded border flex items-center justify-center transition-colors ${
                      selectedFolders.size === subfolders.length
                        ? "bg-primary border-primary text-white"
                        : selectedFolders.size > 0
                          ? "bg-primary/50 border-primary text-white"
                          : "border-zinc-600 hover:border-zinc-400"
                    }`}
                  >
                    {selectedFolders.size > 0 && <Check className="w-3 h-3" />}
                  </button>
                  <span className="text-xs text-zinc-400 font-medium">
                    하위 폴더 ({selectedFolders.size}/{subfolders.length})
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelectedFolders(new Set(subfolders.map((s) => s.name)))}
                    className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    전체 선택
                  </button>
                  <button
                    onClick={() => setSelectedFolders(new Set())}
                    className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    전체 해제
                  </button>
                </div>
              </div>
            )}

            {/* Subfolder list */}
            <div className="max-h-60 overflow-y-auto divide-y divide-border-dark">
              {subfolders.map((sub) => {
                const isSelected = selectedFolders.has(sub.name);
                const editedName = editedFolders.get(sub.name);
                const displayName = editedName || sub.name;
                const isEditing = editingFile === `folder_${sub.name}`;

                return (
                  <div
                    key={sub.name}
                    className={`flex items-center gap-3 px-4 py-2.5 hover:bg-surface-darker/50 transition-colors ${
                      isSelected ? "bg-primary/[0.03]" : ""
                    }`}
                  >
                    <button
                      onClick={() => toggleFolder(sub.name)}
                      className={`w-4.5 h-4.5 rounded border flex items-center justify-center transition-colors shrink-0 ${
                        isSelected
                          ? "bg-primary border-primary text-white"
                          : "border-zinc-600"
                      }`}
                    >
                      {isSelected && <Check className="w-3 h-3" />}
                    </button>
                    <Folder className="w-4 h-4 text-zinc-500 shrink-0" />
                    {isEditing ? (
                      <div className="flex items-center gap-1 flex-1 min-w-0">
                        <input
                          type="text"
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              if (editingValue.trim()) {
                                setEditedFolders(new Map(editedFolders).set(sub.name, editingValue.trim()));
                              }
                              setEditingFile(null);
                            } else if (e.key === 'Escape') {
                              setEditingFile(null);
                            }
                          }}
                          autoFocus
                          className="flex-1 min-w-0 bg-zinc-800 border border-primary rounded px-1.5 py-0.5 text-sm text-zinc-200 font-[family-name:var(--font-mono)] focus:outline-none"
                        />
                        <button
                          onClick={() => {
                            if (editingValue.trim()) {
                              setEditedFolders(new Map(editedFolders).set(sub.name, editingValue.trim()));
                            }
                            setEditingFile(null);
                          }}
                          className="text-green-500 hover:text-green-400 shrink-0"
                        >
                          <CheckCircle className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => setEditingFile(null)}
                          className="text-zinc-500 hover:text-zinc-400 shrink-0"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="text-sm text-zinc-300 truncate flex-1 font-[family-name:var(--font-mono)]">
                          {displayName}
                        </span>
                        <button
                          onClick={() => {
                            setEditingFile(`folder_${sub.name}`);
                            setEditingValue(editedName || sub.name);
                          }}
                          className="text-zinc-600 hover:text-primary shrink-0"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-xs text-zinc-600 shrink-0">
                          {sub.videoCount}개
                        </span>
                      </>
                    )}
                  </div>
                );
              })}
              {/* 폴더別 파일 목록 표시 */}
              {subfolders.some(s => s.files && s.files.length > 0) && (
                <div className="px-4 py-2 bg-zinc-900/30 border-t border-border-dark">
                  <div className="flex flex-wrap gap-1">
                    {subfolders.filter(s => s.files && s.files.length > 0).slice(0, 3).map((sub) => (
                      sub.files?.slice(0, 5).map((file, idx) => (
                        <span key={`${sub.name}-${idx}`} className="text-[10px] text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
                          {sub.name}: {file}
                        </span>
                      ))
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <FolderPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(selectedPath) => {
          setInputValue(selectedPath);
          setPath(selectedPath);
          setShowPreview(false);
        }}
        initialPath={inputValue || "//192.168.0.2/torrent"}
      />
    </>
  );
}
