import { NextRequest, NextResponse } from "next/server";
import { getDb, AnnotationRow } from "@/lib/db";

/**
 * Layer 3 護城河: 個人筆記 API。
 *
 * GET  /api/annotations?video_id=xxx — 列某影片的所有 annotation (時間戳升序)
 * POST /api/annotations               — 建立 (body: { video_id, timestamp, body })
 *
 * 累積越多筆記 = switching cost 越高 = 學員越難離開。
 */

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("video_id");
  const db = getDb();

  if (videoId) {
    const rows = db
      .prepare(
        "SELECT * FROM annotations WHERE video_id = ? ORDER BY timestamp ASC, id ASC"
      )
      .all(videoId) as AnnotationRow[];
    return NextResponse.json({ annotations: rows });
  }

  // 沒帶 video_id 就回所有 (給 cross-video search 用)
  const rows = db
    .prepare("SELECT * FROM annotations ORDER BY updated_at DESC LIMIT 500")
    .all() as AnnotationRow[];
  return NextResponse.json({ annotations: rows });
}

export async function POST(req: NextRequest) {
  let payload: { video_id?: string; timestamp?: number; body?: string };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const videoId = (payload.video_id || "").trim();
  const timestamp = Number(payload.timestamp);
  const body = (payload.body || "").trim();

  if (!videoId || !Number.isFinite(timestamp) || timestamp < 0 || !body) {
    return NextResponse.json(
      { error: "video_id (string) + timestamp (>=0) + body (non-empty) required" },
      { status: 400 }
    );
  }
  if (body.length > 2000) {
    return NextResponse.json({ error: "body 上限 2000 字" }, { status: 400 });
  }

  const db = getDb();
  const result = db
    .prepare(
      "INSERT INTO annotations (video_id, timestamp, body) VALUES (?, ?, ?)"
    )
    .run(videoId, Math.floor(timestamp), body);

  const created = db
    .prepare("SELECT * FROM annotations WHERE id = ?")
    .get(result.lastInsertRowid) as AnnotationRow;

  return NextResponse.json({ annotation: created }, { status: 201 });
}
