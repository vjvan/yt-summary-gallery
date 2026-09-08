/**
 * 「正在整份重寫 segments_zh」的工作登記。整片重新翻譯這類工作會讀出原文、跑好幾分鐘模型、
 * 最後無條件覆寫中譯；語意校訂與外部譯文匯入在套用／還原前查這裡，有人佔用就拒絕（409），
 * 避免人工修改被背景工作蓋掉。
 *
 * 登記有兩層：同一個 process 的計數（快、涵蓋沒有資料庫可用的路徑）與資料庫上的 claim
 * （跨 process，命令列工具與 3000 服務端共用）。claim 帶到期時間，程序當掉後過期自動回收。
 */
import type Database from 'better-sqlite3';
import { getDb } from './db';

const runtime = globalThis as typeof globalThis & { __subtitleWriters?: Map<string, number> };
const writers = () => runtime.__subtitleWriters ??= new Map<string, number>();
/** 整片重譯可能要好幾分鐘；比它久一點，但程序當掉時不會永久卡住。 */
export const SUBTITLE_CLAIM_TTL_MS = 60 * 60_000;

function claimColumns(db: Database.Database) {
  for (const statement of ['ALTER TABLE summaries ADD COLUMN subtitle_write_token TEXT', 'ALTER TABLE summaries ADD COLUMN subtitle_write_until INTEGER']) {
    try { db.exec(statement); } catch { /* already exists */ }
  }
}

/** 原子取得寫入權；別人佔用中就回 null。回傳的函式釋放這次的 claim（只認自己的 token）。 */
export function claimSubtitleWrite(summaryId: string, db: Database.Database = getDb(), now = Date.now()): (() => void) | null {
  claimColumns(db);
  const token = `w-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const claimed = db.prepare(`UPDATE summaries SET subtitle_write_token=?, subtitle_write_until=?
    WHERE id=? AND (subtitle_write_token IS NULL OR subtitle_write_until IS NULL OR subtitle_write_until < ?)`)
    .run(token, now + SUBTITLE_CLAIM_TTL_MS, summaryId, now);
  if (claimed.changes !== 1) return null;
  const endLocal = beginSubtitleWrite(summaryId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { db.prepare('UPDATE summaries SET subtitle_write_token=NULL, subtitle_write_until=NULL WHERE id=? AND subtitle_write_token=?').run(summaryId, token); }
    finally { endLocal(); }
  };
}

/** 只登記在這個 process（沒有資料庫 claim 的舊路徑仍可用）。 */
export function beginSubtitleWrite(summaryId: string): () => void {
  const map = writers();
  map.set(summaryId, (map.get(summaryId) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const remaining = (map.get(summaryId) ?? 1) - 1;
    if (remaining <= 0) map.delete(summaryId); else map.set(summaryId, remaining);
  };
}

/** 這支影片的中譯此刻是否有人在整份重寫：本 process 的登記，或資料庫上還沒過期的 claim。 */
export function subtitleWriteActive(summaryId: string, db?: Database.Database, now = Date.now()): boolean {
  if ((writers().get(summaryId) ?? 0) > 0) return true;
  try {
    const database = db ?? getDb();
    claimColumns(database);
    const row = database.prepare('SELECT subtitle_write_token AS token, subtitle_write_until AS until FROM summaries WHERE id=?').get(summaryId) as { token: string | null; until: number | null } | undefined;
    return !!row?.token && typeof row.until === 'number' && row.until >= now;
  } catch { return false; }
}
