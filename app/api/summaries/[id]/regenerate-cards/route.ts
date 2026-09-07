import { NextRequest, NextResponse } from "next/server";
import { getDb, type SummaryRow } from "@/lib/db";
import { renderCard } from "@/lib/pipeline/render-card";
import { CardStyleError, resolveCardStyle, cardStyleOverrides } from "@/lib/card-style";
import { ensureSummaryShape, type Summary } from "@/lib/pipeline/extract-summary";
import path from "path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * POST ?palette=&font=&bg= (`theme` remains a palette alias).
 * This is a style-only render: never call an LLM or change the source summary.
 * Missing social_cards use renderCard's deterministic legacy fallback.
 * Commit style only after ALL 20 images succeed; retain old style/images on error.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db.prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.summary) return NextResponse.json({ error: "No summary to render" }, { status: 400 });

  let style;
  try {
    style = resolveCardStyle(row.card_style, cardStyleOverrides(req.nextUrl.searchParams));
  } catch (error) {
    if (error instanceof CardStyleError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
  let summary: Summary;
  try {
    summary = ensureSummaryShape(JSON.parse(row.summary) as Partial<Summary>);
  } catch {
    return NextResponse.json({ error: "Invalid summary JSON" }, { status: 500 });
  }
  const metadata = {
    video_id: row.video_id,
    title: row.title || "",
    channel: row.channel || "",
    duration: row.duration || 0,
    duration_display: row.duration_display || "",
    upload_date: "",
    thumbnail_url: row.thumbnail_url || "",
    view_count: 0,
    transcript_source: row.transcript_source || "",
  };
  // Immutable per-job directory: a DB failure cannot pair old card_style with
  // newly overwritten images. Previously published paths remain untouched.
  const renderToken = randomUUID();
  const version = `style-${renderToken}`;
  const publicBase = `/cards/${row.video_id}/${version}`;
  const cardDir = path.join(process.cwd(), "public", "cards", row.video_id, version);

  // Claim BEFORE starting asynchronous work. Atomic SQL protects two tabs and
  // separate route workers from competing writes. The dedicated token remains
  // locked even when an independent subtitle job changes pipeline_stage.
  const claimed = db.prepare(`UPDATE summaries SET pipeline_stage = ?, card_render_token = ?, error = NULL
    WHERE id = ? AND card_render_token IS NULL AND COALESCE(pipeline_stage, '') != 'library_rendering'`)
    .run("library_rendering", renderToken, row.id);
  if (claimed.changes !== 1) {
    return NextResponse.json({ error: "這支影片正在重畫，請等完成再套用另一組樣式。" }, { status: 409 });
  }

  void (async () => {
    try {
      const slidePaths = await renderCard(summary, metadata, cardDir, style);
      const publicPaths = slidePaths.map((_, i) => `${publicBase}/slide-${i + 1}.png`);
      const committed = getDb().prepare(`UPDATE summaries SET card_paths = ?, slide_count = ?,
        pipeline_stage = ?, card_style = ?, card_render_token = NULL, error = NULL WHERE id = ? AND card_render_token = ?`)
        .run(JSON.stringify(publicPaths), publicPaths.length, "library_complete", JSON.stringify(style), row.id, renderToken);
      if (committed.changes !== 1) throw new Error("本次圖卡工作已失效；保留目前生效的圖片與樣式。");
    } catch (error) {
      console.error("regenerate-cards error:", error);
      try { fs.rmSync(cardDir, { recursive: true, force: true }); }
      catch (cleanupError) { console.error("無法清理本次未發布圖卡目錄：", cleanupError); }
      getDb().prepare(`UPDATE summaries SET pipeline_stage = ?, card_render_token = NULL, error = ? WHERE id = ? AND card_render_token = ?`)
        .run("library_render_error", `library_render_error: ${error instanceof Error ? error.message : "卡片重畫失敗"}`, row.id, renderToken);
    }
  })();
  return NextResponse.json({ status: "regenerating", slide_count: 20, requested_style: style, render_token: renderToken }, { status: 202 });
}
