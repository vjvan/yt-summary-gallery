import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getDb, type SummaryRow } from "@/lib/db";
import type { SocialCard } from "@/lib/pipeline/extract-summary";
import { findMoatTerms, ImportAnalysisError, IMPORT_LIMITS, parseExternalAnalysis } from "@/lib/pipeline/import-analysis";
import { libraryCardsReady, libraryJobActive } from "@/lib/pipeline/local-youtube-library";

/**
 * 外部分析貼入（NotebookLM 等）。
 *
 * POST body { text, provider?, dryRun? }
 *   dryRun：只回傳解析出的 20 頁與統計，不寫入。
 *   正式匯入：只改 summary.social_cards 與 social_cards_source，其餘摘要欄位原封不動（不經正規化重寫）；
 *   原本的頁面備份在 external_analysis，之後由前端呼叫既有 regenerate-cards 以目前樣式重畫。不呼叫任何模型。
 * DELETE：還原匯入前的頁面（本機或雲端萃取的版本）。
 *
 * 重畫進行中（card_render_token 佔用）、摘要尚未就緒、影片庫工作還在產第一版圖卡時一律 409，避免摘要與圖片對不上。
 */
const PROVIDERS = new Set(["notebooklm", "manual"]);
const MAX_BODY_BYTES = 400_000;

interface ExternalAnalysisRecord {
  provider: string;
  imported_at: string;
  text: string;
  text_sha256: string;
  card_count: number;
  /** 匯入前兩個欄位的原始值與「欄位是否存在」，還原時逐字放回，不用預設值代替。 */
  previous_social_cards: unknown;
  previous_social_cards_present: boolean;
  previous_source: unknown;
  previous_source_present: boolean;
}

function readMoatTerms(): string[] {
  try {
    const file = path.join(process.cwd(), "data", "moat-terms.txt");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch { return []; }
}

/** 逐段讀 body 並以實際位元組數設上限，不信任 Content-Length。 */
async function readBoundedJson(req: NextRequest): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new ImportAnalysisError("貼入的內容太大，請先刪減。", 413);
  const reader = req.body?.getReader();
  if (!reader) throw new ImportAnalysisError("請以 JSON 送出貼入的分析文字。");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new ImportAnalysisError("貼入的內容太大，請先刪減。", 413);
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new ImportAnalysisError("請以 JSON 送出貼入的分析文字。"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ImportAnalysisError("請以 JSON 物件送出貼入的分析文字。");
  return body as Record<string, unknown>;
}

function loadRow(id: string): SummaryRow | undefined {
  return getDb().prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?").get(id, id) as SummaryRow | undefined;
}

/** 原封不動地拿到既有摘要物件；壞掉或還沒有就拒絕，絕不用空摘要蓋掉原始資料。 */
function rawSummary(row: SummaryRow): Record<string, unknown> {
  if (!row.summary) throw new ImportAnalysisError("摘要尚未就緒，請等摘要完成再匯入分析。", 409);
  let value: unknown;
  try { value = JSON.parse(row.summary); } catch { throw new ImportAnalysisError("既有摘要不是有效的 JSON；為避免覆蓋原始資料，未匯入。", 422); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ImportAnalysisError("既有摘要格式異常；為避免覆蓋原始資料，未匯入。", 422);
  return value as Record<string, unknown>;
}

function parseRecord(raw: string | null | undefined): ExternalAnalysisRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ExternalAnalysisRecord>;
    if (!value || typeof value !== "object" || typeof value.imported_at !== "string") return null;
    return {
      provider: String(value.provider || "notebooklm"),
      imported_at: value.imported_at,
      text: String(value.text || ""),
      text_sha256: String(value.text_sha256 || ""),
      card_count: Number(value.card_count || 0),
      previous_social_cards: value.previous_social_cards,
      previous_social_cards_present: value.previous_social_cards_present ?? Array.isArray(value.previous_social_cards),
      previous_source: value.previous_source,
      previous_source_present: value.previous_source_present ?? (typeof value.previous_source === "string" && value.previous_source !== "local"),
    };
  } catch { return null; }
}

function busyReason(row: SummaryRow): string | null {
  if (row.card_render_token != null || row.pipeline_stage === "library_rendering") return "這支影片正在重畫圖卡，請等完成再操作。";
  if (row.status === "processing") return "這支影片的摘要或圖卡還在產生中，請等第一版完成再匯入。";
  if (libraryJobActive(row.id) && !libraryCardsReady(row.card_paths)) return "本機影片庫正在產第一版圖卡，請等它完成再匯入。";
  return null;
}

