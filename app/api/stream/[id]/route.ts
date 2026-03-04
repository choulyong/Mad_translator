import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { movies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import os from "os";
import crypto from "crypto";

// Extensions browsers can play natively
const NATIVE_EXTENSIONS = new Set([".mp4", ".m4v", ".webm"]);

// Audio codecs all modern browsers support
const BROWSER_AUDIO = new Set([
  "aac", "mp3", "opus", "vorbis", "flac",
  "pcm_s16le", "pcm_s24le", "pcm_f32le", "pcm_u8",
]);

const CACHE_DIR = path.join(os.tmpdir(), "movie-renamer-cache");

// Job tracking
const remuxJobs = new Map<string, Promise<string>>();
const hlsJobs = new Map<string, "pending" | "ready" | "error">();
const codecCache = new Map<string, { audio: string; video: string }>();

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function fileHash(filePath: string): string {
  return crypto.createHash("md5").update(filePath).digest("hex");
}

function getCachePath(filePath: string): string {
  return path.join(CACHE_DIR, `${fileHash(filePath)}.mp4`);
}

function getHLSDir(filePath: string): string {
  return path.join(CACHE_DIR, `hls_${fileHash(filePath)}`);
}

/** Fast codec probe via ffprobe (cached, ~100ms) */
function probeCodecs(filePath: string): Promise<{ audio: string; video: string }> {
  const cached = codecCache.get(filePath);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", filePath],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );

    let data = "";
    proc.stdout.on("data", (chunk: Buffer) => { data += chunk.toString(); });

    proc.on("close", () => {
      try {
        const streams = (JSON.parse(data).streams || []) as Record<string, unknown>[];
        const video = streams.find((s) => s.codec_type === "video");
        const audio = streams.find((s) => s.codec_type === "audio");
        const result = {
          audio: (audio?.codec_name as string) || "unknown",
          video: (video?.codec_name as string) || "unknown",
        };
        codecCache.set(filePath, result);
        resolve(result);
      } catch {
        resolve({ audio: "unknown", video: "unknown" });
      }
    });
    proc.on("error", () => resolve({ audio: "unknown", video: "unknown" }));
    setTimeout(() => { try { proc.kill("SIGTERM"); } catch { } }, 5000);
  });
}

/** Wait until file exists and has data (for HLS segments) */
function waitForFile(filePath: string, timeoutMs = 45000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
          resolve(true);
          return;
        }
      } catch (e) {
        // Ignore errors (e.g., EPERM file lock by ffmpeg on Windows)
      }

      if (Date.now() >= deadline) {
        resolve(false);
      } else {
        setTimeout(poll, 200);
      }
    };
    poll();
  });
}

