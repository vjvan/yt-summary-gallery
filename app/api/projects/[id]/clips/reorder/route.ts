import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// PATCH: Reorder clips
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const { clip_ids } = (await req.json()) as { clip_ids: string[] };

  if (!Array.isArray(clip_ids) || !clip_ids.length) {
    return NextResponse.json(
      { error: "clip_ids array is required" },
      { status: 400 }
    );
  }

  const db = getDb();

  const update = db.prepare(
    "UPDATE project_clips SET sort_order = ? WHERE id = ? AND project_id = ?"
  );

  const transaction = db.transaction(() => {
    clip_ids.forEach((clipId, index) => {
      update.run(index, clipId, projectId);
    });
  });

  transaction();

  return NextResponse.json({ ok: true });
}
