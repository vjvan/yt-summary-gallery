import { NextRequest, NextResponse } from "next/server";
import { assembleClean } from "@/lib/pipeline/auto-clean";
import { jobs } from "../route";
import fs from "fs";
import path from "path";

// POST: Assemble clean video from user's selections
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { jobId, keepItemIds } = body as { jobId: string; keepItemIds: number[] };

  if (!jobId || !keepItemIds) {
    return NextResponse.json({ error: "Missing jobId or keepItemIds" }, { status: 400 });
  }

  const job = jobs.get(jobId);
  if (!job || job.status !== "analyzed" || !job.items || !job.videoPath) {
    return NextResponse.json({ error: "Job not ready" }, { status: 400 });
  }

  const keepSet = new Set(keepItemIds);
  const keepItems = job.items
    .filter((item) => keepSet.has(item.id))
    .map((item) => ({ start: item.start, end: item.end, text: item.text }));

  if (keepItems.length === 0) {
    return NextResponse.json({ error: "No items selected to keep" }, { status: 400 });
  }

  const outputDir = path.join(process.cwd(), "public", "clean", jobId);

  try {
    const result = await assembleClean(job.videoPath, keepItems, outputDir);

    // Cleanup upload directory
    const uploadDir = path.join(process.cwd(), "data", "tmp", `clean-${jobId}`);
    try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}

    // Clean up job from memory
    jobs.delete(jobId);

    return NextResponse.json({
      videoPath: `/clean/${jobId}/clean.mp4`,
      srtPath: `/clean/${jobId}/clean.srt`,
      originalDuration: result.originalDuration,
      cleanDuration: result.cleanDuration,
      removedCount: (job.items?.length || 0) - keepItems.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Assembly failed" },
      { status: 500 }
    );
  }
}
