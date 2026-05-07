import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

/**
 * GET /api/featured — 公開列出所有 is_featured=1 的影片 (給 /featured 公開頁用,不需登入)。
 *
 * Layer 7 護城河 + funnel 入口: 訪客看「允雷的判斷品味」→ 訂閱動機。
 *
 * 回傳欄位刻意 minimal:不暴露 segments / transcript / summary 全文,
 * 只給足以展示卡片的資訊 + 推薦理由。深入要進產品 (login / Premium)。
 */
export async function GET() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
        id, video_id, source, url, title, channel, duration, duration_display,
        thumbnail_url, card_paths, slide_count, featured_note,
        json_extract(summary, '$.one_liner') AS one_liner,
        json_extract(summary, '$.tags') AS tags_json,
        json_extract(summary, '$.video_genre') AS video_genre,
        created_at
      FROM summaries
      WHERE is_featured = 1 AND status = 'done'
      ORDER BY created_at DESC`
    )
    .all() as Array<Record<string, unknown>>;

  const items = rows.map((r) => ({
    id: r.id,
    video_id: r.video_id,
    source: r.source,
    url: r.url,
    title: r.title,
    channel: r.channel,
    duration_display: r.duration_display,
    thumbnail_url: r.thumbnail_url,
    card_paths: typeof r.card_paths === "string" ? JSON.parse(r.card_paths) : null,
    slide_count: r.slide_count,
    featured_note: r.featured_note,
    one_liner: r.one_liner,
    tags: typeof r.tags_json === "string" ? JSON.parse(r.tags_json) : [],
    video_genre: r.video_genre,
    created_at: r.created_at,
  }));

  return NextResponse.json({ items, count: items.length });
}
