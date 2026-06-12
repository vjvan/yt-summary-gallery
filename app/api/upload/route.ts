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
import { Readable } from "stream";
import { pipeline as streamPipeline } from "stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "stream/web";

const AUDIO_EXTS = ["mp3", "m4a", "wav", "ogg", "opus", "aac", "flac"];
const VIDEO_EXTS = ["mp4", "mov", "mkv", "webm", "m4v", "avi"];

function defaultTitle(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ") || "Upload";
}

function validateExt(fileName: string): NextResponse | null {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (AUDIO_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)) return null;
  return NextResponse.json(
    { error: `不支援的檔案格式。支援音訊: ${AUDIO_EXTS.join(", ")} 影片: ${VIDEO_EXTS.join(", ")}` },
    { status: 400 }
  );
}

function stagingPath(): string {
  const dir = path.join(process.cwd(), "data", "tmp");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `incoming-${crypto.randomUUID()}`);
}

export async function POST(req: NextRequest) {
  // 串流暫存檔:還沒算出 contentId 前先落地到這裡,結束後 rename 進正式位置
  let stagedPath: string | null = null;

  try {
    const contentType = req.headers.get("content-type") || "";
    let fileName: string;
    let title: string;

    if (contentType.includes("multipart/form-data")) {
      // 相容路徑(小檔 / curl -F)。大檔走下面的串流路徑:
      // req.formData() 會把整個 body 讀進記憶體解析,GB 級影片會直接炸
      // "Failed to parse body as FormData"。
      const formData = await req.formData();
      const file = formData.get("file") as File | null;
      if (!file) {
        return NextResponse.json({ error: "請上傳音訊或影片檔" }, { status: 400 });
      }
      fileName = file.name;
      title = (formData.get("title") as string) || defaultTitle(fileName);

      const extErr = validateExt(fileName);
      if (extErr) return extErr;

      stagedPath = stagingPath();
      fs.writeFileSync(stagedPath, Buffer.from(await file.arrayBuffer()));
    } else {
      // 串流路徑(前端預設):POST body 直接是檔案內容,邊收邊寫盤,
      // 記憶體用量恆定,2.8GB 的 4K 錄影也能直接拖進來。
      fileName = decodeURIComponent(req.nextUrl.searchParams.get("filename") || "");
      if (!fileName) {
        return NextResponse.json({ error: "串流上傳需帶 ?filename= 參數" }, { status: 400 });
      }
      title = req.nextUrl.searchParams.get("title") || defaultTitle(fileName);

      const extErr = validateExt(fileName);
      if (extErr) return extErr;

      if (!req.body) {
        return NextResponse.json({ error: "沒有收到檔案內容" }, { status: 400 });
      }
      stagedPath = stagingPath();
      await streamPipeline(
        Readable.fromWeb(req.body as unknown as NodeWebReadableStream),
        fs.createWriteStream(stagedPath)
      );
    }

    const fileExt = fileName.split(".").pop()?.toLowerCase() || "";
    const isVideo = VIDEO_EXTS.includes(fileExt);
    const fileSize = fs.statSync(stagedPath).size;
    if (fileSize < 1000) {
      return NextResponse.json({ error: "檔案內容是空的或不完整" }, { status: 400 });
    }

    // 與舊版一致: md5(檔名 + 檔案大小),同檔重傳會去重
    const contentId = crypto.createHash("md5").update(fileName + fileSize).digest("hex").slice(0, 12);
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
      ).run(id, contentId, `upload://${fileName}`, isVideo ? "video" : "podcast", title, isVideo ? 1 : 0);
    } else {
      db.prepare(
        "UPDATE summaries SET status = 'processing', error = NULL, pipeline_stage = NULL, is_video = ?, source = ? WHERE id = ?"
      ).run(isVideo ? 1 : 0, isVideo ? "video" : "podcast", id);
    }

    const tmpDir = path.join(process.cwd(), "data", "tmp", contentId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const rawFileName = `${contentId}.${fileExt}`;
    const rawPath = path.join(tmpDir, rawFileName);
    fs.renameSync(stagedPath, rawPath);
    stagedPath = null; // 已就位,catch/finally 不用再清

    const isAudio = AUDIO_EXTS.includes(fileExt);

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
  } finally {
    // 早退(400/去重)或出錯時清掉串流暫存檔;成功路徑已 rename 並把 stagedPath 設 null
    if (stagedPath && fs.existsSync(stagedPath)) {
      try { fs.unlinkSync(stagedPath); } catch { /* ignore */ }
    }
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

  // checkpoint: 轉錄完成(最貴的一步),重啟後可從這裡續跑,不重花 Whisper 錢
  const mins = Math.floor(duration / 60);
  const secs = Math.floor(duration % 60);
  db.prepare(
    `UPDATE summaries SET title = ?, channel = 'Podcast', duration = ?, duration_display = ?,
     transcript_source = 'whisper', transcript = ?, segments = ?, pipeline_stage = 'transcribed' WHERE id = ?`
  ).run(
    title, duration, `${mins}:${secs.toString().padStart(2, "0")}`,
    transcript, JSON.stringify(segments), id
  );

  const { translated: segmentsZh, wasTranslated } = await translateSegments(segments);
  const transcriptZh = wasTranslated ? translatePlainText(segmentsZh) : null;

  db.prepare(
    `UPDATE summaries SET transcript_zh = ?, segments_zh = ?, is_translated = ? WHERE id = ?`
  ).run(
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
    `UPDATE summaries SET srt_en_path = ?, srt_zh_path = ?, srt_bi_path = ?, pipeline_stage = 'translated' WHERE id = ?`
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
  db.prepare(`UPDATE summaries SET summary = ?, pipeline_stage = 'summarized' WHERE id = ?`)
    .run(JSON.stringify(summary), id);

  const metadata = {
    video_id: contentId, title, channel: "Podcast",
    duration, duration_display: `${mins}:${secs.toString().padStart(2, "0")}`,
    upload_date: "", thumbnail_url: "", view_count: 0,
    transcript_source: "whisper" as const,
  };
  const slidePaths = await renderCard(summary, metadata, cardDir);
  const publicPaths = slidePaths.map((_, i) => `/cards/${contentId}/slide-${i + 1}.png`);

  db.prepare(
    `UPDATE summaries SET card_paths = ?, slide_count = ?, status = 'done', pipeline_stage = 'done' WHERE id = ?`
  ).run(JSON.stringify(publicPaths), publicPaths.length, id);
}
