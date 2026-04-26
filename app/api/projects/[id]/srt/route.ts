import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { segmentsToSrt } from "@/lib/pipeline/generate-srt";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const db = getDb();

  const project = db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as { title: string; video_script: string | null } | undefined;

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const type = req.nextUrl.searchParams.get("type") || "video";

  if (type === "video" && project.video_script) {
    // SRT for the assembled remix video (from subtitle_cues)
    const script = JSON.parse(project.video_script);
    const cues = script.subtitle_cues || [];

    if (cues.length === 0) {
      return NextResponse.json({ error: "No subtitle cues" }, { status: 404 });
    }

    const segments = cues.map((c: { text: string; video_start: number; video_end: number }) => ({
      start: c.video_start,
      end: c.video_end,
      text: c.text,
    }));

    const srt = segmentsToSrt(segments);
    const title = (project.title || "remix").replace(/[^\w\u4e00-\u9fff-]/g, "_");

    return new NextResponse(srt, {
      headers: {
        "Content-Type": "text/srt; charset=utf-8",
        "Content-Disposition": `attachment; filename="${title}.srt"`,
      },
    });
  }

  // SRT for individual clips (concatenated with clip offsets)
  const clips = db
    .prepare(
      `SELECT sort_order, file_name, duration, segments
       FROM project_clips
       WHERE project_id = ? AND status = 'done'
       ORDER BY sort_order`
    )
    .all(projectId) as Array<{
    sort_order: number;
    file_name: string;
    duration: number;
    segments: string;
  }>;

  if (clips.length === 0) {
    return NextResponse.json({ error: "No clips" }, { status: 404 });
  }

  // Concatenate all clip segments with time offsets
  let offset = 0;
  const allSegments: { start: number; end: number; text: string }[] = [];

  for (const clip of clips) {
    const segs = clip.segments ? JSON.parse(clip.segments) : [];
    for (const seg of segs) {
      allSegments.push({
        start: seg.start + offset,
        end: seg.end + offset,
        text: seg.text,
      });
    }
    offset += clip.duration;
  }

  const srt = segmentsToSrt(allSegments);
  const title = (project.title || "clips").replace(/[^\w\u4e00-\u9fff-]/g, "_");

  return new NextResponse(srt, {
    headers: {
      "Content-Type": "text/srt; charset=utf-8",
      "Content-Disposition": `attachment; filename="${title}_clips.srt"`,
    },
  });
}
