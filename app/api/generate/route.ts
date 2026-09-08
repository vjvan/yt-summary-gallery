import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { fetchTranscript } from "@/lib/pipeline/fetch-transcript";
import { fetchPodcast } from "@/lib/pipeline/fetch-podcast";
import { fetchVideoFromUrl } from "@/lib/pipeline/fetch-video-url";
import { loadCaptions, pickCaptionTrack, probeMedia } from "@/lib/pipeline/media-captions";
import { detectSource, extractId } from "@/lib/pipeline/detect-source";
import { extractSummaryVerified } from "@/lib/pipeline/extract-summary";
import { renderCard } from "@/lib/pipeline/render-card";
import { translateSegments, translatePlainText } from "@/lib/pipeline/translate";
import { writeSubtitleFiles } from "@/lib/pipeline/burn-bilingual";
import { runVideoPipeline } from "@/lib/pipeline/run-video-pipeline";
import type { TranscriptResult } from "@/lib/pipeline/fetch-transcript";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { processingMode } from "@/lib/watch/provider";
import { canonicalYouTubeUrl } from "@/lib/watch/source";
import { assertPairingRequest } from "@/lib/watch/security";
import { ensureLibrarySubtitleColumns, libraryJobActive, libraryCardsReady, startLocalYoutubeLibrary } from "@/lib/pipeline/local-youtube-library";

