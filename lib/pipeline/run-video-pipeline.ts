/**
 * 共用 video pipeline:本機影片檔 → Whisper → 翻譯 → SRT/VTT → 摘要 → 卡片 → status=done
 *
 * 給 upload route(本機上傳)和 generate route(yt-dlp 下載 URL)共用。
 * 不包含燒字幕(那是 on-demand /burn endpoint 的責任)。
 */

import path from "path";
import { getDb } from "@/lib/db";
import { extractSummaryVerified } from "@/lib/pipeline/extract-summary";
import { renderCard } from "@/lib/pipeline/render-card";
import { translateSegments, translatePlainText } from "@/lib/pipeline/translate";
import { writeSubtitleFiles, extractAudioFromVideo } from "@/lib/pipeline/burn-bilingual";
import { transcribeAudio, probeDuration } from "@/lib/pipeline/transcribe";

export interface VideoPipelineInput {
  id: string;             // summaries.id (uuid)
  contentId: string;      // 12-char content hash,用作目錄/檔名
  videoPath: string;      // 本機影片檔絕對路徑
  title: string;
  channel?: string;
  duration?: number;
  thumbnailUrl?: string;
}

function pad(n: number) { return n.toString().padStart(2, "0"); }

export async function runVideoPipeline(input: VideoPipelineInput): Promise<void> {
  const db = getDb();
  const { id, contentId, videoPath, title } = input;

  const projectRoot = process.cwd();
  const tmpDir = path.dirname(videoPath);
  const cardDir = path.join(projectRoot, "public", "cards", contentId);

  // Step 1: 影片抽純音軌 mp3 給 Whisper(64k 16kHz mono,大幅縮小)
  const audioForWhisper = path.join(tmpDir, `${contentId}.audio.mp3`);
  await extractAudioFromVideo(videoPath, audioForWhisper);

  // Step 2: 取 duration(從原始 video,比 audio 更可靠)
  const duration = input.duration || (await probeDuration(videoPath));
  const durationDisplay = `${Math.floor(duration / 60)}:${pad(Math.floor(duration % 60))}`;

  // Step 3: Whisper transcription(壓縮 / 25MB 切段都在 transcribeAudio 內處理)
  const { text: transcript, segments } = await transcribeAudio(audioForWhisper, { tmpDir });

  // checkpoint: 轉錄完成(最貴的一步),重啟後可從這裡續跑,不重花 Whisper 錢
  db.prepare(
    `UPDATE summaries SET title = ?, channel = ?, duration = ?, duration_display = ?,
     thumbnail_url = ?, transcript_source = 'whisper', transcript = ?, segments = ?,
     pipeline_stage = 'transcribed' WHERE id = ?`
  ).run(
    title,
    input.channel || "Video",
    duration,
    durationDisplay,
    input.thumbnailUrl || "",
    transcript,
    JSON.stringify(segments),
    id
  );

  // Step 4: Translate (English → 繁中, 簡體 → 繁體)
  const { translated: segmentsZh, wasTranslated } = await translateSegments(segments);
  const transcriptZh = wasTranslated ? translatePlainText(segmentsZh) : null;

  db.prepare(
    `UPDATE summaries SET transcript_zh = ?, segments_zh = ?, is_translated = ? WHERE id = ?`
  ).run(
    transcriptZh,
    wasTranslated ? JSON.stringify(segmentsZh) : null,
    wasTranslated ? 1 : 0,
    id
  );

  // Step 5: 寫 SRT/VTT 三檔(主 pipeline 不燒,燒是 on-demand)
  const burnDir = path.join(projectRoot, "public", "burned", contentId);
  const srt = writeSubtitleFiles({
    segments,
    segmentsZh: wasTranslated ? segmentsZh : null,
    wasTranslated,
    outputDir: burnDir,
    contentId,
  });
  const toPublic = (p: string | null) =>
    p ? "/" + path.relative(path.join(projectRoot, "public"), p).split(path.sep).join("/") : null;
  db.prepare(
    `UPDATE summaries SET srt_en_path = ?, srt_zh_path = ?, srt_bi_path = ?, pipeline_stage = 'translated' WHERE id = ?`
  ).run(toPublic(srt.srtEnPath), toPublic(srt.srtZhPath), toPublic(srt.srtBiPath), id);

  // Step 6: Summary
  const segmentsForGpt = wasTranslated ? segmentsZh : segments;
  const timestamped = segmentsForGpt.length > 0
    ? segmentsForGpt.map((s) => {
        const m = Math.floor(s.start / 60);
        const sec = Math.floor(s.start % 60);
        return `[${m}:${pad(sec)}] ${s.text}`;
      }).join("\n")
    : (transcriptZh || transcript);

  const summary = await extractSummaryVerified(timestamped, title, input.channel || "Video", duration);
  db.prepare(`UPDATE summaries SET summary = ?, pipeline_stage = 'summarized' WHERE id = ?`)
    .run(JSON.stringify(summary), id);

  // Step 7: Render carousel
  const metadata = {
    video_id: contentId,
    title,
    channel: input.channel || "Video",
    duration,
    duration_display: durationDisplay,
    upload_date: "",
    thumbnail_url: input.thumbnailUrl || "",
    view_count: 0,
    transcript_source: "whisper" as const,
  };

  const slidePaths = await renderCard(summary, metadata, cardDir);
  const publicPaths = slidePaths.map((_, i) => `/cards/${contentId}/slide-${i + 1}.png`);

  db.prepare(
    `UPDATE summaries SET card_paths = ?, slide_count = ?, status = 'done', pipeline_stage = 'done' WHERE id = ?`
  ).run(JSON.stringify(publicPaths), publicPaths.length, id);
}
