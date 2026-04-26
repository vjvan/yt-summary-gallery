import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";
import { burnSubtitleToVideo } from "@/lib/pipeline/burn-bilingual";
import path from "path";
import fs from "fs";

/**
 * POST /api/summaries/{id}/burn
 *
 * 觸發雙語字幕燒錄。前提是該 summary 已有 srt_bi_path 與 raw video。
 * Body: { hwaccel?: boolean } 預設 true (Mac videotoolbox 加速)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.is_video) return NextResponse.json({ error: "Not a video" }, { status: 400 });
  if (!row.srt_bi_path) return NextResponse.json({ error: "No SRT yet" }, { status: 400 });
  if (!row.video_url) return NextResponse.json({ error: "No source video" }, { status: 400 });
  if (row.burn_status === "burning") {
    return NextResponse.json({ status: "burning", message: "Already in progress" });
  }
  if (row.burn_status === "done" && row.burned_video_url) {
    return NextResponse.json({ status: "done", burned_video_url: row.burned_video_url });
  }

  let body: { hwaccel?: boolean } = {};
  try { body = await req.json(); } catch { /* no body ok */ }
  const hwaccel = body.hwaccel !== false; // 預設 true

  const publicDir = path.join(process.cwd(), "public");
  const videoPath = path.join(publicDir, row.video_url.replace(/^\//, ""));
  const srtPath = path.join(publicDir, row.srt_bi_path.replace(/^\//, ""));
  const outputDir = path.join(publicDir, "burned", row.video_id);

  if (!fs.existsSync(videoPath)) {
    return NextResponse.json({ error: `Source video missing: ${videoPath}` }, { status: 410 });
  }
  if (!fs.existsSync(srtPath)) {
    return NextResponse.json({ error: `SRT missing: ${srtPath}` }, { status: 410 });
  }

  db.prepare("UPDATE summaries SET burn_status = 'burning', burn_error = NULL WHERE id = ?")
    .run(row.id);

  // Async,讓 client 立刻拿 202
  (async () => {
    try {
      const burnedPath = await burnSubtitleToVideo({
        videoPath,
        srtPath,
        outputDir,
        contentId: row.video_id,
        hwaccel,
      });
      const publicUrl = "/" + path.relative(publicDir, burnedPath).split(path.sep).join("/");
      getDb()
        .prepare("UPDATE summaries SET burn_status = 'done', burned_video_url = ? WHERE id = ?")
        .run(publicUrl, row.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "burn failed";
      getDb()
        .prepare("UPDATE summaries SET burn_status = 'error', burn_error = ? WHERE id = ?")
        .run(message.slice(0, 500), row.id);
    }
  })().catch(() => { /* swallow */ });

  return NextResponse.json({ status: "burning", hwaccel }, { status: 202 });
}
