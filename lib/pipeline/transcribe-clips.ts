import fs from "fs";
import path from "path";
import { getDb } from "@/lib/db";
import { run } from "./run-command";
import { transcribeAudio, probeDuration } from "./transcribe";
import type { TranscriptSegment } from "./fetch-transcript";

const VIDEO_EXTS = ["mp4", "mov", "webm", "avi", "mkv"];

/**
 * Extract audio from video file using ffmpeg.
 * Returns the path to the extracted mp3.
 */
async function extractAudio(videoPath: string, outputDir: string): Promise<string> {
  const audioPath = path.join(outputDir, "audio.mp3");
  await run(
    `ffmpeg -i "${videoPath}" -vn -b:a 128k -y "${audioPath}"`,
    { timeoutMs: 300000 }
  );
  return audioPath;
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
        audioPath = await extractAudio(clip.file_path, clipWorkDir);
      } else {
        audioPath = clip.file_path;
      }

      // Get duration
      const duration = await probeDuration(audioPath);
      const mins = Math.floor(duration / 60);
      const secs = Math.floor(duration % 60);

      // Transcribe(壓縮 / 25MB 切段在 transcribeAudio 內處理)
      // 混剪素材是允雷自己的中文口播,保留 language=zh
      const { text: transcript, segments: rawSegments, words: allWords } =
        await transcribeAudio(audioPath, {
          tmpDir: clipWorkDir,
          language: "zh",
          wordTimestamps: true,
        });

      const segments: EnrichedSegment[] = rawSegments.map((s) => {
        const segWords = allWords.filter(
          (w) => w.start >= s.start - 0.05 && w.end <= s.end + 0.05
        );
        return { ...s, words: segWords.length > 0 ? segWords : undefined };
      });

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
