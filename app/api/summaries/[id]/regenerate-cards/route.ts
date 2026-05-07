import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";
import { renderCard, CARD_THEMES } from "@/lib/pipeline/render-card";
import { ensureSummaryShape, augmentSummary, PROMPT_VERSION, type Summary } from "@/lib/pipeline/extract-summary";
import type { TranscriptSegment } from "@/lib/pipeline/fetch-transcript";
import path from "path";

/**
 * POST /api/summaries/{id}/regenerate-cards?theme=wine-cream&include_recall=true
 *
 * 用既有 summary JSON 重新跑 renderCard,輸出新版 carousel slides (依 video_genre 智能 layout)。
 * theme 不帶就用 hash(video_id) 自動分配。
 *
 * Lazy upgrade: 如果 DB 內 summary 缺新欄位 (tldr_paragraph / pitfalls / recall_questions / video_genre),
 * 自動先呼叫 augmentSummary 補欄位再寫回 DB,再渲染卡。一鍵升級,不需另開 endpoint。
 *
 * include_recall=true 才會在 layout 結尾加「自我測驗卡 P9」(預設關)。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const themeOverride = req.nextUrl.searchParams.get("theme") || undefined;
  const includeRecall = req.nextUrl.searchParams.get("include_recall") === "true";
  if (themeOverride && !CARD_THEMES[themeOverride]) {
    return NextResponse.json(
      { error: `unknown theme: ${themeOverride}`, valid: Object.keys(CARD_THEMES) },
      { status: 400 }
    );
  }
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.summary) return NextResponse.json({ error: "No summary to render" }, { status: 400 });

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

  const cardDir = path.join(process.cwd(), "public", "cards", row.video_id);
  const summaryRowId = row.id;

  // 把要在背景用到的欄位先 capture 起來,避免 row 在 closure 內變動 (其實 SummaryRow 是 frozen object 但保險起見)
  const transcriptForAugment = (() => {
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

  (async () => {
    try {
      // === Lazy augment: 缺新欄位就先補,寫回 DB ===
      const needsAugment =
        !summary.tldr_paragraph ||
        !summary.video_genre ||
        summary.video_genre === "other" && !summary.pitfalls?.length;

      if (needsAugment && transcriptForAugment) {
        try {
          summary = await augmentSummary(
            summary,
            transcriptForAugment,
            metadata.title,
            metadata.channel
          );
        } catch (err) {
          console.warn("[regenerate-cards] augmentSummary 失敗,繼續用舊 summary 渲染:", err);
        }
      }

      // Layer 4 護城河:不論有無 augment,標記這筆 summary 已用 PROMPT_VERSION 渲染過
      if (summary.prompt_version !== PROMPT_VERSION) {
        summary = { ...summary, prompt_version: PROMPT_VERSION };
      }
      getDb()
        .prepare(`UPDATE summaries SET summary = ? WHERE id = ?`)
        .run(JSON.stringify(summary), summaryRowId);

      const slidePaths = await renderCard(summary, metadata, cardDir, themeOverride, includeRecall);
      const publicPaths = slidePaths.map(
        (_, i) => `/cards/${row.video_id}/slide-${i + 1}.png`
      );
      getDb()
        .prepare(`UPDATE summaries SET card_paths = ?, slide_count = ? WHERE id = ?`)
        .run(JSON.stringify(publicPaths), publicPaths.length, summaryRowId);
    } catch (err) {
      console.error("regenerate-cards error:", err);
    }
  })().catch(() => {
    /* swallow */
  });

  return NextResponse.json({ status: "regenerating", include_recall: includeRecall }, { status: 202 });
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
