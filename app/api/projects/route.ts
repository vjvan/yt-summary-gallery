import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import crypto from "crypto";

// POST: Create a new project
export async function POST(req: NextRequest) {
  try {
    const { title } = await req.json();
    if (!title) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const db = getDb();
    db.prepare(
      "INSERT INTO projects (id, title, status) VALUES (?, ?, 'uploading')"
    ).run(id, title);

    return NextResponse.json({ id, status: "uploading" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// GET: List all projects
export async function GET() {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM projects ORDER BY created_at DESC LIMIT 50")
    .all() as Array<Record<string, unknown>>;

  const items = rows.map((row) => {
    const clipCount = (
      db
        .prepare("SELECT COUNT(*) as count FROM project_clips WHERE project_id = ?")
        .get(row.id) as { count: number }
    ).count;

    return {
      ...row,
      combined_summary: row.combined_summary
        ? JSON.parse(row.combined_summary as string)
        : null,
      card_paths: row.card_paths
        ? JSON.parse(row.card_paths as string)
        : null,
      clip_count: clipCount,
    };
  });

  return NextResponse.json({ items });
}
