import ptt from "parse-torrent-title";
import type { ParsedFilename } from "./types";

export function parseFilename(filename: string): ParsedFilename {
  // Remove extension before parsing
  const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
  const result = ptt.parse(nameWithoutExt);

  return {
    title: result.title || nameWithoutExt,
    year: result.year || undefined,
  };
}
