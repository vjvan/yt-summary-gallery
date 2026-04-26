import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { getDb } from "@/lib/db";
import type { TranscriptSegment } from "./fetch-transcript";

const VIDEO_EXTS = ["mp4", "mov", "webm", "avi", "mkv"];

/**
 * Extract audio from video file using ffmpeg.
 * Returns the path to the extracted mp3.
 */
function extractAudio(videoPath: string, outputDir: string): string {
  const audioPath = path.join(outputDir, "audio.mp3");
  execSync(
    `ffmpeg -i "${videoPath}" -vn -b:a 128k -y "${audioPath}"`,
    { timeout: 300000, stdio: "pipe" }
  );
  return audioPath;
}

/**
 * Compress audio if over 25MB for Whisper API limit.
 */
function compressIfNeeded(audioPath: string, outputDir: string): string {
  const stat = fs.statSync(audioPath);
  if (stat.size <= 25 * 1024 * 1024) return audioPath;

  const compressed = path.join(outputDir, "compressed.mp3");
  execSync(
    `ffmpeg -i "${audioPath}" -b:a 64k -ar 16000 -y "${compressed}"`,
    { timeout: 300000, stdio: "pipe" }
  );
  return compressed;
}

/**
 * Get duration in seconds via ffprobe.
 */
function getDuration(filePath: string): number {
  try {
    const probe = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    return parseFloat(probe) || 0;
  } catch {
    return 0;
  }
}

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface EnrichedSegment extends TranscriptSegment {
  words?: WordTimestamp[];
}

/**
 * Transcribe audio using OpenAI Whisper API with word-level timestamps.
 */
function whisperTranscribe(audioPath: string): {
  transcript: string;
  segments: EnrichedSegment[];
} {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const result = execSync(
    `curl -s -X POST "https://api.openai.com/v1/audio/transcriptions" ` +
      `-H "Authorization: Bearer ${apiKey}" ` +
      `-F "file=@${audioPath}" ` +
      `-F "model=whisper-1" ` +
      `-F "language=zh" ` +
      `-F "response_format=verbose_json" ` +
      `-F "timestamp_granularities[]=word" ` +
      `-F "timestamp_granularities[]=segment" ` +
      `--max-time 600`,
    { encoding: "utf-8", timeout: 620000 }
  );

  const data = JSON.parse(result);
  const allWords: WordTimestamp[] = (data.words || []).map(
    (w: { word: string; start: number; end: number }) => ({
      word: w.word.trim(),
      start: w.start,
      end: w.end,
    })
  );

  const segments: EnrichedSegment[] = (data.segments || []).map(
    (s: { start: number; end: number; text: string }) => {
      const segWords = allWords.filter(
        (w) => w.start >= s.start - 0.05 && w.end <= s.end + 0.05
      );
      return {
        start: s.start,
        end: s.end,
        text: s.text.trim(),
        words: segWords.length > 0 ? segWords : undefined,
      };
    }
  );

  const transcript =
    data.text || segments.map((s) => s.text).join(" ");

  return { transcript, segments };
}

/**
 * Transcribe all clips in a project sequentially.
 * Updates each clip's status in the database as it goes.
 */
export async function transcribeClips(projectId: string): Promise<void> {
  const db = getDb();
  const clips = db
    .prepare(
      "SELECT * FROM project_clips WHERE project_id = ? ORDER BY sort_order"
    )
    .all(projectId) as Array<{
    id: string;
    file_name: string;
    file_path: string;
    sort_order: number;
  }>;

  for (const clip of clips) {
    try {
      db.prepare(
        "UPDATE project_clips SET status = 'transcribing' WHERE id = ?"
      ).run(clip.id);

      const clipDir = path.dirname(clip.file_path);
      const clipWorkDir = path.join(clipDir, `clip-${clip.sort_order}`);
      fs.mkdirSync(clipWorkDir, { recursive: true });

      // Determine if video or audio
      const ext = clip.file_name.split(".").pop()?.toLowerCase() || "";
      let audioPath: string;

      if (VIDEO_EXTS.includes(ext)) {
        audioPath = extractAudio(clip.file_path, clipWorkDir);
      } else {
        audioPath = clip.file_path;
      }

      // Get duration
      const duration = getDuration(audioPath);
      const mins = Math.floor(duration / 60);
      const secs = Math.floor(duration % 60);

      // Compress if needed
      const finalPath = compressIfNeeded(audioPath, clipWorkDir);

      // Transcribe
      const { transcript, segments } = whisperTranscribe(finalPath);

      db.prepare(
        `UPDATE project_clips SET
          status = 'done',
          duration = ?,
          duration_display = ?,
          transcript = ?,
          segments = ?
        WHERE id = ?`
      ).run(
        duration,
        `${mins}:${secs.toString().padStart(2, "0")}`,
        transcript,
        JSON.stringify(segments),
        clip.id
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message.slice(0, 500) : "Unknown error";
      db.prepare(
        "UPDATE project_clips SET status = 'error', error = ? WHERE id = ?"
      ).run(message, clip.id);
    }
  }
}
