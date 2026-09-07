import { NextRequest, NextResponse } from "next/server";
import { getDb, type SummaryRow } from "@/lib/db";
import { buildNotebookSource, NotebookSourceError, parseNotebookSourceLang } from "@/lib/pipeline/notebooklm-source";
import type { TranscriptSegment } from "@/lib/pipeline/fetch-transcript";

/**
 * GET /api/summaries/{id}/notebooklm-source?lang=bi|en|zh
 *
 * 下載可上傳 NotebookLM 當來源的純文字檔：逐句英文原文 + 繁中譯文，各帶時間戳。
 * 只讀資料庫既有字幕，不呼叫模型、不改任何資料。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db.prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?").get(id, id) as SummaryRow | undefined;
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parse = (json: string | null): TranscriptSegment[] | null => {
    if (!json) return null;
    try { const value = JSON.parse(json); return Array.isArray(value) ? value : null; } catch { return null; }
  };

  try {
    const lang = parseNotebookSourceLang(req.nextUrl.searchParams.get("lang"));
    const output = buildNotebookSource({
      title: row.title || "",
      channel: row.channel || "",
      url: row.url || "",
      durationDisplay: row.duration_display || "",
      segments: parse(row.segments) || [],
      segmentsZh: row.is_translated ? parse(row.segments_zh) : null,
      lang,
    });
    const encodedName = encodeURIComponent(output.filename);
    return new NextResponse(output.text, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="notebooklm-source.txt"; filename*=UTF-8''${encodedName}`,
        "Cache-Control": "no-store",
        "X-Notebook-Source-Cues": String(output.cues),
        "X-Notebook-Source-Translated": String(output.translated),
      },
    });
  } catch (error) {
    if (error instanceof NotebookSourceError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
