import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";
import { fetchVideoFromUrl } from "@/lib/pipeline/fetch-video-url";
import { mediaFailureMessage } from "@/lib/media-export-client";
import { acquireMediaOperation, activeMediaOperation, releaseMediaOperation } from "@/lib/pipeline/media-operation";

// One process-local task per row. Reopening the card must not start a duplicate download.
const pendingDownloads = new Set<string>();

/**
 * POST /api/summaries/{id}/download-video
 *
 * C 路徑入口:給 source==='youtube' 的影片 on-demand 下載 mp4 到 public/videos/,
 * 之後前端會自動切成 VideoPlayerPanel 走原生 HTML5 player(PiP / 字幕雙語切換 / 速度)。
 *
 * 不是 source==='youtube' 也照樣可以呼叫(萬一 video-url 路徑某個 case 漏存),
 * 但 video-url 路徑 generate 階段就已經下過 mp4,通常用不到這個。
 *
 * 共用 fetch-video-url 那套 pipeline,內部用 yt-dlp 抓 best mp4。
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.url) return NextResponse.json({ error: "No source URL" }, { status: 400 });
  if (row.video_url) {
    // 已經有 mp4 (可能是先前 video-url 路徑下載的或本次重複呼叫),直接 idempotent 回 done
    return NextResponse.json({ status: "done", video_url: row.video_url });
  }

  if (pendingDownloads.has(row.id)) return NextResponse.json({ status: "downloading" }, { status: 202 });
  if (row.burn_status === "burning") return NextResponse.json({ error: "字幕燒錄進行中，請稍後準備原片。", code: "MEDIA_BUSY" }, { status: 409 });
  const mediaToken = acquireMediaOperation(db, row.id, "download");
  if (!mediaToken) {
    return activeMediaOperation(db, row.id) === "download"
      ? NextResponse.json({ status: "downloading" }, { status: 202 })
      : NextResponse.json({ error: "正在附加原片，請勿同時下載。", code: "MEDIA_BUSY" }, { status: 409 });
  }
  const latest = db.prepare("SELECT * FROM summaries WHERE id = ?").get(row.id) as SummaryRow | undefined;
  if (!latest || latest.video_url || latest.burn_status === "burning") {
    releaseMediaOperation(db, row.id, mediaToken);
    return latest?.video_url
      ? NextResponse.json({ status: "done", video_url: latest.video_url })
      : NextResponse.json({ error: "摘要或原片工作已變更，請重新整理。", code: "MEDIA_BUSY" }, { status: 409 });
  }
  // A prior download failure must not make the new, explicitly requested attempt
  // look failed before it starts. Leave unrelated summary errors intact.
  if (row.error?.startsWith("download-video:")) db.prepare("UPDATE summaries SET error = NULL WHERE id = ?").run(row.id);

  pendingDownloads.add(row.id);
  const url = row.url;
  const videoId = row.video_id;
  const summaryRowId = row.id;

  (async () => {
    try {
      const result = await fetchVideoFromUrl(url, videoId, process.cwd());
      getDb()
        .prepare(`UPDATE summaries SET video_url = ?, is_video = 1 WHERE id = ? AND (video_url IS NULL OR video_url = '')`)
        .run(result.publicVideoUrl, summaryRowId);
    } catch (err) {
      console.error("[download-video] 原片下載失敗，未自動重試。");
      // 寫入錯誤狀態方便前端 polling 知道掛了
      try {
        getDb()
          .prepare(`UPDATE summaries SET error = ? WHERE id = ?`)
          .run(`download-video: ${mediaFailureMessage(err instanceof Error ? err.message : "", "download")}`, summaryRowId);
      } catch { /* swallow */ }
    } finally {
      pendingDownloads.delete(summaryRowId);
      releaseMediaOperation(db, summaryRowId, mediaToken);
    }
  })().catch(() => { /* swallow */ });

  // 立刻 202,前端 polling video_url 出現
  return NextResponse.json({ status: "downloading" }, { status: 202 });
}
