import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { extractSummaryVerified } from "@/lib/pipeline/extract-summary";
import { renderCard } from "@/lib/pipeline/render-card";
import { translateSegments, translatePlainText } from "@/lib/pipeline/translate";
import { writeSubtitleFiles } from "@/lib/pipeline/burn-bilingual";
import { runVideoPipeline } from "@/lib/pipeline/run-video-pipeline";
import { transcribeAudio, probeDuration } from "@/lib/pipeline/transcribe";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const AUDIO_EXTS = ["mp3", "m4a", "wav", "ogg", "opus", "aac", "flac"];
const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "m4v", "avi"];

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const title = (formData.get("title") as string) || "Upload";

    if (!file) {
      return NextResponse.json({ error: "請上傳音訊或影片檔" }, { status: 400 });
    }

    const fileExt = file.name.split(".").pop()?.toLowerCase() || "";
    const isVideo = VIDEO_EXTS.includes(fileExt);
    const isAudio = AUDIO_EXTS.includes(fileExt);

    if (!isVideo && !isAudio) {
      return NextResponse.json(
        { error: `不支援的檔案格式。支援音訊: ${AUDIO_EXTS.join(", ")} 影片: ${VIDEO_EXTS.join(", ")}` },
        { status: 400 }
      );
    }

    const contentId = crypto.createHash("md5").update(file.name + file.size).digest("hex").slice(0, 12);
    const db = getDb();

    const existing = db
      .prepare("SELECT * FROM summaries WHERE video_id = ?")
      .get(contentId) as Record<string, unknown> | undefined;

    if (existing && existing.status === "done") {
      return NextResponse.json({ id: existing.id, status: "done" });
    }

    const id = (existing?.id as string) || crypto.randomUUID();
    if (!existing) {
      db.prepare(
        "INSERT INTO summaries (id, video_id, url, source, status, title, is_video) VALUES (?, ?, ?, ?, 'processing', ?, ?)"
      ).run(id, contentId, `upload://${file.name}`, isVideo ? "video" : "podcast", title, isVideo ? 1 : 0);
    } else {
      db.prepare(
        "UPDATE summaries SET status = 'processing', error = NULL, is_video = ?, source = ? WHERE id = ?"
      ).run(isVideo ? 1 : 0, isVideo ? "video" : "podcast", id);
    }

    const tmpDir = path.join(process.cwd(), "data", "tmp", contentId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const rawFileName = `${contentId}.${fileExt}`;
    const rawPath = path.join(tmpDir, rawFileName);
    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(rawPath, buffer);

    if (isAudio) {
      const publicAudioDir = path.join(process.cwd(), "public", "audio");
      fs.mkdirSync(publicAudioDir, { recursive: true });
      fs.copyFileSync(rawPath, path.join(publicAudioDir, rawFileName));
      db.prepare("UPDATE summaries SET audio_url = ? WHERE id = ?").run(`/audio/${rawFileName}`, id);

      runAudioPipeline(id, contentId, rawPath, title).catch((err) => {
        console.error("Audio pipeline error:", err);
        getDb().prepare("UPDATE summaries SET status = 'error', error = ? WHERE id = ?")
          .run(err.message?.slice(0, 500) || "Unknown error", id);
      });
    } else {
      const publicVideoDir = path.join(process.cwd(), "public", "videos");
      fs.mkdirSync(publicVideoDir, { recursive: true });
      fs.copyFileSync(rawPath, path.join(publicVideoDir, rawFileName));
      db.prepare("UPDATE summaries SET video_url = ? WHERE id = ?").run(`/videos/${rawFileName}`, id);

      runVideoPipeline({ id, contentId, videoPath: rawPath, title }).catch((err) => {
        console.error("Video pipeline error:", err);
        getDb().prepare("UPDATE summaries SET status = 'error', error = ? WHERE id = ?")
          .run(err.message?.slice(0, 500) || "Unknown error", id);
      });
    }

    return NextResponse.json({ id, status: "processing" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Audio-only pipeline (Podcast 模式):無 video,不寫 SRT/VTT,只做轉錄+翻譯+卡片。
 */
async function runAudioPipeline(id: string, contentId: string, audioPath: string, title: string) {
  const db = getDb();
  const tmpDir = path.dirname(audioPath);
  const cardDir = path.join(process.cwd(), "public", "cards", contentId);

  const duration = await probeDuration(audioPath);

  // 壓縮 / 25MB 切段 / 上傳都在 transcribeAudio 內處理(非阻塞,不再凍住 event loop)
  const { text: transcript, segments } = await transcribeAudio(audioPath, { tmpDir });

  const { translated: segmentsZh, wasTranslated } = await translateSegments(segments);
  const transcriptZh = wasTranslated ? translatePlainText(segmentsZh) : null;

  const mins = Math.floor(duration / 60);
  const secs = Math.floor(duration % 60);
  db.prepare(
    `UPDATE summaries SET title = ?, channel = 'Podcast', duration = ?, duration_display = ?,
     transcript_source = 'whisper', transcript = ?, segments = ?,
     transcript_zh = ?, segments_zh = ?, is_translated = ? WHERE id = ?`
  ).run(
    title, duration, `${mins}:${secs.toString().padStart(2, "0")}`,
    transcript, JSON.stringify(segments),
    transcriptZh, wasTranslated ? JSON.stringify(segmentsZh) : null,
    wasTranslated ? 1 : 0, id
  );

  // 即使是純 audio,也寫 SRT 給使用者下載(VLC/IINA 也能掛在自己錄的影片上)
  const burnDir = path.join(process.cwd(), "public", "burned", contentId);
  const srt = writeSubtitleFiles({
    segments,
    segmentsZh: wasTranslated ? segmentsZh : null,
    wasTranslated, outputDir: burnDir, contentId,
  });
  const toPublic = (p: string | null) =>
    p ? "/" + path.relative(path.join(process.cwd(), "public"), p).split(path.sep).join("/") : null;
  db.prepare(
    `UPDATE summaries SET srt_en_path = ?, srt_zh_path = ?, srt_bi_path = ? WHERE id = ?`
  ).run(toPublic(srt.srtEnPath), toPublic(srt.srtZhPath), toPublic(srt.srtBiPath), id);

  const segmentsForGpt = wasTranslated ? segmentsZh : segments;
  const timestamped = segmentsForGpt.length > 0
    ? segmentsForGpt.map((s) => {
        const m = Math.floor(s.start / 60);
        const sec = Math.floor(s.start % 60);
        return `[${m}:${sec.toString().padStart(2, "0")}] ${s.text}`;
      }).join("\n")
    : (transcriptZh || transcript);

  const summary = await extractSummaryVerified(timestamped, title, "Podcast", duration);

  const metadata = {
    video_id: contentId, title, channel: "Podcast",
    duration, duration_display: `${mins}:${secs.toString().padStart(2, "0")}`,
    upload_date: "", thumbnail_url: "", view_count: 0,
    transcript_source: "whisper" as const,
  };
  const slidePaths = await renderCard(summary, metadata, cardDir);
  const publicPaths = slidePaths.map((_, i) => `/cards/${contentId}/slide-${i + 1}.png`);

  db.prepare(
    `UPDATE summaries SET summary = ?, card_paths = ?, slide_count = ?, status = 'done' WHERE id = ?`
  ).run(JSON.stringify(summary), JSON.stringify(publicPaths), publicPaths.length, id);
}
