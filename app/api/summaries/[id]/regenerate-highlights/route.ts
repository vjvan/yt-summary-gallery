import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";
import {
  ensureSummaryShape,
  regenerateHighlights,
  type Summary,
} from "@/lib/pipeline/extract-summary";
import type { TranscriptSegment } from "@/lib/pipeline/fetch-transcript";

/**
 * POST /api/summaries/{id}/regenerate-highlights
 *
 * 強制重產 highlights (給 GPT 當初萃取錯時間戳的影片做 lazy fix)。
 * 不動其他欄位,只重新呼叫 GPT 拿合理 timestamp + 排序的 highlights。
 *
 * 同步回應 (不像 regenerate-cards 是 async),因為只跑一次 GPT call,< 10 秒可結束。
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.summary) return NextResponse.json({ error: "No summary" }, { status: 400 });

  const transcript = (() => {
    if (row.is_translated && row.segments_zh) {
      try {
        const segs = JSON.parse(row.segments_zh) as TranscriptSegment[];
        return formatSegmentsAsTimestamped(segs);
      } catch { /* fallthrough */ }
    }
    if (row.segments) {
      try {
        const segs = JSON.parse(row.segments) as TranscriptSegment[];
        return formatSegmentsAsTimestamped(segs);
      } catch { /* fallthrough */ }
    }
    return row.transcript_zh || row.transcript || "";
  })();

  if (!transcript) {
    return NextResponse.json(
      { error: "no transcript available to regenerate highlights" },
      { status: 400 }
    );
  }

  try {
    const newHighlights = await regenerateHighlights(
      transcript,
      row.title || "",
      row.channel || "",
      row.duration || 0
    );
    let summary: Summary = ensureSummaryShape(JSON.parse(row.summary) as Partial<Summary>);
    summary = { ...summary, highlights: newHighlights };
    db.prepare(`UPDATE summaries SET summary = ? WHERE id = ?`).run(
      JSON.stringify(summary),
      row.id
    );
    return NextResponse.json({
      ok: true,
      highlights: newHighlights,
      count: newHighlights.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message.slice(0, 300) },
      { status: 500 }
    );
  }
}

function formatSegmentsAsTimestamped(segs: TranscriptSegment[]): string {
  return segs
    .map((s) => {
      const m = Math.floor(s.start / 60);
      const sec = Math.floor(s.start % 60);
      return `[${m}:${sec.toString().padStart(2, "0")}] ${s.text}`;
    })
    .join("\n");
}