/** Start HLS generation job (background, non-blocking) */
async function startHLS(filePath: string): Promise<void> {
  if (hlsJobs.has(filePath)) return;

  ensureCacheDir();
  const hlsDir = getHLSDir(filePath);
  const m3u8 = path.join(hlsDir, "playlist.m3u8");

  // Already generated
  if (fs.existsSync(m3u8) && fs.statSync(m3u8).size > 0) {
    hlsJobs.set(filePath, "ready");
    return;
  }

  fs.mkdirSync(hlsDir, { recursive: true });
  hlsJobs.set(filePath, "pending");

  try {
    const codecs = await probeCodecs(filePath);
    const isVideoCompatible = ["h264", "vp8", "vp9", "av1"].includes(codecs.video);

    const videoArgs = isVideoCompatible
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-maxrate", "3000k", "-bufsize", "6000k"];

    const proc = spawn("ffmpeg", [
      "-y",
      "-i", filePath,
      ...videoArgs,
      "-c:a", "aac",           // Audio: transcode to AAC (browser compat)
      "-ac", "2",              // Stereo (downmix multichannel)
      "-b:a", "128k",          // Lower bitrate for faster encoding
      "-q:a", "9",             // AAC quality (lower = faster)
      "-f", "hls",
      "-hls_time", "10",       // 10-second segments (larger = faster processing)
      "-hls_list_size", "0",   // Keep all segments in playlist
      "-hls_flags", "split_by_time+independent_segments",
      "-hls_segment_type", "mpegts",  // MPEG-TS format (simpler, no init segment)
      "-hls_segment_filename", path.join(hlsDir, "seg%06d.ts"),
      "-loglevel", "error",
      m3u8,
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

    proc.on("close", (code) => {
      hlsJobs.set(filePath, code === 0 ? "ready" : "error");
    });
    proc.on("error", () => {
      hlsJobs.set(filePath, "error");
    });
  } catch (err) {
    hlsJobs.set(filePath, "error");
  }
}

/** Start background remux (MP4 container, for non-MKV non-native formats) */
function startBackgroundRemux(filePath: string): Promise<string> {
  const existing = remuxJobs.get(filePath);
  if (existing) return existing;

  ensureCacheDir();
  const cachePath = getCachePath(filePath);
  const tmpPath = cachePath + ".tmp";

  if (fs.existsSync(cachePath)) {
    try {
      const srcMtime = fs.statSync(filePath).mtimeMs;
      const cacheMtime = fs.statSync(cachePath).mtimeMs;
      if (cacheMtime > srcMtime) return Promise.resolve(cachePath);
    } catch { }
  }

  const promise = new Promise<string>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-y", "-i", filePath,
      "-c:v", "copy",
      "-c:a", "aac",
      "-q:a", "9",            // Very low quality
      "-b:a", "64k",          // Very low bitrate (faster)
      "-ar", "22050",         // Downsample to 22kHz (faster)
      "-movflags", "+faststart",
      "-loglevel", "error",
      tmpPath,
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      remuxJobs.delete(filePath);
      if (code === 0 && fs.existsSync(tmpPath)) {
        try {
          if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
          fs.renameSync(tmpPath, cachePath);
          resolve(cachePath);
        } catch (e) {
          try { fs.unlinkSync(tmpPath); } catch { }
          reject(new Error(`Rename failed: ${e}`));
        }
      } else {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { }
        reject(new Error(`FFmpeg failed (code ${code}): ${stderr}`));
      }
    });
    proc.on("error", (err) => {
      remuxJobs.delete(filePath);
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { }
      reject(err);
    });
  });

  remuxJobs.set(filePath, promise);
  return promise;
}

/** Serve file with HTTP range support (instant seek) */
function streamFile(
  filePath: string,
  fileSize: number,
  rangeHeader: string | null,
  mimeType = "video/mp4"
): Response {
  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    const stream = fs.createReadStream(filePath, { start, end });
    const readable = new ReadableStream({
      start(controller) {
        stream.on("data", (chunk) => controller.enqueue(chunk));
        stream.on("end", () => controller.close());
        stream.on("error", (err) => controller.error(err));
      },
      cancel() { stream.destroy(); },
    });

    return new Response(readable, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunkSize),
        "Content-Type": mimeType,
        "Cache-Control": "no-cache",
      },
    });
  }

  const stream = fs.createReadStream(filePath);
  const readable = new ReadableStream({
    start(controller) {
      stream.on("data", (chunk) => controller.enqueue(chunk));
      stream.on("end", () => controller.close());
      stream.on("error", (err) => controller.error(err));
    },
    cancel() { stream.destroy(); },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Length": String(fileSize),
      "Content-Type": mimeType,
      "Cache-Control": "no-cache",
    },
  });
}

/** Legacy pipe stream (fragmented MP4, no seeking) */
function streamViaPipe(filePath: string): Response {
  const args = [
    "-i", filePath,
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "-loglevel", "error",
    "pipe:1",
  ];

  const ffmpeg = spawn("ffmpeg", args, {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });

  const readable = new ReadableStream({
    start(controller) {
      ffmpeg.stdout.on("data", (chunk: Buffer) => {
        try { controller.enqueue(new Uint8Array(chunk)); }
        catch { ffmpeg.kill("SIGTERM"); }
      });
      ffmpeg.stdout.on("end", () => { try { controller.close(); } catch { } });
      ffmpeg.on("error", () => { try { controller.close(); } catch { } });
    },
    cancel() { ffmpeg.kill("SIGTERM"); },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "video/mp4",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    },
  });
}

