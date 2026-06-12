import fs from "fs";
import path from "path";
import { run } from "./run-command";
import { transcribeAudio } from "./transcribe";

const SUB_LANGS = "zh-Hant,zh-Hans,zh,en";

export function extractVideoId(url: string): string {
  const patterns = [
    /v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /shorts\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  throw new Error(`Cannot extract video ID from: ${url}`);
}

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
  const raw = await run(`yt-dlp --dump-json --skip-download "${url}"`, {
    timeoutMs: 60000,
  });
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

function parseTimeToSeconds(time: string): number {
  // 00:01:23,456 or 00:01:23.456
  const m = time.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
}

function parseSrtToSegments(srtPath: string): TranscriptSegment[] {
  const text = fs.readFileSync(srtPath, "utf-8");
  const blocks = text.trim().split(/\n\n+/);
  const segments: TranscriptSegment[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim());
    // Find timestamp line
    const timeLine = lines.find((l) => /\d{2}:\d{2}:\d{2}/.test(l) && l.includes("-->"));
    if (!timeLine) continue;

    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
    const start = parseTimeToSeconds(startStr);
    const end = parseTimeToSeconds(endStr);

    // Get text lines (everything after timestamp, not a number)
    const textLines = lines.filter(
      (l) => l && !/^\d+$/.test(l) && !l.includes("-->")
    );
    const segText = textLines.join(" ").replace(/<[^>]+>/g, "").trim();
    if (!segText) continue;

    // Deduplicate
    if (seen.has(segText)) continue;
    seen.add(segText);

    segments.push({ start, end, text: segText });
  }

  return segments;
}

async function fetchSubtitles(
  url: string,
  tmpDir: string
): Promise<{ text: string; segments: TranscriptSegment[] } | null> {
  try {
    await run(
      `yt-dlp --write-auto-sub --write-sub --sub-lang ${SUB_LANGS} --sub-format srt --skip-download -o "${tmpDir}/%(id)s.%(ext)s" "${url}"`,
      { timeoutMs: 120000 }
    );
  } catch {
    // subtitle download can fail silently
  }

  const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".srt"));
  if (files.length === 0) return null;

  const segments = parseSrtToSegments(path.join(tmpDir, files[0]));
  if (segments.length === 0) return null;

  const text = segments.map((s) => s.text).join(" ");
  return { text, segments };
}

async function transcribeWithWhisper(
  url: string,
  tmpDir: string
): Promise<{ text: string; segments: TranscriptSegment[] }> {
  const audioPath = path.join(tmpDir, "audio.mp3");

  await run(
    `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${audioPath}" "${url}"`,
    { timeoutMs: 300000 }
  );

  const mp3Files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".mp3"));
  if (mp3Files.length === 0) throw new Error("No audio file after download");
  const finalPath = path.join(tmpDir, mp3Files[0]);

  // 壓縮 / 25MB 切段 / 上傳都在 transcribeAudio 內處理。
  // 不再強制 language=zh:讓 Whisper 自動偵測,英文影片才不會被硬轉成中文逐字稿。
  const result = await transcribeAudio(finalPath, { tmpDir });
  return { text: result.text, segments: result.segments };
}

export async function fetchTranscript(url: string, tmpDir: string): Promise<TranscriptResult> {
  fs.mkdirSync(tmpDir, { recursive: true });

  const metadata = await fetchMetadata(url);

  // Try subtitles first
  const subs = await fetchSubtitles(url, tmpDir);
  if (subs && subs.text.length > 50) {
    metadata.transcript_source = "subtitle";
    return { metadata, transcript: subs.text, segments: subs.segments };
  }

  // Fallback to Whisper
  const whisper = await transcribeWithWhisper(url, tmpDir);
  metadata.transcript_source = "whisper";
  return { metadata, transcript: whisper.text, segments: whisper.segments };
}
