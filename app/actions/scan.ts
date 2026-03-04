"use server";

import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";
import { v4 as uuid } from "uuid";
import type { ActionResult, FileItem } from "@/lib/types";
import { isVideoFile } from "@/lib/utils";

/** 새 폴더 생성 (중복 시 _1, _2 접미사) */
export async function createFolder(
  parentPath: string,
  folderName: string
): Promise<ActionResult<string>> {
  try {
    let targetPath = path.join(parentPath, folderName);
    let finalName = folderName;
    let counter = 1;

    // 중복 폴더명 처리
    while (true) {
      try {
        await fs.access(targetPath);
        // 존재하면 접미사 추가
        finalName = `${folderName}_${counter}`;
        targetPath = path.join(parentPath, finalName);
        counter++;
      } catch {
        // 존재하지 않으면 사용 가능
        break;
      }
    }

    await fs.mkdir(targetPath, { recursive: true });
    return { success: true, data: targetPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : "폴더 생성 실패";
    return { success: false, error: message };
  }
}

/** 파일들을 대상 폴더로 이동 (중복 파일명 처리) */
export async function moveFiles(
  files: { path: string; name: string }[],
  destinationPath: string
): Promise<ActionResult<number>> {
  try {
    await fs.access(destinationPath);
    let successCount = 0;

    for (const file of files) {
      try {
        let destFile = path.join(destinationPath, file.name);
        let counter = 1;

        // 중복 파일명 처리
        while (true) {
          try {
            await fs.access(destFile);
            const ext = path.extname(file.name);
            const base = path.basename(file.name, ext);
            destFile = path.join(destinationPath, `${base}_${counter}${ext}`);
            counter++;
          } catch {
            break;
          }
        }

        await fs.rename(file.path, destFile);
        successCount++;
      } catch {
        // 개별 파일 이동 실패 시 계속 진행
      }
    }

    return { success: true, data: successCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : "파일 이동 실패";
    return { success: false, error: message };
  }
}

/** 선택되지 않은 파일들을 nochoice 폴더로 이동 */
export async function moveToNoChoice(
  filePaths: string[]
): Promise<ActionResult<{ movedCount: number; failedCount: number }>> {
  try {
    if (filePaths.length === 0) {
      return { success: true, data: { movedCount: 0, failedCount: 0 } };
    }

    // 부모 폴더 경로 찾기
    const firstPath = filePaths[0];
    const parentDir = path.dirname(firstPath);
    const noChoiceDir = path.join(parentDir, "nochoice");

    console.log(`[nochoice 이동] 부모 폴더: ${parentDir}, 대상: ${noChoiceDir}, 이동 대상: ${filePaths.length}개`);

    // nochoice 폴더 생성
    await fs.mkdir(noChoiceDir, { recursive: true });

    let movedCount = 0;
    let failedCount = 0;

    for (const filePath of filePaths) {
      try {
        const fileName = path.basename(filePath);
        const newPath = path.join(noChoiceDir, fileName);
        await fs.rename(filePath, newPath);
        movedCount++;
      } catch (moveErr) {
        console.error(`[nochoice 이동 실패] ${filePath}:`, moveErr);
        failedCount++;
      }
    }

    console.log(`[nochoice 이동 완료] 성공: ${movedCount}개, 실패: ${failedCount}개`);

    return { success: true, data: { movedCount, failedCount } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "nochoice 이동 실패";
    return { success: false, error: message };
  }
}

export interface DirEntry {
  name: string;
  path: string;
}

export async function browseDirectory(
  dirPath?: string
): Promise<ActionResult<{ current: string; parent: string | null; dirs: DirEntry[] }>> {
  try {
    // No path → return drive roots (Windows) or filesystem root (Unix)
    if (!dirPath) {
      if (process.platform === "win32") {
        const drives: DirEntry[] = [];
        for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
          const drivePath = `${letter}:\\`;
          try {
            await fs.access(drivePath);
            drives.push({ name: `${letter}:`, path: drivePath });
          } catch {
            // drive doesn't exist
          }
        }
        return { success: true, data: { current: "", parent: null, dirs: drives } };
      }
      dirPath = "/";
    }

    // Detect failed UNC path: C:\192.168.0.2\torrent (single backslash + IP pattern)
    if (/^[A-Z]:\\[\d.]+[\\\/]/.test(dirPath)) {
      // Convert C:\192.168.0.2\torrent → //192.168.0.2/torrent
      dirPath = dirPath.replace(/^[A-Z]:\\/, "").replace(/\\/g, "/");
    }

    // Normalize UNC/SMB path — keep forward slashes for Node.js compatibility
    const isUnc = dirPath.startsWith("\\\\") || dirPath.startsWith("//");
    if (isUnc) {
      // Normalize to forward-slash UNC (Node.js handles // better than \\ on Windows)
      dirPath = dirPath.replace(/\\/g, "/");
      if (!dirPath.startsWith("//")) dirPath = "//" + dirPath.replace(/^\/+/, "");
    }

    // Check if this is a UNC server root (//server without share name)
    const uncParts = isUnc
      ? dirPath.replace(/\/+$/, "").split("/").filter(Boolean)
      : [];
    const isUncServerRoot = isUnc && uncParts.length === 1;

    let dirs: DirEntry[] = [];

    if (isUncServerRoot) {
      // Server root: use PowerShell to list shares (works on Windows)
      const server = uncParts[0];
      try {
        const output = execSync(`powershell -Command "Get-SmbShare -ServerName '${server}' | Select-Object -ExpandProperty Name"`, {
          encoding: "utf-8",
          timeout: 10000,
        });
        const shares = output.split("\n").map((s) => s.trim()).filter(Boolean);
        dirs = shares.map((name) => ({
          name,
          path: `//${server}/${name}`,
        }));
      } catch {
        // PowerShell failed - return empty with hint
        return { success: false, error: `서버 ${server}의 공유 폴더를 읽을 수 없습니다. 직접 공유 폴더 경로를 입력해 주세요 (예: //${server}/movie)` };
      }
    } else {
      // Normal directory or UNC share subfolder
      await fs.access(dirPath);
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) {
        return { success: false, error: "경로가 디렉토리가 아닙니다" };
      }

      const entries = await fs.readdir(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".") || entry.name === "$RECYCLE.BIN" || entry.name === "System Volume Information") continue;
        const childPath = isUnc
          ? dirPath.replace(/\/+$/, "") + "/" + entry.name
          : path.join(dirPath, entry.name);
        dirs.push({
          name: entry.name,
          path: childPath,
        });
      }
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));

    // Calculate parent path
    let parent: string | null = null;
    if (isUnc) {
      if (uncParts.length > 2) {
        parent = "//" + uncParts.slice(0, uncParts.length - 1).join("/");
      } else if (uncParts.length === 2) {
        // At share root (//server/share) → go back to server root (//server)
        parent = "//" + uncParts[0];
      }
      // uncParts.length === 1 (server root) → no parent
    } else {
      const parsed = path.parse(dirPath);
      parent = parsed.dir && parsed.dir !== dirPath ? parsed.dir : null;
    }

    return { success: true, data: { current: dirPath, parent, dirs } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "디렉토리를 읽을 수 없습니다";
    return { success: false, error: message };
  }
}