// ─── Subtitle helpers (unchanged) ───────────────────────────────────────────

function parseSubtitleFiles(json: string | null): { fileName: string; filePath: string; language: string }[] {
  if (!json) return [];
  try { return JSON.parse(json); } catch { return []; }
}

function getSubtitleTracks(filePath: string, subtitleFilesJson?: string | null): Promise<Response> {
  const externalSubs = parseSubtitleFiles(subtitleFilesJson ?? null);
  const externalTracks = externalSubs.map((sub, i) => ({
    index: i,
    streamIndex: -1 - i,
    codec: "external",
    language: sub.language || "und",
    title: sub.fileName,
    external: true,
  }));

  ensureCacheDir();
  const hash = fileHash(filePath);
  const jsonPath = path.join(CACHE_DIR, `${hash}_tracks.json`);

  if (fs.existsSync(jsonPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      return Promise.resolve(NextResponse.json({ tracks: [...externalTracks, ...cached.tracks] }));
    } catch {
      try { fs.unlinkSync(jsonPath); } catch { }
    }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-select_streams", "s",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      try {
        const stdout = Buffer.concat(chunks).toString("utf-8");
        const data = JSON.parse(stdout);
        const embeddedTracks = (data.streams || []).map((s: Record<string, unknown>, i: number) => ({
          index: externalTracks.length + i,
          streamIndex: s.index,
          codec: s.codec_name,
          language: (s.tags as Record<string, string>)?.language || "und",
          title: (s.tags as Record<string, string>)?.title || "",
        }));
        const result = { tracks: embeddedTracks };
        try { fs.writeFileSync(jsonPath, JSON.stringify(result), "utf-8"); } catch { }
        resolve(NextResponse.json({ tracks: [...externalTracks, ...embeddedTracks] }));
      } catch {
        if (code !== 0) console.error(`[subtitle-tracks] ffprobe failed: code=${code} stderr=${stderr}`);
        resolve(NextResponse.json({ tracks: externalTracks }));
      }
    });
    proc.on("error", (err) => {
      console.error(`[subtitle-tracks] spawn error:`, err.message);
      resolve(NextResponse.json({ tracks: externalTracks }));
    });
    setTimeout(() => { try { proc.kill("SIGTERM"); } catch { } }, 30_000);
  });
}

function srtToVtt(srt: string): string {
  let vtt = "WEBVTT\n\n";
  vtt += srt
    .replace(/\r\n/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .replace(/^\d+\s*\n/gm, "");
  return vtt;
}

function extractSubtitles(filePath: string, subtitleFilesJson?: string | null): Promise<Response> {
  const externalSubs = parseSubtitleFiles(subtitleFilesJson ?? null);
  const koreanSub = externalSubs.find(s => s.language === "ko");
  if (koreanSub && fs.existsSync(koreanSub.filePath)) {
    try {
      const srt = fs.readFileSync(koreanSub.filePath, "utf-8");
      return Promise.resolve(new Response(srtToVtt(srt), {
        headers: { "Content-Type": "text/vtt; charset=utf-8" },
      }));
    } catch { }
  }
  const anySub = externalSubs[0];
  if (anySub && fs.existsSync(anySub.filePath)) {
    try {
      const srt = fs.readFileSync(anySub.filePath, "utf-8");
      return Promise.resolve(new Response(srtToVtt(srt), {
        headers: { "Content-Type": "text/vtt; charset=utf-8" },
      }));
    } catch { }
  }

  ensureCacheDir();
  const hash = fileHash(filePath);
  const vttPath = path.join(CACHE_DIR, `${hash}_sub0.vtt`);
  const vttTmpPath = vttPath + ".tmp";

  if (fs.existsSync(vttPath) && fs.statSync(vttPath).size > 10) {
    const content = fs.readFileSync(vttPath, "utf-8");
    return Promise.resolve(new Response(content, {
      headers: { "Content-Type": "text/vtt; charset=utf-8" },
    }));
  }
  try { if (fs.existsSync(vttPath)) fs.unlinkSync(vttPath); } catch { }

  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", [
      "-y", "-i", filePath,
      "-map", "0:s:0",
      "-f", "webvtt",
      "-loglevel", "error",
      vttTmpPath,
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code === 0 && fs.existsSync(vttTmpPath) && fs.statSync(vttTmpPath).size > 10) {
        try {
          fs.renameSync(vttTmpPath, vttPath);
          const content = fs.readFileSync(vttPath, "utf-8");
          resolve(new Response(content, { headers: { "Content-Type": "text/vtt; charset=utf-8" } }));
          return;
        } catch { }
      }
      try { if (fs.existsSync(vttTmpPath)) fs.unlinkSync(vttTmpPath); } catch { }
      console.error(`[subtitles] ffmpeg failed for ${path.basename(filePath)}: code=${code} stderr=${stderr}`);
      resolve(new Response("WEBVTT\n\n", { headers: { "Content-Type": "text/vtt; charset=utf-8" } }));
    });
    proc.on("error", (err) => {
      try { if (fs.existsSync(vttTmpPath)) fs.unlinkSync(vttTmpPath); } catch { }
      console.error(`[subtitles] spawn error:`, err.message);
      resolve(new Response("WEBVTT\n\n", { headers: { "Content-Type": "text/vtt; charset=utf-8" } }));
    });
    setTimeout(() => { try { proc.kill("SIGTERM"); } catch { } }, 60_000);
  });
}

