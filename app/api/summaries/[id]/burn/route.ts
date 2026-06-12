import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";
import { startBurn, isBurnTrack } from "@/lib/pipeline/start-burn";

/**
 * POST /api/summaries/{id}/burn
 *
 * 觸發字幕燒錄。前提是該 summary 已有對應語系的 SRT 與 raw video。
 * Body: {
 *   hwaccel?: boolean   預設 true (Mac videotoolbox 加速)
 *   track?: 'bi'|'zh'|'en'  預設 'bi' (雙語)。三種語系獨立輸出檔,可分別燒錄。
 * }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { hwaccel?: boolean; track?: string } = {};
  try { body = await req.json(); } catch { /* no body ok */ }
  const hwaccel = body.hwaccel !== false; // 預設 true
  const track = isBurnTrack(body.track) ? body.track : "bi";

  const result = startBurn(row, track, hwaccel);
  return NextResponse.json(result.body, { status: result.status });
}