export interface SubfolderInfo {
  name: string;
  path: string;
  videoCount: number;
  files?: string[]; // 폴더內 파일 목록 (미리보기용)
}

export interface PreviewResult {
  rootVideoCount: number;
  rootVideoFiles?: string[]; // 루트 폴더 파일 목록
  subfolders: SubfolderInfo[];
}

/** 폴더를 미리보기: 재귀적으로 모든 비디오 파일 수 계산 + 파일 목록 */
export async function previewDirectory(
  dirPath: string
): Promise<ActionResult<PreviewResult>> {
  try {
    await fs.access(dirPath);
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      return { success: false, error: "경로가 디렉토리가 아닙니다" };
    }

    let rootVideoCount = 0;
    const rootVideoFiles: string[] = []; // 루트 폴더 파일 목록
    const subfolders: SubfolderInfo[] = [];

    // 재귀적으로 비디오 개수 세기 + 파일 목록 수집
    const scanVideosRecursive = async (currentPath: string, depth: number = 0, collectFiles: string[] = []): Promise<number> => {
      if (depth > 15) return 0; // 최대 깊이 제한

      let count = 0;
      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isFile() && isVideoFile(entry.name)) {
            count++;
            if (collectFiles) collectFiles.push(entry.name);
          } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
            count += await scanVideosRecursive(path.join(currentPath, entry.name), depth + 1, collectFiles);
          }
        }
      } catch {
        // 접근 실패 시 무시
      }
      return count;
    };

    // 첫 번째 레벨만 폴더별로分组
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isFile() && isVideoFile(entry.name)) {
        rootVideoCount++;
        rootVideoFiles.push(entry.name); // 루트 파일 목록에 추가
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const subPath = path.join(dirPath, entry.name);
        const subVideoFiles: string[] = [];
        const videoCount = await scanVideosRecursive(subPath, 1, subVideoFiles);
        if (videoCount > 0) {
          subfolders.push({
            name: entry.name,
            path: subPath,
            videoCount,
            files: subVideoFiles.slice(0, 10), // 각 폴더에서 최대 10개 파일만
          });
        }
      }
    }

    subfolders.sort((a, b) => a.name.localeCompare(b.name));
    // 루트 파일도 최대 10개만
    return { success: true, data: { rootVideoCount, rootVideoFiles, subfolders } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "미리보기 실패";
    return { success: false, error: message };
  }
}

