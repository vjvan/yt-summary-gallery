import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import fs from "fs";
import path from "path";

// GET: Get project detail with clips
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();

  const project = db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const clips = db
    .prepare(
      "SELECT * FROM project_clips WHERE project_id = ? ORDER BY sort_order"
    )
    .all(id) as Array<Record<string, unknown>>;

  return NextResponse.json({
    ...project,
    combined_summary: project.combined_summary
      ? JSON.parse(project.combined_summary as string)
      : null,
    card_paths: project.card_paths
      ? JSON.parse(project.card_paths as string)
      : null,
    video_script: project.video_script
      ? JSON.parse(project.video_script as string)
      : null,
    clips: clips.map((c) => ({
      ...c,
      segments: c.segments ? JSON.parse(c.segments as string) : null,
    })),
  });
}

// DELETE: Delete project and all associated files
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();

  const project = db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Delete card files
  if (project.card_paths) {
    try {
      const paths = JSON.parse(project.card_paths as string) as string[];
      for (const p of paths) {
        const filePath = path.join(process.cwd(), "public", p);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch {}
  }

  // Delete tmp directory
  const tmpDir = path.join(process.cwd(), "data", "tmp", `project-${id}`);
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Delete clips and project
  db.prepare("DELETE FROM project_clips WHERE project_id = ?").run(id);
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);

  return NextResponse.json({ ok: true });
}
