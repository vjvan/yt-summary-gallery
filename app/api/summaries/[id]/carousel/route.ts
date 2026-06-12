import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";
import { ensureSummaryShape, type Summary } from "@/lib/pipeline/extract-summary";
import { buildCaption } from "@/lib/pipeline/build-caption";
import { run } from "@/lib/pipeline/run-command";
import fs from "fs";
import path from "path";

/**
 * GET /api/summaries/{id}/carousel
 *
 * Carousel 一鍵匯出:把該影片所有卡片 PNG (1080x1350,原生 IG 4:5) 打包成 zip,
 * 並附上 caption.txt — 從 summary 自動生成的社群貼文文案(標題/一句話/TLDR/重點/hashtags),
 * 發 IG/Threads 時直接複製貼上,不用再自己寫。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM summaries WHERE id = ? OR video_id = ?")
    .get(id, id) as SummaryRow | undefined;

  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.card_paths) {
    return NextResponse.json({ error: "尚未產出卡片" }, { status: 400 });
  }

  let cardPaths: string[];
  try {
    cardPaths = JSON.parse(row.card_paths) as string[];
  } catch {
    return NextResponse.json({ error: "card_paths 格式錯誤" }, { status: 500 });
  }

  const publicDir = path.join(process.cwd(), "public");
  const pngFiles = cardPaths
    .map((p) => path.join(publicDir, p.replace(/^\//, "")))
    .filter((p) => fs.existsSync(p));

  if (pngFiles.length === 0) {
    return NextResponse.json({ error: "卡片檔案不存在,請先 regenerate-cards" }, { status: 404 });
  }

  const summary: Summary | null = row.summary
    ? ensureSummaryShape(JSON.parse(row.summary) as Partial<Summary>)
    : null;

  const exportDir = path.join(process.cwd(), "data", "tmp", `carousel-${row.video_id}`);
  fs.rmSync(exportDir, { recursive: true, force: true });
  fs.mkdirSync(exportDir, { recursive: true });

  try {
    if (summary) {
      fs.writeFileSync(
        path.join(exportDir, "caption.txt"),
        buildCaption(summary, row.title || ""),
        "utf-8"
      );
    }

    const zipPath = path.join(exportDir, "carousel.zip");
    const fileArgs = [
      ...pngFiles,
      ...(summary ? [path.join(exportDir, "caption.txt")] : []),
    ]
      .map((f) => `"${f}"`)
      .join(" ");
    // -j: 不保留目錄結構,zip 內直接是 slide-1.png ... caption.txt
    await run(`zip -j "${zipPath}" ${fileArgs}`, { timeoutMs: 60000 });

    const zipBuffer = fs.readFileSync(zipPath);
    const fileName = `carousel-${row.video_id}.zip`;
    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(zipBuffer.length),
      },
    });
  } finally {
    fs.rmSync(exportDir, { recursive: true, force: true });
  }
}
