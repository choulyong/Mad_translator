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
      // Server root: list shares using ls (fs.readdir doesn't work on //server)
      const server = uncParts[0];
      const lsPath = `//${server}/`;
      const output = execSync(`ls "${lsPath}"`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      const shares = output.split("\n").map((s) => s.trim()).filter(Boolean);
      dirs = shares.map((name) => ({
        name,
        path: `//${server}/${name}`,
      }));
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
}

export interface PreviewResult {
  rootVideoCount: number;
  subfolders: SubfolderInfo[];
}

/** 폴더를 미리보기: 상위 비디오 파일 수 + 하위 폴더 목록 (비디오 포함 폴더만) */
export async function previewDirectory(
  dirPath: string
): Promise<ActionResult<PreviewResult>> {
  try {
    await fs.access(dirPath);
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      return { success: false, error: "경로가 디렉토리가 아닙니다" };
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let rootVideoCount = 0;
    const subfolders: SubfolderInfo[] = [];

    for (const entry of entries) {
      if (entry.isFile() && isVideoFile(entry.name)) {
        rootVideoCount++;
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        try {
          const subEntries = await fs.readdir(path.join(dirPath, entry.name));
          const videoCount = subEntries.filter(isVideoFile).length;
          if (videoCount > 0) {
            subfolders.push({
              name: entry.name,
              path: path.join(dirPath, entry.name),
              videoCount,
            });
          }
        } catch {
          // ignore
        }
      }
    }

    subfolders.sort((a, b) => a.name.localeCompare(b.name));
    return { success: true, data: { rootVideoCount, subfolders } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "미리보기 실패";
    return { success: false, error: message };
  }
}

/** 선택된 하위폴더만 포함하여 스캔 (selectedFolders가 없으면 전체) */
export async function scanDirectory(
  dirPath: string,
  selectedFolders?: string[]
): Promise<ActionResult<FileItem[]>> {
  try {
    await fs.access(dirPath);

    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      return { success: false, error: "Path is not a directory" };
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files: FileItem[] = [];

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isFile() && isVideoFile(entry.name)) {
        // 직접 있는 비디오 파일
        const fileStat = await fs.stat(fullPath);
        files.push({
          id: uuid(),
          name: entry.name,
          path: fullPath,
          size: fileStat.size,
          status: "idle",
        });
      } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
        // selectedFolders가 있으면 선택된 폴더만 스캔
        if (selectedFolders && !selectedFolders.includes(entry.name)) continue;
        // 하위 폴더 1단계 스캔 → 비디오 파일 찾기
        try {
          const subEntries = await fs.readdir(fullPath);
          const videoFiles = subEntries.filter(isVideoFile);

          for (const videoName of videoFiles) {
            const videoPath = path.join(fullPath, videoName);
            const fileStat = await fs.stat(videoPath);
            if (!fileStat.isFile()) continue;

            files.push({
              id: uuid(),
              name: videoName,
              path: videoPath,
              size: fileStat.size,
              status: "idle",
              folderPath: fullPath,
              folderName: entry.name,
            });
          }
        } catch {
          // 하위 폴더 접근 실패 시 무시
        }
      }
    }

    return { success: true, data: files };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to scan directory";
    return { success: false, error: message };
  }
}
