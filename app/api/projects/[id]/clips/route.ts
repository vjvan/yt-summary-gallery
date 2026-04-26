import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const VALID_EXTS = [
  "mp4", "mov", "webm", "avi", "mkv",
  "mp3", "m4a", "wav", "ogg", "opus", "aac", "flac",
];

// POST: Upload multiple clips to a project
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const db = getDb();

  const project = db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId);
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const formData = await req.formData();
  const files = formData.getAll("files") as File[];

  if (!files.length) {
    return NextResponse.json({ error: "No files uploaded" }, { status: 400 });
  }

  // Get current max sort_order
  const maxOrder = (
    db
      .prepare(
        "SELECT MAX(sort_order) as max_order FROM project_clips WHERE project_id = ?"
      )
      .get(projectId) as { max_order: number | null }
  ).max_order;
  let sortOrder = maxOrder !== null ? maxOrder + 1 : 0;

  const tmpDir = path.join(process.cwd(), "data", "tmp", `project-${projectId}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const clips: Array<{ id: string; file_name: string; sort_order: number }> = [];

  for (const file of files) {
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (!VALID_EXTS.includes(ext)) continue;

    const clipId = crypto.randomUUID();
    const safeFileName = `clip-${sortOrder}-${clipId.slice(0, 8)}.${ext}`;
    const filePath = path.join(tmpDir, safeFileName);

    const buffer = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    db.prepare(
      `INSERT INTO project_clips (id, project_id, sort_order, file_name, file_path, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).run(clipId, projectId, sortOrder, file.name, filePath);

    clips.push({ id: clipId, file_name: file.name, sort_order: sortOrder });
    sortOrder++;
  }

  return NextResponse.json({ clips });
}

// GET: List clips for a project
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const db = getDb();

  const clips = db
    .prepare(
      "SELECT id, sort_order, file_name, duration, duration_display, status, error FROM project_clips WHERE project_id = ? ORDER BY sort_order"
    )
    .all(projectId);

  return NextResponse.json({ clips });
}
