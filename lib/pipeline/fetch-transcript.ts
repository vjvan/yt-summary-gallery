import fs from "fs";
import path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalYouTubeUrl, fetchWatchSource } from "../watch/source";
import type { WatchSource } from "../watch/types";
const execFileAsync = promisify(execFile);
import { transcribeAudio } from "./transcribe";

/** Validate and canonicalize before invoking any downloader. */
export function extractVideoId(url: string): string { return canonicalYouTubeUrl(url).videoId; }

export interface TranscriptSegment {
  start: number; // seconds
  end: number;
  text: string;
}

export interface VideoMetadata {
  video_id: string;
  title: string;
  channel: string;
  duration: number;
  duration_display: string;
  upload_date: string;
  thumbnail_url: string;
  view_count: number;
  transcript_source: string;
}

export interface TranscriptResult {
  metadata: VideoMetadata;
  transcript: string;
  segments: TranscriptSegment[];
}

export async function fetchMetadata(url: string): Promise<VideoMetadata> {
  const canonical = canonicalYouTubeUrl(url);
  const { stdout: raw } = await execFileAsync('yt-dlp', ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '--dump-single-json', '--skip-download', '--', canonical.url], { timeout: 60_000, maxBuffer: 12 * 1024 * 1024 });
  const data = JSON.parse(raw);
  const duration = data.duration || 0;
  const mins = Math.floor(duration / 60);
  const secs = Math.floor(duration % 60);

  return {
    video_id: data.id,
    title: data.title || "",
    channel: data.channel || data.uploader || "",
    duration,
    duration_display: `${mins}:${secs.toString().padStart(2, "0")}`,
    upload_date: data.upload_date || "",
    thumbnail_url: data.thumbnail || "",
    view_count: data.view_count || 0,
    transcript_source: "",
  };
}

/** Convert supported original JSON3/VTT captions; never request a nonexistent native SRT. */
export function transcriptFromWatchSource(source: WatchSource): TranscriptResult {
  const duration = Math.max(0, ...source.cues.map(cue => cue.end));
  const segments = source.cues.map(({ start, end, text }) => ({ start, end, text }));
  return {
    metadata: { video_id: source.videoId, title: source.title, channel: '', duration,
      duration_display: `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`,
      upload_date: '', thumbnail_url: `https://i.ytimg.com/vi/${source.videoId}/hqdefault.jpg`,
      view_count: 0, transcript_source: `subtitle:${source.sourceKind}:${source.language}` },
    transcript: segments.map(cue => cue.text).join(' '), segments,
  };
}

export interface FetchTranscriptOptions {
  /** Paid audio recognition is never an implicit fallback. */
  allowAudioTranscription?: boolean;
  source?: typeof fetchWatchSource;
}

export async function fetchTranscript(url: string, tmpDir: string, options: FetchTranscriptOptions = {}): Promise<TranscriptResult> {
  const canonical = canonicalYouTubeUrl(url);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    return transcriptFromWatchSource(await (options.source || fetchWatchSource)(canonical.url));
  } catch (error) {
    if (!options.allowAudioTranscription) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      throw new Error(code === 'NO_CAPTIONS'
        ? '找不到可讀取的英文原文字幕。請改用有字幕的影片，或明確選擇音訊辨識流程；沒有自動下載音訊或呼叫付費 Whisper。'
        : '目前無法取得 YouTube 原文字幕（可能受到流量限制或需要更新 yt-dlp）。請稍後重試；沒有自動下載音訊或送出付費辨識。');
    }
  }
  // Retained for explicitly authorized legacy/cloud callers only.
  const metadata = await fetchMetadata(canonical.url);
  const audioPath = path.join(tmpDir, 'audio.mp3');
  try {
    await execFileAsync('yt-dlp', ['--ignore-config', '--no-plugin-dirs', '--no-playlist', '-x', '--audio-format', 'mp3', '--audio-quality', '5', '-o', audioPath, '--', canonical.url], { timeout: 300_000, maxBuffer: 12 * 1024 * 1024 });
  } catch {
    throw new Error('YouTube 未允許下載音訊（例如 HTTP 403）。請使用已授權的本機音訊/影片檔；重試摘要不會修復下載權限。');
  }
  const result = await transcribeAudio(audioPath, { tmpDir });
  metadata.transcript_source = 'whisper';
  return { metadata, transcript: result.text, segments: result.segments };
}
