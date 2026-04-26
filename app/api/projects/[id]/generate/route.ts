import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { transcribeClips } from "@/lib/pipeline/transcribe-clips";
import { extractCombinedSummary, buildCombinedTranscript } from "@/lib/pipeline/extract-combined-summary";
import { renderCard } from "@/lib/pipeline/render-card";
import { buildCleanTimeline } from "@/lib/pipeline/build-clean-timeline";
import { assembleVideo } from "@/lib/pipeline/assemble-video";
import fs from "fs";
import path from "path";

// POST: Start the remix pipeline
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const db = getDb();

  const project = db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as Record<string, unknown> | undefined;

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const clipCount = (
    db
      .prepare(
        "SELECT COUNT(*) as count FROM project_clips WHERE project_id = ?"
      )
      .get(projectId) as { count: number }
  ).count;

  if (clipCount === 0) {
    return NextResponse.json(
      { error: "No clips uploaded" },
      { status: 400 }
    );
  }

  db.prepare("UPDATE projects SET status = 'processing' WHERE id = ?").run(
    projectId
  );

  runProjectPipeline(projectId).catch((err) => {
    console.error("Project pipeline error:", err);
    getDb()
      .prepare("UPDATE projects SET status = 'error', error = ? WHERE id = ?")
      .run(err.message?.slice(0, 500) || "Unknown error", projectId);
  });

  return NextResponse.json({ id: projectId, status: "processing" });
}

async function runProjectPipeline(projectId: string) {
  const db = getDb();

  // Step 1: Transcribe all clips (with word-level timestamps)
  console.log(`[project ${projectId}] Step 1: Transcribing clips...`);
  await transcribeClips(projectId);

  // Step 2: Gather completed clips
  const clips = db
    .prepare(
      `SELECT sort_order, file_name, file_path, duration, duration_display, transcript, segments
       FROM project_clips
       WHERE project_id = ? AND status = 'done'
       ORDER BY sort_order`
    )
    .all(projectId) as Array<{
    sort_order: number;
    file_name: string;
    file_path: string;
    duration: number;
    duration_display: string;
    transcript: string;
    segments: string;
  }>;

  if (clips.length === 0) {
    throw new Error("No clips were successfully transcribed");
  }

  const totalDuration = clips.reduce((sum, c) => sum + c.duration, 0);
  const totalMins = Math.floor(totalDuration / 60);
  const totalSecs = Math.floor(totalDuration % 60);
  const totalDisplay = `${totalMins}:${totalSecs.toString().padStart(2, "0")}`;

  const combinedTranscript = buildCombinedTranscript(clips);
  db.prepare(
    "UPDATE projects SET total_duration = ?, total_duration_display = ?, combined_transcript = ? WHERE id = ?"
  ).run(totalDuration, totalDisplay, combinedTranscript, projectId);

  // Step 3: Extract combined summary (for carousel cards)
  console.log(`[project ${projectId}] Step 3: Extracting summary...`);
  const project = db
    .prepare("SELECT title FROM projects WHERE id = ?")
    .get(projectId) as { title: string };

  const { summary } = await extractCombinedSummary(clips, project.title);

  // Step 4: Render carousel cards
  console.log(`[project ${projectId}] Step 4: Rendering cards...`);
  const cardDir = path.join(process.cwd(), "public", "cards", `project-${projectId}`);

  const metadata = {
    video_id: projectId,
    title: project.title,
    channel: `${clips.length} clips`,
    duration: totalDuration,
    duration_display: totalDisplay,
    upload_date: "",
    thumbnail_url: "",
    view_count: 0,
    transcript_source: "whisper" as const,
  };

  const slidePaths = await renderCard(summary, metadata, cardDir);
  const publicPaths = slidePaths.map(
    (_, i) => `/cards/project-${projectId}/slide-${i + 1}.png`
  );

  // Step 5: Build clean timeline (filler removal + subtitle planning)
  console.log(`[project ${projectId}] Step 5: Building clean timeline...`);
  const cleanTimeline = await buildCleanTimeline(clips, project.title);

  db.prepare("UPDATE projects SET video_script = ? WHERE id = ?").run(
    JSON.stringify(cleanTimeline),
    projectId
  );

  // Step 6: Assemble video with subtitles
  console.log(`[project ${projectId}] Step 6: Assembling video...`);
  let videoPublicPath: string | null = null;

  if (cleanTimeline.segments.length > 0) {
    const videoDir = path.join(process.cwd(), "public", "videos", `project-${projectId}`);
    fs.mkdirSync(videoDir, { recursive: true });

    try {
      const { subtitleCues } = await assembleVideo(cleanTimeline, clips, videoDir);
      videoPublicPath = `/videos/project-${projectId}/remix.mp4`;

      // Save subtitle cues for interactive transcript
      cleanTimeline.subtitle_cues = subtitleCues;
      db.prepare("UPDATE projects SET video_script = ? WHERE id = ?").run(
        JSON.stringify(cleanTimeline),
        projectId
      );
    } catch (err) {
      console.error(`[project ${projectId}] Video assembly failed:`, err);
    }
  }

  // Step 7: Done
  console.log(`[project ${projectId}] Done!`);
  db.prepare(
    `UPDATE projects SET
      combined_summary = ?,
      card_paths = ?,
      slide_count = ?,
      video_path = ?,
      status = 'done'
    WHERE id = ?`
  ).run(
    JSON.stringify(summary),
    JSON.stringify(publicPaths),
    publicPaths.length,
    videoPublicPath,
    projectId
  );
}
