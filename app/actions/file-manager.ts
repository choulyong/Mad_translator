"use server";

import fs from "fs/promises";
import path from "path";
import type { ActionResult } from "@/lib/types";

export interface FMEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

/** 디렉토리 내 파일+폴더 목록 반환 */
export async function listDirectory(
  dirPath: string
): Promise<ActionResult<{ current: string; parent: string | null; entries: FMEntry[] }>> {
  try {
    await fs.access(dirPath);
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      return { success: false, error: "경로가 디렉토리가 아닙니다" };
    }

    const rawEntries = await fs.readdir(dirPath, { withFileTypes: true });
    const entries: FMEntry[] = [];

    for (const entry of rawEntries) {
      if (entry.name.startsWith(".") || entry.name === "$RECYCLE.BIN" || entry.name === "System Volume Information") {
        continue;
      }
      try {
        const fullPath = path.join(dirPath, entry.name);
        const entryStat = await fs.stat(fullPath);
        entries.push({
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          size: entryStat.size,
          modifiedAt: entryStat.mtime.toISOString(),
        });
      } catch {
        // 접근 불가 파일 무시
      }
    }

    // 폴더 먼저, 그다음 파일, 이름순
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // 부모 경로 계산
    const isUnc = dirPath.startsWith("\\\\") || dirPath.startsWith("//");
    let parent: string | null = null;
    if (isUnc) {
      const parts = dirPath.replace(/\\+$/, "").split("\\").filter(Boolean);
      if (parts.length > 2) {
        parent = "\\\\" + parts.slice(0, parts.length - 1).join("\\");
      }
    } else {
      const parsed = path.parse(dirPath);
      parent = parsed.dir && parsed.dir !== dirPath ? parsed.dir : null;
    }

    return { success: true, data: { current: dirPath, parent, entries } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "디렉토리를 읽을 수 없습니다";
    return { success: false, error: message };
  }
}

/** 파일/폴더 복사 */
export async function copyItems(
  sources: string[],
  destinationDir: string
): Promise<ActionResult<number>> {
  try {
    await fs.access(destinationDir);
    let count = 0;

    for (const src of sources) {
      try {
        const name = path.basename(src);
        let dest = path.join(destinationDir, name);
        let counter = 1;

        // 중복 처리
        while (true) {
          try {
            await fs.access(dest);
            const ext = path.extname(name);
            const base = path.basename(name, ext);
            dest = path.join(destinationDir, `${base}_${counter}${ext}`);
            counter++;
          } catch {
            break;
          }
        }

        const stat = await fs.stat(src);
        if (stat.isDirectory()) {
          await copyDir(src, dest);
        } else {
          await fs.copyFile(src, dest);
        }
        count++;
      } catch {
        // 개별 실패 시 계속
      }
    }

    return { success: true, data: count };
  } catch (err) {
    const message = err instanceof Error ? err.message : "복사 실패";
    return { success: false, error: message };
  }
}

async function copyDir(src: string, dest: string) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/** 파일/폴더 삭제 */
export async function deleteItems(
  paths: string[]
): Promise<ActionResult<number>> {
  try {
    let count = 0;
    for (const p of paths) {
      try {
        const stat = await fs.stat(p);
        if (stat.isDirectory()) {
          await fs.rm(p, { recursive: true, force: true });
        } else {
          await fs.unlink(p);
        }
        count++;
      } catch {
        // 개별 실패 시 계속
      }
    }
    return { success: true, data: count };
  } catch (err) {
    const message = err instanceof Error ? err.message : "삭제 실패";
    return { success: false, error: message };
  }
}

