import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import path from "path";
import fs from "fs";

/**
 * DELETE /api/storage/videos/{video_id}
 *
 * 刪除 public/videos/{video_id}.mp4 + 清 DB 對應 row 的 video_url + is_video=0,
 * 之後該卡的 carousel YouTube player 會自動 fallback 回 A 路徑 (iframe + overlay)。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ video_id: string }> }
) {
  const { video_id } = await params;
  // 安全檢查: 只允許簡單的 video_id 字元,擋路徑遍歷
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(video_id)) {
    return NextResponse.json({ error: "invalid video_id" }, { status: 400 });
  }

  const filePath = path.join(process.cwd(), "public", "videos", `${video_id}.mp4`);
  let removedFile = false;
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      removedFile = true;
    } catch (err) {
      return NextResponse.json(
        { error: `failed to remove file: ${(err as Error).message}` },
        { status: 500 }
      );
    }
  }

  // 清 DB 旗標 (即使檔已不在,DB 還是要對齊)
  const db = getDb();
  const row = db
    .prepare("SELECT id FROM summaries WHERE video_id = ? OR id = ?")
    .get(video_id, video_id) as { id: string } | undefined;
  let dbUpdated = false;
  if (row) {
    db.prepare(`UPDATE summaries SET video_url = NULL, is_video = 0 WHERE id = ?`).run(row.id);
    dbUpdated = true;
  }

  return NextResponse.json({ removed_file: removedFile, db_updated: dbUpdated });
}
