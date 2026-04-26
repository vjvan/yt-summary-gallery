import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";
import { segmentsToSrt } from "@/lib/pipeline/generate-srt";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Prefer Chinese segments if translated
  const segments = row.is_translated && row.segments_zh
    ? JSON.parse(row.segments_zh)
    : row.segments
      ? JSON.parse(row.segments)
      : [];

  if (segments.length === 0) {
    return NextResponse.json({ error: "No segments" }, { status: 404 });
  }

  const srt = segmentsToSrt(segments);
  const title = (row.title || "subtitle").replace(/[^\w\u4e00-\u9fff-]/g, "_");

  return new NextResponse(srt, {
    headers: {
      "Content-Type": "text/srt; charset=utf-8",
      "Content-Disposition": `attachment; filename="${title}.srt"`,
    },
  });
}
