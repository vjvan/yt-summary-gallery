import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";
import { translateSegments, translatePlainText } from "@/lib/pipeline/translate";
import { writeSubtitleFiles } from "@/lib/pipeline/burn-bilingual";
import path from "path";
import type { TranscriptSegment } from "@/lib/pipeline/fetch-transcript";
import { claimSubtitleWrite } from "@/lib/subtitle-writers";

/**
 * POST /api/summaries/{id}/retranslate
 *
 * 拿既有 segments 重跑翻譯(不重跑 Whisper),覆寫 segments_zh + 重寫 SRT/VTT 三檔。
 * 用途:翻譯結果有 fallback 時,點按鈕重來。
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
  if (!row.segments) return NextResponse.json({ error: "No segments to retranslate" }, { status: 400 });

  const segments = JSON.parse(row.segments) as TranscriptSegment[];

  // 取得「整份重寫中譯」的寫入權（資料庫 claim，跨 process）：語意校訂與外部譯文匯入在這段期間
  // 會拒絕套用／還原，避免人工修改被整片覆蓋；拿不到代表別的工作正在寫。
  const endSubtitleWrite = claimSubtitleWrite(row.id, db);
  if (!endSubtitleWrite) return NextResponse.json({ error: "這支影片的字幕正在被其他工作重寫，請等它結束再重新翻譯。" }, { status: 409 });
  // Async,client 立刻拿 202,前端 polling
  (async () => {
    try {
      const { translated: segmentsZh, wasTranslated } = await translateSegments(segments);
      const transcriptZh = wasTranslated ? translatePlainText(segmentsZh) : null;

      getDb().prepare(
        `UPDATE summaries SET transcript_zh = ?, segments_zh = ?, is_translated = ? WHERE id = ?`
      ).run(
        transcriptZh,
        wasTranslated ? JSON.stringify(segmentsZh) : null,
        wasTranslated ? 1 : 0,
        row.id
      );

      // 重寫 SRT/VTT
      if (row.is_video || row.srt_bi_path) {
        const burnDir = path.join(process.cwd(), "public", "burned", row.video_id);
        const srt = writeSubtitleFiles({
          segments,
          segmentsZh: wasTranslated ? segmentsZh : null,
          wasTranslated,
          outputDir: burnDir,
          contentId: row.video_id,
        });
        const toPublic = (p: string | null) =>
          p ? "/" + path.relative(path.join(process.cwd(), "public"), p).split(path.sep).join("/") : null;
        getDb().prepare(
          `UPDATE summaries SET srt_en_path = ?, srt_zh_path = ?, srt_bi_path = ? WHERE id = ?`
        ).run(toPublic(srt.srtEnPath), toPublic(srt.srtZhPath), toPublic(srt.srtBiPath), row.id);
      }

      // 燒過字幕的:既有 burned mp4 已過期,清掉(避免顯示錯字幕)
      if (row.burned_video_url) {
        getDb().prepare(
          `UPDATE summaries SET burned_video_url = NULL, burn_status = NULL WHERE id = ?`
        ).run(row.id);
      }
    } catch (err) {
      console.error("retranslate error:", err);
    } finally {
      endSubtitleWrite();
    }
  })().catch(() => { /* swallow */ });

  // 標記翻譯中(借用 burn_status 欄位太混,改用 retranslating 狀態存在 status?)
  // 簡單起見:保留 status='done',前端 polling 比對 segments_zh 是否變了
  return NextResponse.json({ status: "retranslating" }, { status: 202 });
}
