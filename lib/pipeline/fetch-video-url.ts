/**
 * 用 yt-dlp 從任意網頁 URL 下載影片成本機 mp4。
 * 支援 1000+ 平台:X/Twitter, TikTok, Bilibili, IG, Vimeo, FB, Threads...
 */

import path from "path";
import fs from "fs";
import { run } from "./run-command";
import { mediaFailureMessage } from "../media-export-client";

export interface VideoUrlMetadata {
  videoPath: string;       // 本機 tmp mp4 完整路徑
  publicVideoUrl: string;  // /videos/<contentId>.mp4
  title: string;
  channel: string;
  duration: number;
  durationDisplay: string;
  thumbnailUrl: string;
}

function resolveYtDlp(): string {
  if (process.env.YTDLP_BIN) return process.env.YTDLP_BIN;
  for (const c of ["/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"]) {
    if (fs.existsSync(c)) return c;
  }
  return "yt-dlp";
}

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export async function fetchVideoFromUrl(url: string, contentId: string, projectRoot: string): Promise<VideoUrlMetadata> {
  const ytdlp = resolveYtDlp();
  const tmpDir = path.join(projectRoot, "data", "tmp", contentId);
  fs.mkdirSync(tmpDir, { recursive: true });

  // -S "res:720" : 偏好 720p 以下。目的是字幕與摘要,不是收藏影片檔;
  //   實測一支 56 分鐘的 X 影片,1080p 要 4.3 GB、720p 913 MB。
  // -f best[ext=mp4]/best : 偏好 mp4
  // --no-playlist : 防止某些 URL 拉整個 playlist
  // --write-info-json : 拿 metadata
  // --merge-output-format mp4 : 若 video/audio 分流自動合成 mp4
  // -o : 固定輸出檔名,避免奇怪檔名
  const outputTemplate = path.join(tmpDir, `${contentId}.%(ext)s`);

  try {
    await run(
      `"${ytdlp}" -f "best[ext=mp4]/best" -S "res:720" --no-playlist --write-info-json ` +
        `--merge-output-format mp4 --no-warnings ` +
        `-o "${outputTemplate}" "${url}"`,
      { timeoutMs: 600000 }
    );
  } catch (err) {
    // Classify structured stderr before truncation: a long command used to hide
    // the actual 403. Only fixed, sanitized copy may reach the UI or database.
    const stderr = err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string" ? err.stderr : "";
    const message = stderr.trim() ? stderr : err instanceof Error ? err.message : "";
    throw new Error(mediaFailureMessage(message, "download"));
  }

  // 找實際下載出來的影片檔(可能是 .mp4 / .mkv / .webm 看 source)
  const candidates = ["mp4", "mkv", "webm", "mov"];
  let videoPath = "";
  for (const ext of candidates) {
    const candidate = path.join(tmpDir, `${contentId}.${ext}`);
    if (fs.existsSync(candidate)) {
      videoPath = candidate;
      break;
    }
  }
  if (!videoPath) {
    throw new Error("yt-dlp 沒有產出可識別的影片檔");
  }

  // 讀 metadata
  const infoPath = path.join(tmpDir, `${contentId}.info.json`);
  let title = "Video";
  let channel = "";
  let duration = 0;
  let thumbnail = "";
  if (fs.existsSync(infoPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
      title = info.title || info.fulltitle || title;
      channel = info.uploader || info.channel || info.creator || "";
      duration = info.duration || 0;
      thumbnail = info.thumbnail || "";
    } catch { /* ignore parse error */ }
  }

  // 複製到 public/videos 給 player 用
  const publicVideoDir = path.join(projectRoot, "public", "videos");
  fs.mkdirSync(publicVideoDir, { recursive: true });
  const publicVideoFile = `${contentId}.mp4`;
  const publicTarget = path.join(publicVideoDir, publicVideoFile);
  // 若不是 mp4 (e.g. mkv),需要 ffmpeg remux 成 mp4 (-c copy 不重編碼,快)
  if (videoPath.endsWith(".mp4")) {
    fs.copyFileSync(videoPath, publicTarget);
  } else {
    await run(`ffmpeg -i "${videoPath}" -c copy -y "${publicTarget}"`, { timeoutMs: 120000 });
    // 把 videoPath 也指到 mp4,方便後面 audio 抽取一致
    videoPath = publicTarget;
  }

  return {
    videoPath,
    publicVideoUrl: `/videos/${publicVideoFile}`,
    title,
    channel,
    duration,
    durationDisplay: fmtDuration(duration),
    thumbnailUrl: thumbnail,
  };
}
