/**
 * Jobs 持久化:server 重啟後的殭屍任務回收與斷點續跑。
 *
 * 背景任務是裸 async(無佇列),重啟前卡在 processing/burning 的任務
 * 以前會永遠卡死。現在 pipeline 各階段完成時會寫 pipeline_stage checkpoint
 * (中間產物本來就存 summaries 表),開機時由 instrumentation.ts 呼叫
 * recoverZombieJobs():
 *
 *  - stage 'transcribed' / 'translated' / 'summarized' → 從斷點續跑
 *    (只重跑後面的便宜步驟,不重花 Whisper 轉錄錢)
 *  - stage NULL(轉錄沒跑完)→ 標記 error,使用者重新提交即可
 *    (重提交走原本的 retry 路徑,video_id 去重會重用同一筆 row)
 *  - burn_status 'burning' → 標記 error(燒錄是 on-demand,重按一次就好)
 *  - remix 的 projects/clips 過渡狀態 → 標記 error(多段組合任務不值得續跑)
 */

import path from "path";
import { getDb, SummaryRow } from "@/lib/db";
import { translateSegments, translatePlainText } from "./translate";
import { writeSubtitleFiles } from "./burn-bilingual";
import {
  extractSummaryVerified,
  ensureSummaryShape,
  type Summary,
} from "./extract-summary";
import { renderCard } from "./render-card";
import { maybeAutoBurn } from "./start-burn";
import type { TranscriptSegment, VideoMetadata } from "./fetch-transcript";
import { resolveCardStyle } from "../card-style";
import { recoverLocalLibraryJobs } from "./local-youtube-library";

const RESUMABLE_STAGES = new Set(["transcribed", "translated", "summarized"]);

function parseSegments(json: string | null): TranscriptSegment[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toTimestamped(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => {
      const m = Math.floor(s.start / 60);
      const sec = Math.floor(s.start % 60);
      return `[${m}:${sec.toString().padStart(2, "0")}] ${s.text}`;
    })
    .join("\n");
}

/**
 * 從 pipeline_stage 斷點續跑一筆 summaries。
 * 各 pipeline 的尾段(翻譯 → SRT → 摘要 → 卡片)所需資料都已在 DB row 內,
 * 所以這裡可以用同一套通用實作收尾,不分 youtube/podcast/upload。
 */
export async function resumeSummaryPipeline(rowId: string): Promise<void> {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ?")
    .get(rowId) as SummaryRow | undefined;
  if (!row || row.status !== "processing") return;

  let stage = row.pipeline_stage || "";
  if (!RESUMABLE_STAGES.has(stage)) {
    throw new Error(`stage '${stage}' 不可續跑`);
  }

  const projectRoot = process.cwd();
  const contentId = row.video_id;
  const segments = parseSegments(row.segments);
  let segmentsZh = parseSegments(row.segments_zh);
  let wasTranslated = !!row.is_translated;
  let transcriptZh = row.transcript_zh;

  // === stage 'transcribed' → 翻譯 + SRT ===
  if (stage === "transcribed") {
    const t = await translateSegments(segments);
    segmentsZh = t.translated;
    wasTranslated = t.wasTranslated;
    transcriptZh = wasTranslated ? translatePlainText(segmentsZh) : null;
    db.prepare(
      `UPDATE summaries SET transcript_zh = ?, segments_zh = ?, is_translated = ? WHERE id = ?`
    ).run(
      transcriptZh,
      wasTranslated ? JSON.stringify(segmentsZh) : null,
      wasTranslated ? 1 : 0,
      row.id
    );

    if (segments.length > 0) {
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
        `UPDATE summaries SET srt_en_path = ?, srt_zh_path = ?, srt_bi_path = ? WHERE id = ?`
      ).run(toPublic(srt.srtEnPath), toPublic(srt.srtZhPath), toPublic(srt.srtBiPath), row.id);
    }
    db.prepare(`UPDATE summaries SET pipeline_stage = 'translated' WHERE id = ?`).run(row.id);
    stage = "translated";
  }

  // === stage 'translated' → 摘要 ===
  let summary: Summary;
  if (stage === "translated") {
    const segmentsForGpt = wasTranslated && segmentsZh.length > 0 ? segmentsZh : segments;
    const timestamped =
      segmentsForGpt.length > 0
        ? toTimestamped(segmentsForGpt)
        : transcriptZh || row.transcript || "";
    if (!timestamped) throw new Error("無逐字稿可生成摘要");

    summary = await extractSummaryVerified(
      timestamped,
      row.title || "",
      row.channel || "",
      row.duration || 0
    );
    db.prepare(
      `UPDATE summaries SET summary = ?, pipeline_stage = 'summarized' WHERE id = ?`
    ).run(JSON.stringify(summary), row.id);
  } else {
    if (!row.summary) throw new Error("stage 'summarized' 但 summary 欄位是空的");
    summary = ensureSummaryShape(JSON.parse(row.summary) as Partial<Summary>);
  }

  // === stage 'summarized' → 卡片 ===
  const metadata: VideoMetadata = {
    video_id: contentId,
    title: row.title || "",
    channel: row.channel || "",
    duration: row.duration || 0,
    duration_display: row.duration_display || "",
    upload_date: "",
    thumbnail_url: row.thumbnail_url || "",
    view_count: 0,
    transcript_source: row.transcript_source || "whisper",
  };
  const cardDir = path.join(projectRoot, "public", "cards", contentId);
  const slidePaths = await renderCard(summary, metadata, cardDir, resolveCardStyle(row.card_style));
  const publicPaths = slidePaths.map((_, i) => `/cards/${contentId}/slide-${i + 1}.png`);

  db.prepare(
    `UPDATE summaries SET card_paths = ?, slide_count = ?, status = 'done', pipeline_stage = 'done' WHERE id = ?`
  ).run(JSON.stringify(publicPaths), publicPaths.length, row.id);

  // 上傳時若勾了「完成後自動燒錄」,續跑完成也要兌現
  maybeAutoBurn(row.id);
}

