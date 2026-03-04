"use server";

import fs from "fs/promises";
import path from "path";
import type { ActionResult, MovieMetadata } from "@/lib/types";
import { buildMovieFilename, sanitizeFilename, getExtension } from "@/lib/utils";

// 타임아웃 유틸리티
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("timeout")), ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

// 파일만 이름 변경 (폴더는 그대로) - fs.rename 사용
async function renameFileOnly(src: string, dest: string): Promise<void> {
  await fs.rename(src, dest);
}

export async function processRename(
  filePath: string,
  metadata: MovieMetadata,
  folderPath?: string
): Promise<ActionResult<{ newPath: string; newName: string; newFolderName?: string; skipped?: boolean }>> {
  console.log(`[processRename] 시작: ${filePath}, folderPath: ${folderPath}`);
  try {
    const ext = getExtension(filePath);
    let newFileName = buildMovieFilename(metadata.title, metadata.year, ext);

    let finalFilePath: string;
    let finalNewName = newFileName;

    // 폴더 경로 결정 (folderPath 있으면 사용, 없으면 파일의 디렉토리)
    const dir = folderPath ? folderPath : path.dirname(filePath);

    // 같은 이름의 파일이 있으면 스킵
    const sameNamePath = path.join(dir, newFileName);
    if (sameNamePath === filePath) {
      console.log(`[processRename] 같은 이름, 스킵: ${finalNewName}`);
      return { success: true, data: { newPath: filePath, newName: newFileName, skipped: true } };
    }

    // 이미 같은 이름의 파일이 존재하면 스킵
    try {
      await fs.access(sameNamePath);
      console.log(`[processRename] 이미 존재하는 이름, 스킵: ${newFileName}`);
      return { success: true, data: { newPath: filePath, newName: newFileName, skipped: true } };
    } catch {
      // 파일이不存在, 계속 진행
    }

    finalFilePath = sameNamePath;
    console.log(`[processRename] 완료: ${finalNewName}`);
    return { success: true, data: { newPath: finalFilePath, newName: finalNewName } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Rename failed";
    console.log(`[processRename] 실패: ${message}`);
    return { success: false, error: message };
  }
}
