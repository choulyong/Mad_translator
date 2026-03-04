"use server";

import fs from "fs/promises";
import path from "path";
import type { ActionResult, MovieMetadata } from "@/lib/types";
import { buildMovieFilename, sanitizeFilename, getExtension } from "@/lib/utils";

export async function processRename(
  filePath: string,
  metadata: MovieMetadata,
  folderPath?: string
): Promise<ActionResult<{ newPath: string; newName: string; newFolderName?: string; skipped?: boolean }>> {
  try {
    const ext = getExtension(filePath);
    let newFileName = buildMovieFilename(metadata.title, metadata.year, ext);
    const folderBaseName = `${sanitizeFilename(metadata.title)} (${metadata.year})`;

    let finalFilePath: string;
    let finalNewName = newFileName;
    let newFolderName: string | undefined;

    if (folderPath) {
      // 폴더 + 파일 모두 변경
      const parentDir = path.dirname(folderPath);
      let newFolderPath = path.join(parentDir, folderBaseName);

      // 폴더 중복 처리
      let counter = 1;
      while (true) {
        try {
          await fs.access(newFolderPath);
          // 같은 폴더인 경우 (이미 맞는 이름) → 중복 아님
          if (newFolderPath === folderPath) break;
          newFolderPath = path.join(parentDir, `${folderBaseName}_${counter}`);
          counter++;
        } catch {
          break;
        }
      }

      // 1. 먼저 파일명 변경 (폴더 안에서)
      const newFileInOldFolder = path.join(folderPath, newFileName);

      // 파일 중복 처리
      counter = 1;
      while (true) {
        try {
          await fs.access(newFileInOldFolder);
          if (newFileInOldFolder === filePath) break;
          const base = `${sanitizeFilename(metadata.title)} (${metadata.year})_${counter}`;
          newFileName = `${base}${ext}`;
          finalNewName = newFileName;
          counter++;
        } catch {
          break;
        }
      }

      const renamedFileInOldFolder = path.join(folderPath, finalNewName);
      if (filePath !== renamedFileInOldFolder) {
        await fs.rename(filePath, renamedFileInOldFolder);
      }

      // 2. 그 다음 폴더명 변경
      if (folderPath !== newFolderPath) {
        await fs.rename(folderPath, newFolderPath);
      }

      finalFilePath = path.join(newFolderPath, finalNewName);
      newFolderName = path.basename(newFolderPath);
    } else {
      // 파일만 변경 (폴더 없음)
      const dir = path.dirname(filePath);
      let newPath = path.join(dir, newFileName);

      let counter = 1;
      while (true) {
        try {
          await fs.access(newPath);
          if (newPath === filePath) break;
          const base = `${sanitizeFilename(metadata.title)} (${metadata.year})_${counter}`;
          newFileName = `${base}${ext}`;
          finalNewName = newFileName;
          newPath = path.join(dir, finalNewName);
          counter++;
        } catch {
          break;
        }
      }

      if (filePath !== newPath) {
        await fs.rename(filePath, newPath);
      }
      finalFilePath = newPath;
    }

    return { success: true, data: { newPath: finalFilePath, newName: finalNewName, newFolderName } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Rename failed";
    return { success: false, error: message };
  }
}