function failure(error: unknown) {
  if (error instanceof ImportAnalysisError) return NextResponse.json({ error: error.message }, { status: error.status });
  throw error;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await readBoundedJson(req);
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length > IMPORT_LIMITS.maxText) throw new ImportAnalysisError(`貼入的分析超過 ${IMPORT_LIMITS.maxText} 字（含空白），請先刪減。`, 413);
    const provider = typeof body.provider === "string" && PROVIDERS.has(body.provider) ? body.provider : "notebooklm";
    const dryRun = body.dryRun === true;

    const row = loadRow(id);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const raw = rawSummary(row);
    const title = typeof raw.title_display === "string" && raw.title_display ? raw.title_display : row.title || "";
    const parsed = parseExternalAnalysis(text, { title, provider });
    const moatHits = findMoatTerms(text, readMoatTerms());
    const warnings = [...parsed.warnings, ...(moatHits.length ? [`貼入內容含護城河詞：${moatHits.join("、")}。圖卡會對外發佈，請先確認可講。`] : [])];
    const stats = { contentCards: parsed.contentCards, dropped: parsed.dropped, padded: parsed.padded, sections: parsed.sections };

    if (dryRun) return NextResponse.json({ dryRun: true, cards: parsed.cards, stats, warnings });
    const busy = busyReason(row);
    if (busy) throw new ImportAnalysisError(busy, 409);

    const existing = parseRecord(row.external_analysis);
    const record: ExternalAnalysisRecord = {
      provider,
      imported_at: new Date().toISOString(),
      text,
      text_sha256: createHash("sha256").update(text).digest("hex"),
      card_count: parsed.cards.length,
      // 只保留第一次匯入前的版本（原始值與是否存在，不正規化），讓多次匯入後仍能逐字還原到本機／雲端萃取的原稿。
      previous_social_cards: existing ? existing.previous_social_cards : raw.social_cards,
      previous_social_cards_present: existing ? existing.previous_social_cards_present : Object.prototype.hasOwnProperty.call(raw, "social_cards"),
      previous_source: existing ? existing.previous_source : raw.social_cards_source,
      previous_source_present: existing ? existing.previous_source_present : Object.prototype.hasOwnProperty.call(raw, "social_cards_source"),
    };
    const nextSummary = { ...raw, social_cards: parsed.cards satisfies SocialCard[], social_cards_source: `external:${provider}` };
    const updated = getDb().prepare(`UPDATE summaries SET summary = ?, external_analysis = ? WHERE id = ? AND card_render_token IS NULL AND COALESCE(pipeline_stage, '') != 'library_rendering' AND summary = ?`)
      .run(JSON.stringify(nextSummary), JSON.stringify(record), row.id, row.summary);
    if (updated.changes !== 1) throw new ImportAnalysisError("這支影片的摘要或圖卡剛被其他工作更動，未匯入；請重新整理後再試。", 409);
    return NextResponse.json({ imported: true, provider, imported_at: record.imported_at, cards: parsed.cards, stats, warnings });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const row = loadRow(id);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const record = parseRecord(row.external_analysis);
    if (!record) throw new ImportAnalysisError("這支影片沒有匯入過外部分析，沒有可還原的版本。", 404);
    const busy = busyReason(row);
    if (busy) throw new ImportAnalysisError(busy, 409);
    const raw = rawSummary(row);
    const restored: Record<string, unknown> = { ...raw };
    if (record.previous_social_cards_present) restored.social_cards = record.previous_social_cards; else delete restored.social_cards;
    if (record.previous_source_present) restored.social_cards_source = record.previous_source; else delete restored.social_cards_source;
    const updated = getDb().prepare(`UPDATE summaries SET summary = ?, external_analysis = NULL WHERE id = ? AND card_render_token IS NULL AND COALESCE(pipeline_stage, '') != 'library_rendering' AND summary = ?`)
      .run(JSON.stringify(restored), row.id, row.summary);
    if (updated.changes !== 1) throw new ImportAnalysisError("這支影片的摘要剛被其他工作更動，未還原；請重新整理後再試。", 409);
    return NextResponse.json({ restored: true, cards: Array.isArray(record.previous_social_cards) ? record.previous_social_cards.length : 0, source: record.previous_source_present ? record.previous_source : "local" });
  } catch (error) {
    return failure(error);
  }
}
