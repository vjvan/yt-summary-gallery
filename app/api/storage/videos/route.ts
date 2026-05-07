import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import path from "path";
import fs from "fs";

/**
 * GET /api/storage/videos
 *
 * 列出 public/videos/ 下所有 mp4 + 大小,join DB 拿原始 URL/title/source/duration。
 * 給 /admin/storage 看板用。
 */
export async function GET() {
  const dir = path.join(process.cwd(), "public", "videos");
  if (!fs.existsSync(dir)) {
    return NextResponse.json({ files: [], total_bytes: 0 });
  }

  const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".mp4"));
  const db = getDb();
  const files: {
    file: string;
    video_id: string;
    bytes: number;
    size_display: string;
    title: string | null;
    source: string | null;
    url: string | null;
    duration_display: string | null;
    public_url: string;
  }[] = [];

  let totalBytes = 0;
  for (const f of entries) {
    const fullPath = path.join(dir, f);
    let stat;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    const videoId = f.replace(/\.mp4$/, "");
    const row = db
      .prepare(
        "SELECT title, source, url, duration_display FROM summaries WHERE video_id = ? OR id = ?"
      )
      .get(videoId, videoId) as
      | { title: string; source: string; url: string; duration_display: string }
      | undefined;
    files.push({
      file: f,
      video_id: videoId,
      bytes: stat.size,
      size_display: formatBytes(stat.size),
      title: row?.title || null,
      source: row?.source || null,
      url: row?.url || null,
      duration_display: row?.duration_display || null,
      public_url: `/videos/${f}`,
    });
    totalBytes += stat.size;
  }

  // 大檔在前
  files.sort((a, b) => b.bytes - a.bytes);

  return NextResponse.json({
    files,
    total_bytes: totalBytes,
    total_display: formatBytes(totalBytes),
    count: files.length,
  });
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
}
