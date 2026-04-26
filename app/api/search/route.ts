import { NextRequest, NextResponse } from "next/server";
import { getDb, SummaryRow } from "@/lib/db";

interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface SearchHit {
  summary_id: string;
  video_id: string;
  title: string;
  source: string;
  is_video: number;
  thumbnail_url: string | null;
  segment_index: number;
  start: number;
  start_display: string;
  text_en: string;
  text_zh: string | null;
  matched_in: "en" | "zh" | "both";
}

export interface TagVideo {
  summary_id: string;
  video_id: string;
  title: string;
  source: string;
  is_video: number;
  matched_tags: string[];
  // 該影片是否同時也有 segment 命中(讓前端可以避免重複渲染)
  has_segment_hits: boolean;
}

const MAX_HITS = 100;

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() || "";
  if (!q) return NextResponse.json({ hits: [], tag_videos: [], total_hits: 0, total_tag_videos: 0 });

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, video_id, title, source, is_video, thumbnail_url, segments, segments_zh, summary
       FROM summaries
       WHERE status = 'done' AND segments IS NOT NULL
       ORDER BY created_at DESC`
    )
    .all() as Pick<SummaryRow, "id" | "video_id" | "title" | "source" | "is_video" | "thumbnail_url" | "segments" | "segments_zh" | "summary">[];

  const qLower = q.toLowerCase();
  const hits: SearchHit[] = [];
  const tagVideos: TagVideo[] = [];
  const videoIdsWithHits = new Set<string>();

  for (const row of rows) {
    let segments: Segment[] = [];
    let segmentsZh: Segment[] | null = null;
    let summaryObj: { tags?: string[] } | null = null;
    try { segments = JSON.parse(row.segments || "[]"); } catch { /* ignore */ }
    try { segmentsZh = row.segments_zh ? JSON.parse(row.segments_zh) : null; } catch { /* ignore */ }
    try { summaryObj = row.summary ? JSON.parse(row.summary) : null; } catch { /* ignore */ }

    // 1. tag matching (影片級)
    const allTags = summaryObj?.tags || [];
    const matchedTags = allTags.filter((t) => t.toLowerCase().includes(qLower));

    // 2. segment matching (段級)
    let segmentHitsForThisVideo = 0;
    if (hits.length < MAX_HITS) {
      for (let i = 0; i < segments.length; i++) {
        const en = segments[i]?.text || "";
        const zh = segmentsZh?.[i]?.text || "";
        const enHit = en.toLowerCase().includes(qLower);
        const zhHit = !!zh && zh.toLowerCase().includes(qLower);
        if (!enHit && !zhHit) continue;

        hits.push({
          summary_id: row.id,
          video_id: row.video_id,
          title: row.title || "(無標題)",
          source: row.source || "",
          is_video: row.is_video || 0,
          thumbnail_url: row.thumbnail_url,
          segment_index: i,
          start: segments[i].start,
          start_display: fmtTime(segments[i].start),
          text_en: en,
          text_zh: zh || null,
          matched_in: enHit && zhHit ? "both" : enHit ? "en" : "zh",
        });
        segmentHitsForThisVideo++;
        if (hits.length >= MAX_HITS) break;
      }
    }
    if (segmentHitsForThisVideo > 0) videoIdsWithHits.add(row.video_id);

    if (matchedTags.length > 0) {
      tagVideos.push({
        summary_id: row.id,
        video_id: row.video_id,
        title: row.title || "(無標題)",
        source: row.source || "",
        is_video: row.is_video || 0,
        matched_tags: matchedTags,
        has_segment_hits: segmentHitsForThisVideo > 0,
      });
    }
  }

  return NextResponse.json({
    hits,
    tag_videos: tagVideos,
    total_hits: hits.length,
    total_tag_videos: tagVideos.length,
    query: q,
  });
}
