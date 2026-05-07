import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

/**
 * Layer 7 護城河: 推薦影片庫管理 API。
 *
 * PATCH /api/summaries/{id}/featured  body: { is_featured: boolean, featured_note?: string }
 *   切換是否在公開的 /featured 頁顯示, featured_note 是允雷對這支影片的推薦理由。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let payload: { is_featured?: boolean; featured_note?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const isFeatured = payload.is_featured ? 1 : 0;
  const note = (payload.featured_note || "").trim().slice(0, 300);

  const db = getDb();
  const r = db
    .prepare(
      "UPDATE summaries SET is_featured = ?, featured_note = ? WHERE id = ? OR video_id = ?"
    )
    .run(isFeatured, note || null, id, id);

  if (r.changes === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ updated: r.changes, is_featured: !!isFeatured, featured_note: note });
}
