import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { fetchTranscript } from "@/lib/pipeline/fetch-transcript";
import { fetchPodcast } from "@/lib/pipeline/fetch-podcast";
import { fetchVideoFromUrl } from "@/lib/pipeline/fetch-video-url";
import { detectSource, extractId } from "@/lib/pipeline/detect-source";
import { extractSummary } from "@/lib/pipeline/extract-summary";
import { renderCard } from "@/lib/pipeline/render-card";
import { translateSegments, translatePlainText } from "@/lib/pipeline/translate";
import { writeSubtitleFiles } from "@/lib/pipeline/burn-bilingual";
import { runVideoPipeline } from "@/lib/pipeline/run-video-pipeline";
import type { TranscriptResult } from "@/lib/pipeline/fetch-transcript";
import path from "path";
import crypto from "crypto";

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (!url) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    const source = detectSource(url);
    let contentId: string;
    try {
      contentId = extractId(url, source);
    } catch {
      return NextResponse.json({ error: "無法解析此連結" }, { status: 400 });
    }

    const db = getDb();

    const existing = db
      .prepare("SELECT * FROM summaries WHERE video_id = ?")
      .get(contentId) as Record<string, unknown> | undefined;

    if (existing && existing.status === "done") {
      return NextResponse.json({ id: existing.id, status: "done" });
    }

    const id = (existing?.id as string) || crypto.randomUUID();
    const isVideo = source === "video-url" ? 1 : 0;
    if (!existing) {
      db.prepare(
        "INSERT INTO summaries (id, video_id, url, source, status, is_video) VALUES (?, ?, ?, ?, 'processing', ?)"
      ).run(id, contentId, url, source, isVideo);
    } else {
      db.prepare(
        "UPDATE summaries SET status = 'processing', error = NULL, source = ?, is_video = ? WHERE id = ?"
      ).run(source, isVideo, id);
    }

    if (source === "video-url") {
      runVideoUrlPipeline(id, url, contentId).catch((err) => {
        console.error("Video URL pipeline error:", err);
        getDb().prepare("UPDATE summaries SET status = 'error', error = ? WHERE id = ?")
          .run(err.message?.slice(0, 500) || "Unknown error", id);
      });
    } else {
      runYoutubeOrPodcastPipeline(id, url, contentId, source).catch((err) => {
        console.error("Pipeline error:", err);
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
 * 任意網頁影片 URL → yt-dlp 下載 → 走 video pipeline
 */
async function runVideoUrlPipeline(id: string, url: string, contentId: string) {
  const db = getDb();
  const projectRoot = process.cwd();

  const meta = fetchVideoFromUrl(url, contentId, projectRoot);

  // 立刻把 video_url 寫進 DB,讓前端 player 可預覽(即使字幕還沒好)
  db.prepare(
    "UPDATE summaries SET video_url = ?, title = ?, channel = ?, thumbnail_url = ?, duration = ?, duration_display = ? WHERE id = ?"
  ).run(meta.publicVideoUrl, meta.title, meta.channel, meta.thumbnailUrl, meta.duration, meta.durationDisplay, id);

  await runVideoPipeline({
    id, contentId,
    videoPath: meta.videoPath,
    title: meta.title,
    channel: meta.channel,
    duration: meta.duration,
    thumbnailUrl: meta.thumbnailUrl,
  });
}

/**
 * YouTube (transcript path) 或 Podcast 純音訊 URL
 */
async function runYoutubeOrPodcastPipeline(id: string, url: string, contentId: string, source: string) {
  const db = getDb();
  const tmpDir = path.join(process.cwd(), "data", "tmp", contentId);
  const cardDir = path.join(process.cwd(), "public", "cards", contentId);

  let result: TranscriptResult;
  if (source === "youtube") {
    result = fetchTranscript(url, tmpDir);
  } else {
    result = fetchPodcast(url, tmpDir);
  }
  const { metadata, transcript, segments } = result;

  const { translated: segmentsZh, wasTranslated } = await translateSegments(segments);
  const transcriptZh = wasTranslated ? translatePlainText(segmentsZh) : null;

  const audioUrl = source === "podcast" && /\.(mp3|m4a|wav|ogg)/i.test(url) ? url : null;

  db.prepare(
    `UPDATE summaries SET title = ?, channel = ?, duration = ?, duration_display = ?,
     thumbnail_url = ?, transcript_source = ?, transcript = ?, segments = ?,
     transcript_zh = ?, segments_zh = ?, is_translated = ?, source = ?, audio_url = ? WHERE id = ?`
  ).run(
    metadata.title, metadata.channel, metadata.duration, metadata.duration_display,
    metadata.thumbnail_url, metadata.transcript_source,
    transcript, JSON.stringify(segments),
    transcriptZh, wasTranslated ? JSON.stringify(segmentsZh) : null,
    wasTranslated ? 1 : 0, source, audioUrl, id
  );

  // YouTube / podcast 有 segments 也順手寫 SRT/VTT(下載到本機掛字幕用)
  if (segments.length > 0) {
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
  }

  const segmentsForGpt = wasTranslated ? segmentsZh : segments;
  const timestampedTranscript = segmentsForGpt.length > 0
    ? segmentsForGpt.map((s) => {
        const m = Math.floor(s.start / 60);
        const sec = Math.floor(s.start % 60);
        return `[${m}:${sec.toString().padStart(2, "0")}] ${s.text}`;
      }).join("\n")
    : (transcriptZh || transcript);

  const summary = await extractSummary(timestampedTranscript, metadata.title, metadata.channel);

  const slidePaths = await renderCard(summary, metadata, cardDir);
  const publicPaths = slidePaths.map((_, i) => `/cards/${contentId}/slide-${i + 1}.png`);

  db.prepare(
    `UPDATE summaries SET summary = ?, card_paths = ?, slide_count = ?, status = 'done' WHERE id = ?`
  ).run(JSON.stringify(summary), JSON.stringify(publicPaths), publicPaths.length, id);
}
