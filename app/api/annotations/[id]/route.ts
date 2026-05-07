import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

/**
 * DELETE /api/annotations/{id} — 刪一條筆記
 * PATCH  /api/annotations/{id} — 改 body (body: { body: string })
 */

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const db = getDb();
  const r = db.prepare("DELETE FROM annotations WHERE id = ?").run(numId);
  return NextResponse.json({ deleted: r.changes });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  let payload: { body?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const body = (payload.body || "").trim();
  if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });
  if (body.length > 2000) return NextResponse.json({ error: "body 上限 2000 字" }, { status: 400 });

  const db = getDb();
  const r = db
    .prepare("UPDATE annotations SET body = ?, updated_at = datetime('now') WHERE id = ?")
    .run(body, numId);
  return NextResponse.json({ updated: r.changes });
}