export async function POST(req: NextRequest) {
  try {
    const { url } = await req.json();
    if (typeof url !== "string" || !url.trim() || url.length > 2048) {
      return NextResponse.json({ error: "URL is required" }, { status: 400 });
    }

    const source = detectSource(url);
    let contentId: string;
    try {
      contentId = source === "youtube" ? canonicalYouTubeUrl(url).videoId : extractId(url, source);
    } catch {
      return NextResponse.json({ error: "無法解析此連結" }, { status: 400 });
    }

    const db = getDb();
    if (source === "youtube") ensureLibrarySubtitleColumns();

    const existing = db
      .prepare("SELECT * FROM summaries WHERE video_id = ?")
      .get(contentId) as Record<string, unknown> | undefined;

    if (source === "youtube" && (processingMode() === "local" || existing?.subtitle_status)) {
      assertPairingRequest(req);
      if (processingMode() !== "local") return NextResponse.json({ error: "此影片是本機摘要/字幕工作；請切回本機模式後續作，不會自動改送雲端。" }, { status: 409 });
      const id = (existing?.id as string) || crypto.randomUUID();
      if (existing?.status === "done" && existing.subtitle_status === "complete" && libraryCardsReady(existing.card_paths)) return NextResponse.json({ id, status: "done", subtitle_status: "complete" });
      if (!existing) db.prepare("INSERT INTO summaries (id, video_id, url, source, status) VALUES (?, ?, ?, 'youtube', 'processing')").run(id, contentId, canonicalYouTubeUrl(url).url);
      else if (!libraryJobActive(id)) db.prepare("UPDATE summaries SET status=?, error=NULL WHERE id=?").run(existing.summary ? 'done' : 'processing', id);
      void startLocalYoutubeLibrary(id, canonicalYouTubeUrl(url).url);
      return NextResponse.json({ id, status: existing?.summary ? "done" : "processing", subtitle_status: existing?.subtitle_status === "complete" ? "complete" : "processing", card_status: libraryCardsReady(existing?.card_paths) ? "complete" : "processing", processingMode: "local" }, { status: 202 });
    }

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
        "UPDATE summaries SET status = 'processing', error = NULL, pipeline_stage = NULL, source = ?, is_video = ? WHERE id = ?"
      ).run(source, isVideo, id);
    }

    if (source === "video-url") {
      runVideoUrlPipeline(id, url, contentId).catch(() => {
        console.error("Video URL pipeline failed; retry through the library UI.");
        getDb().prepare("UPDATE summaries SET status = 'error', error = ? WHERE id = ?")
          .run("處理尚未完成。請確認字幕來源/本機服務或目前設定的模型可用後重試；成功的中間結果會保留。", id);
      });
    } else {
      runYoutubeOrPodcastPipeline(id, url, contentId, source).catch(() => {
        console.error("Pipeline failed; retry through the library UI.");
        getDb().prepare("UPDATE summaries SET status = 'error', error = ? WHERE id = ?")
          .run("處理尚未完成。請確認字幕來源/本機服務或目前設定的模型可用後重試；成功的中間結果會保留。", id);
      });
    }

    return NextResponse.json({ id, status: "processing" });
  } catch {
    const message = "處理尚未完成。請確認字幕來源/本機服務或目前設定的模型可用後重試；成功的中間結果會保留。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * 任意網頁影片 URL → yt-dlp 下載 → 走 video pipeline
 */
async function runVideoUrlPipeline(id: string, url: string, contentId: string) {
  const db = getDb();
  const projectRoot = process.cwd();
  const tmpDir = path.join(projectRoot, "data", "tmp", contentId);

  // 先問這支影片有沒有自帶字幕(X/Vimeo/Bilibili 很多都有)。有就只抓那個字幕檔,
  // 整支影片不下載也不聽打:實測一支 56 分鐘的 X podcast 因此從 4.3 GB 加十幾分鐘聽打,變成幾百 KB 加零推論。
  // 探測失敗(私人影片、需要登入、站點改版)就照舊走下載加 Whisper。
  const probe = await probeMedia(url).catch(() => null);
  const track = probe ? pickCaptionTrack(probe) : null;
  const captions = probe && track ? await loadCaptions(url, track, contentId, tmpDir).catch(() => null) : null;

  if (probe && captions) {
    const durationDisplay = probe.duration ? `${Math.floor(probe.duration / 60)}:${String(Math.floor(probe.duration % 60)).padStart(2, "0")}` : "";
    // 沒有本機影片檔:video_url 留 null(播放器那格會顯示「沒有下載原片」而不是空播放器),
    // is_video 保持 1,字幕下載與逐字稿入口照常。前一次若已下載過原片且檔案還在,保留那個引用不要變孤兒。
    const existingVideo = db.prepare("SELECT video_url FROM summaries WHERE id = ?").get(id) as { video_url: string | null } | undefined;
    const keepVideo = existingVideo?.video_url && fs.existsSync(path.join(projectRoot, "public", existingVideo.video_url.replace(/^\//, "")))
      ? existingVideo.video_url : null;
    db.prepare(
      "UPDATE summaries SET is_video = 1, video_url = ?, title = ?, channel = ?, thumbnail_url = ?, duration = ?, duration_display = ? WHERE id = ?"
    ).run(keepVideo, probe.title, probe.channel, probe.thumbnailUrl, probe.duration, durationDisplay, id);
    await runVideoPipeline({
      id, contentId, videoPath: null, tmpDir, captions,
      title: probe.title, channel: probe.channel, duration: probe.duration, thumbnailUrl: probe.thumbnailUrl,
    });
    return;
  }

  const meta = await fetchVideoFromUrl(url, contentId, projectRoot);

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
    result = await fetchTranscript(url, tmpDir);
  } else {
    result = await fetchPodcast(url, tmpDir);
  }
  const { metadata, transcript, segments } = result;

  // checkpoint: 轉錄/字幕取得完成(最貴的一步),重啟後可從這裡續跑
  const audioUrl = source === "podcast" && /\.(mp3|m4a|wav|ogg)/i.test(url) ? url : null;
  db.prepare(
    `UPDATE summaries SET title = ?, channel = ?, duration = ?, duration_display = ?,
     thumbnail_url = ?, transcript_source = ?, transcript = ?, segments = ?,
     source = ?, audio_url = ?, pipeline_stage = 'transcribed' WHERE id = ?`
  ).run(
    metadata.title, metadata.channel, metadata.duration, metadata.duration_display,
    metadata.thumbnail_url, metadata.transcript_source,
    transcript, JSON.stringify(segments), source, audioUrl, id
  );

  const { translated: segmentsZh, wasTranslated } = await translateSegments(segments);
  const transcriptZh = wasTranslated ? translatePlainText(segmentsZh) : null;

  db.prepare(
    `UPDATE summaries SET transcript_zh = ?, segments_zh = ?, is_translated = ? WHERE id = ?`
  ).run(
    transcriptZh, wasTranslated ? JSON.stringify(segmentsZh) : null,
    wasTranslated ? 1 : 0, id
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
  db.prepare(`UPDATE summaries SET pipeline_stage = 'translated' WHERE id = ?`).run(id);

  const segmentsForGpt = wasTranslated ? segmentsZh : segments;
  const timestampedTranscript = segmentsForGpt.length > 0
    ? segmentsForGpt.map((s) => {
        const m = Math.floor(s.start / 60);
        const sec = Math.floor(s.start % 60);
        return `[${m}:${sec.toString().padStart(2, "0")}] ${s.text}`;
      }).join("\n")
    : (transcriptZh || transcript);

  const summary = await extractSummaryVerified(
    timestampedTranscript, metadata.title, metadata.channel, metadata.duration
  );
  db.prepare(`UPDATE summaries SET summary = ?, pipeline_stage = 'summarized' WHERE id = ?`)
    .run(JSON.stringify(summary), id);

  const slidePaths = await renderCard(summary, metadata, cardDir);
  const publicPaths = slidePaths.map((_, i) => `/cards/${contentId}/slide-${i + 1}.png`);

  db.prepare(
    `UPDATE summaries SET card_paths = ?, slide_count = ?, status = 'done', pipeline_stage = 'done' WHERE id = ?`
  ).run(JSON.stringify(publicPaths), publicPaths.length, id);
}