/** 재귀적으로 폴더 스캔 - 모든 깊이의 비디오 파일 찾기 */
export async function scanDirectory(
  dirPath: string,
  selectedFolders?: string[],
  folderNameMap?: Record<string, string>,  // 원본 폴더명 -> 편집된 폴더명 매핑
  selectedFilePaths?: string[]  // 선택된 파일 경로만 스캔 (파일 단위 선택 시)
): Promise<ActionResult<FileItem[]>> {
  try {
    console.log(`[scanDirectory] 원본 경로: ${dirPath}, selectedFolders: ${JSON.stringify(selectedFolders)}, selectedFilePaths: ${selectedFilePaths?.length}개`);

    // UNC 경로 처리 (browseDirectory와 동일)
    // Detect failed UNC path: C:\192.168.0.2\torrent (single backslash + IP pattern)
    if (/^[A-Z]:\\[\d.]+[\\\/]/.test(dirPath)) {
      // Convert C:\192.168.0.2\torrent → //192.168.0.2/torrent
      dirPath = dirPath.replace(/^[A-Z]:\\/, "").replace(/\\/g, "/");
    }

    // Normalize UNC/SMB path — keep forward slashes for Node.js compatibility
    const isUnc = dirPath.startsWith("\\\\") || dirPath.startsWith("//");
    if (isUnc) {
      dirPath = dirPath.replace(/\\/g, "/");
      if (!dirPath.startsWith("//")) dirPath = "//" + dirPath.replace(/^\/+/, "");
    }

    console.log(`[scanDirectory] 변환 후 경로: ${dirPath}, selectedFolders: ${JSON.stringify(selectedFolders)}`);

    await fs.access(dirPath);

    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      return { success: false, error: "Path is not a directory" };
    }

    // 선택된 파일 경로가 있으면 해당 파일만 스캔 (파일 단위 선택 시)
    if (selectedFilePaths && selectedFilePaths.length > 0) {
      console.log(`[scanDirectory] 선택된 파일만 스캔: ${selectedFilePaths.length}개`);
      const selectedSet = new Set(selectedFilePaths);
      const files: FileItem[] = [];

      for (const filePath of selectedFilePaths) {
        try {
          // 파일이 실제로 존재하는지 확인
          await fs.access(filePath);
          const fileStat = await fs.stat(filePath);
          if (!fileStat.isDirectory()) {
            const fileName = path.basename(filePath);
            const parentDir = path.dirname(filePath);

            // 폴더명 추출 (dirPath 기준으로)
            let folderName: string | undefined;
            if (parentDir !== dirPath) {
              // 서브폴더
              folderName = path.basename(parentDir);
              // folderNameMap이 있으면 변환
              if (folderNameMap && folderNameMap[folderName]) {
                folderName = folderNameMap[folderName];
              }
            }

            files.push({
              id: uuid(),
              name: fileName,
              path: filePath,
              size: fileStat.size,
              status: "idle",
              folderPath: parentDir,
              folderName,
            });
          }
        } catch (err) {
          console.log(`[scanDirectory] 파일 접근 실패: ${filePath}`, err);
        }
      }

      console.log(`[scanDirectory] 선택된 파일 스캔 완료: ${files.length}개`);
      return { success: true, data: files };
    }

    const files: FileItem[] = [];
    const maxDepth = 15;

    // isUnc는 위에서 이미 정의됨 (line ~285)

    // UNC 경로용 join 함수
    const joinPath = (base: string, child: string): string => {
      if (isUnc) {
        // UNC 경로: 이미 슬래시로 변환됨
        return base.replace(/\/+$/, "") + "/" + child;
      }
      return path.join(base, child);
    };

    // 재귀적으로 비디오 파일 수집
    const scanRecursive = async (
      currentPath: string,
      currentDepth: number,
      parentFolderName?: string
    ): Promise<void> => {
      if (currentDepth > maxDepth) return;

      // _root만 선택했으면 서브폴더 스캔 안 함 (depth 0에서만 스캔)
      const onlyRootSelected = selectedFolders && selectedFolders.length === 1 && selectedFolders.includes("_root");
      if (onlyRootSelected && currentDepth > 0) {
        console.log(`[scanRecursive] _root만 선택 → depth ${currentDepth} 스킵`);
        return;
      }

      try {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });
        console.log(`[scanRecursive] ${currentPath}: ${entries.length} entries, depth: ${currentDepth}`);

        for (const entry of entries) {
          const entryPath = joinPath(currentPath, entry.name);

          if (entry.isFile() && isVideoFile(entry.name)) {
            // 루트 폴더 선택 시 (_root) 또는 전체 스캔 시에만 루트 파일 추가
            // _root가 있으면 루트 폴더만, 없으면 전체 (하위 폴더 포함)
            const includeRoot = !selectedFolders || selectedFolders.includes("_root");
            const includeSubfolders = !selectedFolders || selectedFolders.some(f => f !== "_root");

            if (currentDepth === 0) {
              // 루트 레벨 파일
              if (includeRoot) {
                const fileStat = await fs.stat(entryPath);
                files.push({
                  id: uuid(),
                  name: entry.name,
                  path: entryPath,
                  size: fileStat.size,
                  status: "idle",
                  folderPath: currentPath,
                  folderName: parentFolderName,
                });
              }
            } else {
              // 서브폴더 파일
              if (includeSubfolders) {
                const fileStat = await fs.stat(entryPath);
                files.push({
                  id: uuid(),
                  name: entry.name,
                  path: entryPath,
                  size: fileStat.size,
                  status: "idle",
                  folderPath: currentPath,
                  folderName: parentFolderName,
                });
              }
            }
          } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
            // _root만 선택했으면 서브폴더 스캔 건너뛰기
            const onlyRootSelected = selectedFolders && selectedFolders.length === 1 && selectedFolders.includes("_root");
            if (onlyRootSelected) {
              console.log(`[scanRecursive] _root만 선택 → 서브폴더 스킵: ${entry.name}`);
              continue;
            }

            // selectedFolders가 있으면 선택된 폴더만 스캔 (첫 레벨 폴더만 체크)
            // selectedFolders가 비어있으면 전체 스캔
            if (currentDepth === 0 && selectedFolders && selectedFolders.length > 0 && !selectedFolders.includes(entry.name)) {
              console.log(`[scanRecursive] 스킵 (선택 안 됨): ${entry.name}`);
              continue;
            }
            // 하위 폴더 재귀 스캔 - 편집된 폴더명이 있으면 사용
            const mappedFolderName = folderNameMap && folderNameMap[entry.name]
              ? folderNameMap[entry.name]
              : entry.name;
            await scanRecursive(
              entryPath,
              currentDepth + 1,
              parentFolderName || mappedFolderName
            );
          }
        }
      } catch (err) {
        console.log(`[scanRecursive] 접근 실패: ${currentPath}, error: ${err}`);
        // 접근 실패 시 무시
      }
    };

    await scanRecursive(dirPath, 0);

    console.log(`[scanDirectory] 완료: ${files.length}개 파일 발견`);
    console.log(`[scanDirectory] 첫 번째 파일 sample:`, files[0] ? {
      name: files[0].name,
      folderName: files[0].folderName,
      path: files[0].path
    } : '없음');
    return { success: true, data: files };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to scan directory";
    return { success: false, error: message };
  }
}
