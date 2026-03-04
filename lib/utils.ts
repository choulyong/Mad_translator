import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

export function sanitizeFilename(name: string): string {
  return name.replace(ILLEGAL_CHARS, "").trim();
}

const VIDEO_EXTENSIONS = [".mkv", ".mp4", ".avi"];

export function isVideoFile(filename: string): boolean {
  const ext = getExtension(filename).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

export function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot === -1 ? "" : filename.slice(lastDot);
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

export function buildMovieFilename(title: string, year: string, ext: string): string {
  const sanitized = sanitizeFilename(title);
  return `${sanitized} (${year})${ext}`;
}