/**
 * 開機殭屍任務回收。同步標記不可續跑的,可續跑的丟到背景依序跑
 * (register() 必須在 server 開始服務前完成,所以續跑不能 await)。
 */
export function recoverZombieJobs(): void {
  recoverLocalLibraryJobs();
  const db = getDb();

  const processing = db
    .prepare("SELECT id, title, pipeline_stage FROM summaries WHERE status = 'processing'")
    .all() as Array<{ id: string; title: string | null; pipeline_stage: string | null }>;

  const toResume = processing.filter((r) => RESUMABLE_STAGES.has(r.pipeline_stage || ""));
  const toFail = processing.filter((r) => !RESUMABLE_STAGES.has(r.pipeline_stage || ""));

  for (const r of toFail) {
    db.prepare("UPDATE summaries SET status = 'error', error = ? WHERE id = ?").run(
      "伺服器重啟導致任務中斷(轉錄尚未完成),請重新提交同一個檔案或連結即可重跑",
      r.id
    );
  }

  const burnReset = db
    .prepare(
      "UPDATE summaries SET burn_status = 'error', burn_error = '伺服器重啟中斷,請重新觸發燒錄' WHERE burn_status = 'burning'"
    )
    .run().changes;

  const clipReset = db
    .prepare(
      "UPDATE project_clips SET status = 'error', error = '伺服器重啟中斷,請重新轉錄' WHERE status = 'transcribing'"
    )
    .run().changes;

  const projectReset = db
    .prepare(
      "UPDATE projects SET status = 'error', error = '伺服器重啟中斷,請重新生成' WHERE status IN ('processing', 'transcribing')"
    )
    .run().changes;

  if (toFail.length || burnReset || clipReset || projectReset) {
    console.log(
      `[recover] 標記中斷任務: summaries=${toFail.length} burn=${burnReset} clips=${clipReset} projects=${projectReset}`
    );
  }

  if (toResume.length > 0) {
    console.log(
      `[recover] 續跑 ${toResume.length} 筆: ${toResume.map((r) => `${r.title}(${r.pipeline_stage})`).join(", ")}`
    );
    (async () => {
      for (const r of toResume) {
        try {
          await resumeSummaryPipeline(r.id);
          console.log(`[recover] 續跑完成: ${r.title}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          getDb()
            .prepare("UPDATE summaries SET status = 'error', error = ? WHERE id = ?")
            .run(`重啟續跑失敗: ${msg}`.slice(0, 500), r.id);
          console.error(`[recover] 續跑失敗: ${r.title}:`, msg);
        }
      }
    })().catch((err) => console.error("[recover] 續跑迴圈異常:", err));
  }
}
