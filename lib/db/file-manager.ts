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
