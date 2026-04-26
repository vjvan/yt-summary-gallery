import { execSync } from "child_process";
import fs from "fs";
import path from "path";

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

export function fetchMetadata(url: string): VideoMetadata {
  const raw = execSync(`yt-dlp --dump-json --skip-download "${url}"`, {
    timeout: 60000,
    encoding: "utf-8",
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
    let segText = textLines.join(" ").replace(/<[^>]+>/g, "").trim();
    if (!segText) continue;

    // Deduplicate
    if (seen.has(segText)) continue;
    seen.add(segText);

    segments.push({ start, end, text: segText });
  }

  return segments;
}

function fetchSubtitles(
  url: string,
  tmpDir: string
): { text: string; segments: TranscriptSegment[] } | null {
  try {
    execSync(
      `yt-dlp --write-auto-sub --write-sub --sub-lang ${SUB_LANGS} --sub-format srt --skip-download -o "${tmpDir}/%(id)s.%(ext)s" "${url}"`,
      { timeout: 120000, encoding: "utf-8", stdio: "pipe" }
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

function transcribeWithWhisper(
  url: string,
  tmpDir: string
): { text: string; segments: TranscriptSegment[] } {
  const audioPath = path.join(tmpDir, "audio.mp3");

  execSync(
    `yt-dlp -x --audio-format mp3 --audio-quality 5 -o "${audioPath}" "${url}"`,
    { timeout: 300000, stdio: "pipe" }
  );

  const mp3Files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".mp3"));
  if (mp3Files.length === 0) throw new Error("No audio file after download");
  let finalPath = path.join(tmpDir, mp3Files[0]);

  const stat = fs.statSync(finalPath);
  if (stat.size > 25 * 1024 * 1024) {
    const compressed = path.join(tmpDir, "compressed.mp3");
    execSync(`ffmpeg -i "${finalPath}" -b:a 64k -ar 16000 -y "${compressed}"`, {
      timeout: 300000,
      stdio: "pipe",
    });
    finalPath = compressed;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  // Use verbose_json to get segments with timestamps
  const result = execSync(
    `curl -s -X POST "https://api.openai.com/v1/audio/transcriptions" ` +
      `-H "Authorization: Bearer ${apiKey}" ` +
      `-F "file=@${finalPath}" ` +
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

  return {
    text: data.text || segments.map((s) => s.text).join(" "),
    segments,
  };
}

export function fetchTranscript(url: string, tmpDir: string): TranscriptResult {
  fs.mkdirSync(tmpDir, { recursive: true });

  const metadata = fetchMetadata(url);

  // Try subtitles first
  const subs = fetchSubtitles(url, tmpDir);
  if (subs && subs.text.length > 50) {
    metadata.transcript_source = "subtitle";
    return { metadata, transcript: subs.text, segments: subs.segments };
  }

  // Fallback to Whisper
  const whisper = transcribeWithWhisper(url, tmpDir);
  metadata.transcript_source = "whisper";
  return { metadata, transcript: whisper.text, segments: whisper.segments };
}
