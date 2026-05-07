import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";
import { fetchVideoFromUrl } from "@/lib/pipeline/fetch-video-url";
import path from "path";

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

  const url = row.url;
  const videoId = row.video_id;
  const summaryRowId = row.id;

  (async () => {
    try {
      const result = fetchVideoFromUrl(url, videoId, process.cwd());
      getDb()
        .prepare(`UPDATE summaries SET video_url = ?, is_video = 1 WHERE id = ?`)
        .run(result.publicVideoUrl, summaryRowId);
    } catch (err) {
      console.error("[download-video] yt-dlp 失敗:", err);
      // 寫入錯誤狀態方便前端 polling 知道掛了
      try {
        getDb()
          .prepare(`UPDATE summaries SET error = ? WHERE id = ?`)
          .run(`download-video: ${(err as Error).message}`.slice(0, 500), summaryRowId);
      } catch { /* swallow */ }
    }
  })().catch(() => { /* swallow */ });

  // 立刻 202,前端 polling video_url 出現
  return NextResponse.json({ status: "downloading" }, { status: 202 });
}
