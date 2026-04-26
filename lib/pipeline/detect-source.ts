/**
 * Detect input URL source type
 *
 * - youtube : 走 transcript / iframe 路徑(快,不下載 mp4)
 * - video-url : 用 yt-dlp 下載成本機 mp4 + 走 video pipeline (1000+ 平台)
 * - podcast : 純音訊 URL,只抓音檔走 audio pipeline
 */

export type SourceType = "youtube" | "video-url" | "podcast";

const VIDEO_PLATFORMS = [
  "twitter.com", "x.com",
  "tiktok.com", "douyin.com",
  "bilibili.com", "b23.tv",
  "instagram.com", "fb.watch", "facebook.com",
  "vimeo.com",
  "threads.net",
  "weibo.com",
  "xhslink.com", "xiaohongshu.com",
  "reddit.com",
  "twitch.tv",
];

const AUDIO_EXT_PATTERN = /\.(mp3|m4a|wav|ogg|aac|flac|opus)(\?|$)/i;
const PODCAST_HOSTS = /soundcloud|spotify|anchor\.fm|podbean|libsyn|simplecast/i;

export function detectSource(url: string): SourceType {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (VIDEO_PLATFORMS.some((host) => new RegExp(host.replace(/\./g, "\\."), "i").test(url))) {
    return "video-url";
  }
  if (AUDIO_EXT_PATTERN.test(url) || PODCAST_HOSTS.test(url)) return "podcast";
  // 預設視為 video-url 用 yt-dlp 試;若 yt-dlp 認得就 work,認不得會在 fetch 階段丟錯
  return "video-url";
}

export function extractId(url: string, source: SourceType): string {
  if (source === "youtube") {
    const patterns = [
      /v=([a-zA-Z0-9_-]{11})/,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /shorts\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    throw new Error("Invalid YouTube URL");
  }
  // video-url / podcast: hash the URL
  const crypto = require("crypto");
  return crypto.createHash("md5").update(url).digest("hex").slice(0, 12);
}
