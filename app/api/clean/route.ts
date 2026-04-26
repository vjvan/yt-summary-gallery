import { NextRequest, NextResponse } from "next/server";
import { analyzeVideo, type TimelineItem } from "@/lib/pipeline/auto-clean";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

// In-memory job store
interface Job {
  status: "processing" | "analyzed" | "error";
  step?: string;
  detail?: string;
  videoPath?: string;       // original uploaded video
  items?: TimelineItem[];
  originalDuration?: number;
  estimatedCleanDuration?: number;
  error?: string;
}

// Export for use by assemble endpoint
export const jobs = new Map<string, Job>();

// POST: Upload + analyze
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  const jobId = randomUUID();
  const uploadDir = path.join(process.cwd(), "data", "tmp", `clean-${jobId}`);
  fs.mkdirSync(uploadDir, { recursive: true });

  const buffer = Buffer.from(await file.arrayBuffer());
  const inputPath = path.join(uploadDir, file.name);
  fs.writeFileSync(inputPath, buffer);

  jobs.set(jobId, { status: "processing", step: "extracting", detail: "準備中..." });

  analyzeVideo(inputPath, uploadDir, (step, detail) => {
    const job = jobs.get(jobId);
    if (job) {
      job.step = step;
      job.detail = detail;
    }
  })
    .then((result) => {
      jobs.set(jobId, {
        status: "analyzed",
        step: "analyzed",
        videoPath: result.videoPath,
        items: result.items,
        originalDuration: result.originalDuration,
        estimatedCleanDuration: result.estimatedCleanDuration,
      });
    })
    .catch((err) => {
      jobs.set(jobId, {
        status: "error",
        step: "error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    });

  return NextResponse.json({ jobId });
}

// GET: Poll status / get analysis results
export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get("id");
  if (!jobId) {
    return NextResponse.json({ error: "Missing id" }, { status: 400 });
  }

  const job = jobs.get(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Don't send videoPath (filesystem path) to client
  const { videoPath, ...safeJob } = job;
  return NextResponse.json(safeJob);
}
