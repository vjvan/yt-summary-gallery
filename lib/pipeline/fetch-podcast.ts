import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import type { TranscriptSegment, VideoMetadata, TranscriptResult } from "./fetch-transcript";

/**
 * Detect if a URL is a podcast (not YouTube)
 * Supports: Apple Podcasts, Spotify, direct mp3/m4a URLs, RSS feeds
 */
export function isPodcastUrl(url: string): boolean {
  // Not YouTube
  if (/youtube\.com|youtu\.be/i.test(url)) return false;
  // Direct audio file
  if (/\.(mp3|m4a|wav|ogg|opus|aac)(\?|$)/i.test(url)) return true;
  // Known podcast platforms
  if (/podcasts\.apple\.com|spotify\.com|anchor\.fm|soundcloud\.com|overcast\.fm|pocketcasts/i.test(url)) return true;
  // RSS feeds
  if (/\.xml(\?|$)|feed|rss/i.test(url)) return false; // RSS not supported yet
  return false;
}

/**
 * Generate a stable ID from podcast URL
 */
export function extractPodcastId(url: string): string {
  return crypto.createHash("md5").update(url).digest("hex").slice(0, 12);
}

/**
 * Fetch podcast audio and transcribe with Whisper
 */
export function fetchPodcast(url: string, tmpDir: string): TranscriptResult {
  fs.mkdirSync(tmpDir, { recursive: true });

  const isDirectAudio = /\.(mp3|m4a|wav|ogg|opus|aac)(\?|$)/i.test(url);
  let audioPath: string;
  let title = "";
  let channel = "";
  let duration = 0;

  if (isDirectAudio) {
    // Direct audio URL: download with curl
    audioPath = path.join(tmpDir, "audio.mp3");
    execSync(`curl -L -o "${audioPath}" "${url}"`, { timeout: 300000, stdio: "pipe" });
    title = path.basename(new URL(url).pathname).replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
  } else if (/spotify\.com/i.test(url)) {
    // Spotify: DRM protected, cannot download audio
    // Try to get metadata via oEmbed
    try {
      const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
      const oembed = execSync(`curl -s "${oembedUrl}"`, { encoding: "utf-8", timeout: 10000 });
      const info = JSON.parse(oembed);
      title = info.title || "";
      channel = info.provider_name || "Spotify Podcast";
    } catch {
      // ignore
    }
    throw new Error(
      "Spotify 有 DRM 保護，無法直接下載音訊。\n" +
      "請改用以下方式:\n" +
      "1. 上傳 Podcast 音訊檔 (mp3/m4a)\n" +
      "2. 貼上 Apple Podcasts 連結\n" +
      "3. 貼上節目的直接音訊連結"
    );
  } else {
    // Other podcast platforms: try yt-dlp
    audioPath = path.join(tmpDir, "audio");
    try {
      const infoRaw = execSync(`yt-dlp --dump-json --skip-download "${url}"`, {
        timeout: 60000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const info = JSON.parse(infoRaw);
      title = info.title || "";
      channel = info.channel || info.uploader || info.podcast || "";
      duration = info.duration || 0;
    } catch {
      // metadata extraction failed, continue with download
    }

    try {
      execSync(
        `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${audioPath}.%(ext)s" "${url}"`,
        { timeout: 300000, stdio: "pipe" }
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (/DRM|drm/i.test(msg)) {
        throw new Error("此平台有 DRM 保護，無法下載音訊。請改用上傳音訊檔或其他連結。");
      }
      throw new Error("無法下載此連結的音訊。請確認連結正確，或改用上傳音訊檔。");
    }

    // Find downloaded file
    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith("audio") && f.endsWith(".mp3"));
    if (files.length === 0) throw new Error("下載失敗，請改用上傳音訊檔或其他連結。");
    audioPath = path.join(tmpDir, files[0]);
  }

  // Check file exists and size
  if (!fs.existsSync(audioPath)) throw new Error("Audio file not found after download");

  const stat = fs.statSync(audioPath);
  if (stat.size < 1000) throw new Error("Downloaded file too small, likely not audio");

  // Compress if over 25MB
  if (stat.size > 25 * 1024 * 1024) {
    const compressed = path.join(tmpDir, "compressed.mp3");
    execSync(`ffmpeg -i "${audioPath}" -b:a 64k -ar 16000 -y "${compressed}"`, {
      timeout: 300000,
      stdio: "pipe",
    });
    audioPath = compressed;
  }

  // Get duration from audio if not available
  if (!duration) {
    try {
      const probe = execSync(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim();
      duration = parseFloat(probe) || 0;
    } catch {
      // ignore
    }
  }

  const mins = Math.floor(duration / 60);
  const secs = Math.floor(duration % 60);

  // Whisper transcription with timestamps
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const result = execSync(
    `curl -s -X POST "https://api.openai.com/v1/audio/transcriptions" ` +
      `-H "Authorization: Bearer ${apiKey}" ` +
      `-F "file=@${audioPath}" ` +
      `-F "model=whisper-1" ` +
      `-F "language=zh" ` +
      `-F "response_format=verbose_json" ` +
      `--max-time 600`,
    { encoding: "utf-8", timeout: 620000 }
  );

  const data = JSON.parse(result);
  const segments: TranscriptSegment[] = (data.segments || []).map(
    (s: { start: number; end: number; text: string }) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    })
  );

  const metadata: VideoMetadata = {
    video_id: extractPodcastId(url),
    title: title || "Podcast Episode",
    channel: channel || "Podcast",
    duration,
    duration_display: `${mins}:${secs.toString().padStart(2, "0")}`,
    upload_date: "",
    thumbnail_url: "",
    view_count: 0,
    transcript_source: "whisper",
  };

  return {
    metadata,
    transcript: data.text || segments.map(s => s.text).join(" "),
    segments,
  };
}