// ─── Main Handler ────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const type = request.nextUrl.searchParams.get("type");

  const [movie] = await db.select().from(movies).where(eq(movies.id, id));
  if (!movie) return NextResponse.json({ error: "Movie not found" }, { status: 404 });

  const filePath = movie.filePath;
  if (!fs.existsSync(filePath)) return NextResponse.json({ error: "File not found" }, { status: 404 });

  if (type === "subtitles") return extractSubtitles(filePath, movie.subtitleFiles);
  if (type === "subtitle-tracks") return getSubtitleTracks(filePath, movie.subtitleFiles);

  const ext = path.extname(filePath).toLowerCase();

  // ── HLS playlist ─────────────────────────────────────────────────────────
  if (type === "hls") {
    startHLS(filePath);
    const hlsDir = getHLSDir(filePath);
    const m3u8Path = path.join(hlsDir, "playlist.m3u8");

    // Wait up to 30s for ffmpeg to write the first segments + playlist (increased from 15s)
    const ready = await waitForFile(m3u8Path, 30000);
    if (!ready) {
      console.error(`[HLS] Timeout generating m3u8 at ${m3u8Path}`);
      return NextResponse.json({ error: "HLS generation timeout" }, { status: 503 });
    }

    // Give ffmpeg a moment to flush the first segment entry (increased from 800ms)
    await new Promise(r => setTimeout(r, 1500));

    try {
      const content = fs.readFileSync(m3u8Path, "utf-8");
      if (!content || content.length === 0) {
        console.error(`[HLS] Generated m3u8 is empty at ${m3u8Path}`);
        return NextResponse.json({ error: "HLS playlist is empty" }, { status: 503 });
      }

      // ✅ Rewrite segment paths to go through our API
      const rewritten = content.replace(
        /^(seg\d+\.ts)$/gm,
        `/api/stream/${id}?type=hls-seg&seg=$1`
      );

      console.log(`[HLS] Serving m3u8 for ${path.basename(filePath)}, segments: ${(rewritten.match(/seg\d+\.ts/g) || []).length}`);

      return new Response(rewritten, {
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-cache",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      console.error(`[HLS] Error reading m3u8: ${err}`);
      return NextResponse.json({ error: "Failed to read HLS playlist" }, { status: 503 });
    }
  }

  // ── HLS segment ──────────────────────────────────────────────────────────
  if (type === "hls-seg") {
    const segName = request.nextUrl.searchParams.get("seg");
    if (!segName || !/^seg\d+\.ts$/.test(segName)) {
      return NextResponse.json({ error: "Invalid segment name" }, { status: 400 });
    }

    const hlsDir = getHLSDir(filePath);
    const segPath = path.join(hlsDir, segName);

    const ready = await waitForFile(segPath, 60000);
    if (!ready) return NextResponse.json({ error: "Segment not ready" }, { status: 404 });

    const data = fs.readFileSync(segPath);
    return new Response(data, {
      headers: {
        "Content-Type": "video/mp2t",
        "Cache-Control": "max-age=3600",
      },
    });
  }

  // ── Status ───────────────────────────────────────────────────────────────
  if (type === "status") {
    if (NATIVE_EXTENSIONS.has(ext)) {
      return NextResponse.json({ ready: true, mode: "native" });
    }

    if (ext === ".mkv") {
      const codecs = await probeCodecs(filePath);
      if (BROWSER_AUDIO.has(codecs.audio)) {
        return NextResponse.json({ ready: true, mode: "direct" });
      }
      // MP4 remux mode (incompatible audio like eac3)
      const cachePath = getCachePath(filePath);
      const isCached = fs.existsSync(cachePath) && fs.statSync(cachePath).size > 1024;
      const isRemuxing = remuxJobs.has(filePath);
      return NextResponse.json({
        ready: isCached,
        mode: "direct",
        remuxing: isRemuxing,
      });
    }

    // Legacy remux (AVI etc.)
    const cachePath = getCachePath(filePath);
    const isRemuxing = remuxJobs.has(filePath);
    let isCached = false;
    if (fs.existsSync(cachePath)) {
      isCached = fs.statSync(cachePath).size > 1024;
    }
    return NextResponse.json({ ready: isCached && !isRemuxing, remuxing: isRemuxing, mode: "remux" });
  }

  // ── Video streaming ───────────────────────────────────────────────────────
  const rangeHeader = request.headers.get("range");

  // Native MP4/WebM
  if (NATIVE_EXTENSIONS.has(ext)) {
    const stat = fs.statSync(filePath);
    return streamFile(filePath, stat.size, rangeHeader, "video/mp4");
  }

  // MKV: probe audio codec to choose mode
  if (ext === ".mkv") {
    const codecs = await probeCodecs(filePath);
    const fileName = path.basename(filePath);

    console.log(`[MKV] ${fileName} - Video: ${codecs.video}, Audio: ${codecs.audio}`);

    if (BROWSER_AUDIO.has(codecs.audio)) {
      // Compatible audio → serve MKV directly (instant + fully seekable!)
      console.log(`[MKV] ${fileName} - Direct mode (compatible audio)`);
      const stat = fs.statSync(filePath);
      return streamFile(filePath, stat.size, rangeHeader, "video/x-matroska");
    }

    // Incompatible audio (AC3/DTS/eac3 etc.) → Remux to MP4 (fast, no transcoding!)
    console.log(`[MKV] ${fileName} - MP4 remux mode (incompatible audio: ${codecs.audio})`);

    const cachePath = getCachePath(filePath);
    const stat = fs.statSync(filePath);

    // Start background remux with "-c copy" (no transcoding)
    startBackgroundRemux(filePath).catch(() => { });

    // Wait up to 5 seconds for MP4 to be ready, otherwise we tell frontend to use HLS
    const remuxReady = await waitForFile(cachePath, 5000);

    if (remuxReady) {
      const cached = fs.statSync(cachePath);
      console.log(`[MKV] ${fileName} - MP4 ready (${cached.size} bytes)`);
      return streamFile(cachePath, cached.size, rangeHeader, "video/mp4");
    }

    // Timeout: MP4 not ready yet, stream original MKV as fallback
    console.warn(`[MKV] ${fileName} - MP4 remux fallback to HLS required`);
    return NextResponse.json({ error: "Requires HLS fallback", fallbackUrl: `/api/stream/${id}?type=hls` }, { status: 415 });
  }

  // AVI and other legacy formats: remux + pipe fallback
  const cachePath = getCachePath(filePath);
  if (fs.existsSync(cachePath) && !remuxJobs.has(filePath)) {
    const stat = fs.statSync(cachePath);
    if (stat.size > 1024) {
      return streamFile(cachePath, stat.size, rangeHeader, "video/mp4");
    }
    try { fs.unlinkSync(cachePath); } catch { }
  }

  startBackgroundRemux(filePath).catch(() => { });
  return streamViaPipe(filePath);
}
