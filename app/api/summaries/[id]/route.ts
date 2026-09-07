import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";
import fs from "fs";
import path from "path";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const isTranslated = row.is_translated === 1;
  return NextResponse.json({
    ...row,
    summary: row.summary ? JSON.parse(row.summary) : null,
    card_paths: row.card_paths ? JSON.parse(row.card_paths) : null,
    segments: row.segments ? JSON.parse(row.segments) : [],
    segments_zh: row.segments_zh ? JSON.parse(row.segments_zh) : null,
    is_translated: isTranslated,
    audio_url: row.audio_url || null,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 清掉這支影片的所有磁碟產物。以前只刪卡片 PNG,
  // 影片(GB 級)/burned mp4/SRT/tmp 全部殘留,磁碟用量只增不減。
  const root = process.cwd();
  const publicDir = path.join(root, "public");
  const rmrf = (p: string) => {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  rmrf(path.join(publicDir, "cards", row.video_id));
  rmrf(path.join(publicDir, "burned", row.video_id));
  rmrf(path.join(root, "data", "tmp", row.video_id));
  for (const url of [row.video_url, row.audio_url, row.burned_video_url, row.burned_zh_url, row.burned_en_url]) {
    if (url && url.startsWith("/")) rmrf(path.join(publicDir, url.replace(/^\//, "")));
  }

  db.transaction(() => {
    // Private learning evidence, model checkpoints and practice notes have the
    // same lifecycle as their video; deletion must not leave private remnants.
    for (const table of ["learning_point_reviews", "learning_checkpoints", "learning_analyses"] as const) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
        db.prepare(`DELETE FROM ${table} WHERE summary_id = ?`).run(row.id);
      }
    }
    db.prepare("DELETE FROM aivan_project_versions WHERE summary_id = ?").run(row.id);
    db.prepare("DELETE FROM summaries WHERE id = ?").run(row.id);
  })();
  return NextResponse.json({ ok: true });
}
