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

  // Delete card files
  if (row.card_paths) {
    try {
      const paths = JSON.parse(row.card_paths) as string[];
      for (const p of paths) {
        const filePath = path.join(process.cwd(), "public", p);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch {}
  }

  db.prepare("DELETE FROM summaries WHERE id = ?").run(row.id);
  return NextResponse.json({ ok: true });
}