/** 파일/폴더 이름 변경 */
export async function renameItem(
  oldPath: string,
  newName: string
): Promise<ActionResult<string>> {
  try {
    const dir = path.dirname(oldPath);
    const newPath = path.join(dir, newName);

    // 같은 이름이면 무시
    if (oldPath === newPath) {
      return { success: true, data: newPath };
    }

    // 대상이 이미 존재하는지 확인
    try {
      await fs.access(newPath);
      return { success: false, error: "같은 이름의 파일/폴더가 이미 존재합니다" };
    } catch {
      // 존재하지 않으면 OK
    }

    await fs.rename(oldPath, newPath);
    return { success: true, data: newPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : "이름 변경 실패";
    return { success: false, error: message };
  }
}

/** 파일/폴더 이동 (rename 기반) */
export async function moveItems(
  sources: string[],
  destinationDir: string
): Promise<ActionResult<number>> {
  try {
    await fs.access(destinationDir);
    let count = 0;

    for (const src of sources) {
      try {
        const name = path.basename(src);
        let dest = path.join(destinationDir, name);
        let counter = 1;

        // 중복 처리
        while (true) {
          try {
            await fs.access(dest);
            const ext = path.extname(name);
            const base = path.basename(name, ext);
            dest = path.join(destinationDir, `${base}_${counter}${ext}`);
            counter++;
          } catch {
            break;
          }
        }

        await fs.rename(src, dest);
        count++;
      } catch {
        // cross-device rename인 경우 copy + delete
        try {
          const name = path.basename(src);
          let dest = path.join(destinationDir, name);
          const stat = await fs.stat(src);
          if (stat.isDirectory()) {
            await copyDir(src, dest);
            await fs.rm(src, { recursive: true, force: true });
          } else {
            await fs.copyFile(src, dest);
            await fs.unlink(src);
          }
          count++;
        } catch {
          // 최종 실패
        }
      }
    }

    return { success: true, data: count };
  } catch (err) {
    const message = err instanceof Error ? err.message : "이동 실패";
    return { success: false, error: message };
  }
}

/** 디렉토리 내 중복 파일 탐색 (제목 또는 용량이 같은 경우) */
export async function scanDuplicates(
  dirPath: string
): Promise<ActionResult<{ duplicates: FMEntry[][]; totalDuplicates: number }>> {
  try {
    // 재귀적으로 모든 파일 수집
    const allFiles: FMEntry[] = [];

    async function collectFiles(dir: string) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "$RECYCLE.BIN" || entry.name === "System Volume Information") {
            continue;
          }
          const fullPath = path.join(dir, entry.name);
          try {
            const stat = await fs.stat(fullPath);
            if (entry.isDirectory()) {
              await collectFiles(fullPath);
            } else if (stat.isFile()) {
              allFiles.push({
                name: entry.name,
                path: fullPath,
                isDirectory: false,
                size: stat.size,
                modifiedAt: stat.mtime.toISOString(),
              });
            }
          } catch {
            // 접근 불가 파일 무시
          }
        }
      } catch {
        // 접근 불가 디렉토리 무시
      }
    }

    await collectFiles(dirPath);

    // 제목별 그룹화
    const byName = new Map<string, FMEntry[]>();
    for (const file of allFiles) {
      const baseName = file.name.toLowerCase();
      if (!byName.has(baseName)) {
        byName.set(baseName, []);
      }
      byName.get(baseName)!.push(file);
    }

    // 용량별 그룹화 (0보다 큰 파일만)
    const bySize = new Map<number, FMEntry[]>();
    for (const file of allFiles) {
      if (file.size > 0) {
        if (!bySize.has(file.size)) {
          bySize.set(file.size, []);
        }
        bySize.get(file.size)!.push(file);
      }
    }

    // 중복集合 (제목 또는 용량이 같은 파일들)
    const allDuplicates = new Set<string>();
    const duplicateGroups: FMEntry[][] = [];

    // 제목이 같은 그룹
    for (const [_, files] of byName) {
      if (files.length > 1) {
        const groupKey = files.map(f => f.path).sort().join("|");
        if (!allDuplicates.has(groupKey)) {
          allDuplicates.add(groupKey);
          duplicateGroups.push(files);
        }
      }
    }

    // 용량이 같은 그룹 (제목 중복과 중복되지 않은 파일만)
    for (const [_, files] of bySize) {
      if (files.length > 1) {
        // 이미 제목 중복으로 추가된 파일 제외
        const newFiles = files.filter(f => {
          const isInNameDuplicate = duplicateGroups.some(g =>
            g.some(gf => gf.path === f.path)
          );
          return !isInNameDuplicate;
        });

        if (newFiles.length > 1) {
          duplicateGroups.push(newFiles);
        }
      }
    }

    const totalDuplicates = duplicateGroups.reduce((sum, g) => sum + g.length - 1, 0);

    return {
      success: true,
      data: { duplicates: duplicateGroups, totalDuplicates }
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "중복 탐색 실패";
    return { success: false, error: message };
  }
}
