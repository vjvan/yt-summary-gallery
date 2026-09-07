/**
 * 語意校訂的持久層：一部影片一筆 run、候選逐句一列、檢查點可重試、
 * 套用時把「舊譯文 → 新譯文」逐句記進 subtitle_revisions，隨時可還原上一批。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { CandidateDecision, ReviewCandidate, ReviewProgress, ReviewStatus } from './types';

export const REVIEW_LEASE_MS = 180_000;

export class ReviewInputError extends Error { constructor(message: string, public status = 400) { super(message); this.name = 'ReviewInputError'; } }

export function migrateSubtitleReviewStorage(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subtitle_reviews (
      summary_id TEXT PRIMARY KEY, status TEXT NOT NULL, source_hash TEXT, model TEXT, version TEXT,
      progress_json TEXT NOT NULL, error TEXT, run_token TEXT, last_applied_at TEXT, export_error TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS subtitle_review_candidates (
      summary_id TEXT NOT NULL, source_hash TEXT NOT NULL, cue_index INTEGER NOT NULL, cue_id TEXT NOT NULL, window_key TEXT NOT NULL,
      start REAL NOT NULL, end REAL NOT NULL, source TEXT NOT NULL, current TEXT, candidate TEXT NOT NULL,
      flags_json TEXT NOT NULL DEFAULT '[]', notes_json TEXT NOT NULL DEFAULT '[]', changed INTEGER NOT NULL DEFAULT 1,
      decision TEXT NOT NULL DEFAULT 'candidate', model TEXT, created_at INTEGER NOT NULL, decided_at INTEGER,
      PRIMARY KEY(summary_id, source_hash, cue_index)
    );
    CREATE TABLE IF NOT EXISTS subtitle_review_checkpoints (
      summary_id TEXT NOT NULL, cache_key TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(summary_id, cache_key)
    );
    CREATE TABLE IF NOT EXISTS subtitle_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, summary_id TEXT NOT NULL, batch_id TEXT NOT NULL, cue_index INTEGER NOT NULL,
      source_text TEXT NOT NULL, previous_text TEXT, next_text TEXT NOT NULL, source_hash TEXT NOT NULL, applied_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS subtitle_revisions_summary ON subtitle_revisions(summary_id, batch_id);
  `);
  // 同一天內建過表的資料庫沒有這欄；SQLite 只能 ADD COLUMN，已存在會丟錯，吞掉即可。
  try { db.exec('ALTER TABLE subtitle_reviews ADD COLUMN export_error TEXT'); } catch { /* already exists */ }
}

export interface ReviewRunRow {
  summary_id: string; status: ReviewStatus; source_hash: string | null; model: string | null; version: string | null;
  progress_json: string; error: string | null; run_token: string | null; last_applied_at: string | null; export_error: string | null; updated_at: number;
}
interface CandidateRow {
  cue_index: number; cue_id: string; window_key: string; start: number; end: number; source: string; current: string | null; candidate: string;
  flags_json: string; notes_json: string; changed: number; decision: CandidateDecision;
}

export const idleReviewProgress = (): ReviewProgress => ({ stage: 'idle', completed: 0, total: 0, message: '尚未啟動；閱讀此頁不會呼叫模型。' });

export class SubtitleReviewStore {
  constructor(readonly db: Database.Database) { migrateSubtitleReviewStorage(db); }

  row(id: string): ReviewRunRow | undefined {
    return this.db.prepare('SELECT * FROM subtitle_reviews WHERE summary_id=?').get(id) as ReviewRunRow | undefined;
  }

  recoverExpired(now = Date.now()) {
    this.db.prepare("UPDATE subtitle_reviews SET status='failed', error=?, run_token=NULL WHERE status='running' AND updated_at<?")
      .run('校訂工作中斷或服務已重啟；已產生的候選與檢查點都保留，可手動繼續。', now - REVIEW_LEASE_MS);
  }

  candidates(id: string, sourceHash: string): ReviewCandidate[] {
    const rows = this.db.prepare('SELECT * FROM subtitle_review_candidates WHERE summary_id=? AND source_hash=? ORDER BY cue_index').all(id, sourceHash) as CandidateRow[];
    return rows.map(row => ({
      cueIndex: row.cue_index, cueId: row.cue_id, windowKey: row.window_key, start: row.start, end: row.end, source: row.source, current: row.current,
      candidate: row.candidate, flags: JSON.parse(row.flags_json), notes: JSON.parse(row.notes_json), changed: row.changed === 1, decision: row.decision,
    }));
  }

  start(id: string, sourceHash: string, model: string, version: string, total: number): { started: boolean; token: string | null } {
    return this.db.transaction(() => {
      this.recoverExpired();
      const row = this.row(id);
      if (row?.status === 'running') return { started: false, token: row.run_token };
      const busy = this.db.prepare("SELECT summary_id FROM subtitle_reviews WHERE status='running' LIMIT 1").get();
      if (busy) throw new ReviewInputError('另一部影片的語意校訂正在執行；請等它完成或取消後再試。', 409);
      const token = randomUUID();
      const progress: ReviewProgress = { stage: 'planning', completed: 0, total, message: `已手動啟動，準備重譯 ${total} 個話語視窗。` };
      this.db.prepare(`INSERT INTO subtitle_reviews(summary_id,status,source_hash,model,version,progress_json,error,run_token,updated_at) VALUES(?,'running',?,?,?,?,NULL,?,?)
        ON CONFLICT(summary_id) DO UPDATE SET status='running',source_hash=excluded.source_hash,model=excluded.model,version=excluded.version,progress_json=excluded.progress_json,error=NULL,run_token=excluded.run_token,updated_at=excluded.updated_at`)
        .run(id, sourceHash, model, version, JSON.stringify(progress), token, Date.now());
      return { started: true, token };
    })();
  }

  active(id: string, token: string): boolean { const row = this.row(id); return row?.status === 'running' && row.run_token === token; }

  progress(id: string, token: string, progress: ReviewProgress) {
    this.db.prepare("UPDATE subtitle_reviews SET progress_json=?,updated_at=? WHERE summary_id=? AND run_token=? AND status='running'")
      .run(JSON.stringify(progress), Date.now(), id, token);
  }

  checkpoint(id: string, key: string): unknown | undefined {
    const row = this.db.prepare('SELECT payload_json FROM subtitle_review_checkpoints WHERE summary_id=? AND cache_key=?').get(id, key) as { payload_json: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.payload_json); } catch { return undefined; }
  }

  saveCheckpoint(id: string, token: string, key: string, value: unknown) {
    this.db.transaction(() => {
      if (!this.active(id, token)) throw new ReviewInputError('校訂工作已取消。', 409);
      this.db.prepare('INSERT INTO subtitle_review_checkpoints(summary_id,cache_key,payload_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(summary_id,cache_key) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at')
        .run(id, key, JSON.stringify(value), Date.now());
    })();
  }

  /** 新候選覆蓋同句舊候選，但已採用／已套用的決定不會被新一輪洗掉。 */
  saveCandidates(id: string, token: string, sourceHash: string, model: string, candidates: ReviewCandidate[]) {
    const insert = this.db.prepare(`INSERT INTO subtitle_review_candidates(summary_id,source_hash,cue_index,cue_id,window_key,start,end,source,current,candidate,flags_json,notes_json,changed,decision,model,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'candidate',?,?)
      ON CONFLICT(summary_id,source_hash,cue_index) DO UPDATE SET candidate=excluded.candidate, current=excluded.current, flags_json=excluded.flags_json, notes_json=excluded.notes_json,
        changed=excluded.changed, model=excluded.model, created_at=excluded.created_at,
        decision=CASE WHEN subtitle_review_candidates.decision IN ('approved','applied') AND subtitle_review_candidates.candidate=excluded.candidate THEN subtitle_review_candidates.decision ELSE 'candidate' END,
        decided_at=CASE WHEN subtitle_review_candidates.decision IN ('approved','applied') AND subtitle_review_candidates.candidate=excluded.candidate THEN subtitle_review_candidates.decided_at ELSE NULL END`);
    this.db.transaction(() => {
      if (!this.active(id, token)) throw new ReviewInputError('校訂工作已取消。', 409);
      const now = Date.now();
      for (const item of candidates) {
        insert.run(id, sourceHash, item.cueIndex, item.cueId, item.windowKey, item.start, item.end, item.source, item.current, item.candidate,
          JSON.stringify(item.flags), JSON.stringify(item.notes), item.changed ? 1 : 0, model, now);
      }
    })();
  }

  finish(id: string, token: string, progress: ReviewProgress, partial: boolean) {
    this.db.prepare("UPDATE subtitle_reviews SET status=?,progress_json=?,error=NULL,run_token=NULL,updated_at=? WHERE summary_id=? AND run_token=? AND status='running'")
      .run(partial ? 'partial' : 'complete', JSON.stringify(progress), Date.now(), id, token);
  }

  fail(id: string, token: string, message: string) {
    this.db.prepare("UPDATE subtitle_reviews SET status='failed',error=?,run_token=NULL,updated_at=? WHERE summary_id=? AND run_token=? AND status='running'")
      .run(message, Date.now(), id, token);
  }

  cancel(id: string) {
    this.db.prepare("UPDATE subtitle_reviews SET status='cancelled',error=?,run_token=NULL,updated_at=? WHERE summary_id=? AND status='running'")
      .run('已取消；已產生的候選與檢查點都保留，可手動繼續。', Date.now(), id);
  }

  decide(id: string, sourceHash: string, cueIndexes: number[], decision: 'approved' | 'rejected' | 'candidate', options: { includeApplied?: boolean } = {}): number {
    const update = this.db.prepare(options.includeApplied
      ? 'UPDATE subtitle_review_candidates SET decision=?, decided_at=? WHERE summary_id=? AND source_hash=? AND cue_index=?'
      : "UPDATE subtitle_review_candidates SET decision=?, decided_at=? WHERE summary_id=? AND source_hash=? AND cue_index=? AND decision!='applied'");
    return this.db.transaction(() => {
      let changes = 0;
      for (const cueIndex of cueIndexes) changes += update.run(decision, decision === 'candidate' ? null : Date.now(), id, sourceHash, cueIndex).changes;
      return changes;
    })();
  }

  approved(id: string, sourceHash: string): ReviewCandidate[] {
    return this.candidates(id, sourceHash).filter(item => item.decision === 'approved');
  }

  /** 套用：記錄每句的舊譯文與新譯文，並把候選標成 applied。真正改字幕由 service 在同一交易內做。 */
  recordApplied(id: string, sourceHash: string, batchId: string, items: Array<{ cueIndex: number; sourceText: string; previousText: string | null; nextText: string }>, appliedAt: string) {
    const insert = this.db.prepare('INSERT INTO subtitle_revisions(summary_id,batch_id,cue_index,source_text,previous_text,next_text,source_hash,applied_at) VALUES(?,?,?,?,?,?,?,?)');
    const mark = this.db.prepare("UPDATE subtitle_review_candidates SET decision='applied', decided_at=? WHERE summary_id=? AND source_hash=? AND cue_index=?");
    for (const item of items) {
      insert.run(id, batchId, item.cueIndex, item.sourceText, item.previousText, item.nextText, sourceHash, appliedAt);
      mark.run(Date.now(), id, sourceHash, item.cueIndex);
    }
    this.db.prepare('UPDATE subtitle_reviews SET last_applied_at=?, updated_at=? WHERE summary_id=?').run(appliedAt, Date.now(), id);
  }

  lastBatch(id: string): { batchId: string; sourceHash: string; items: Array<{ cueIndex: number; previousText: string | null; nextText: string }> } | null {
    const head = this.db.prepare('SELECT batch_id, source_hash FROM subtitle_revisions WHERE summary_id=? ORDER BY id DESC LIMIT 1').get(id) as { batch_id: string; source_hash: string } | undefined;
    if (!head) return null;
    const rows = this.db.prepare('SELECT cue_index, previous_text, next_text FROM subtitle_revisions WHERE summary_id=? AND batch_id=?').all(id, head.batch_id) as Array<{ cue_index: number; previous_text: string | null; next_text: string }>;
    return { batchId: head.batch_id, sourceHash: head.source_hash, items: rows.map(row => ({ cueIndex: row.cue_index, previousText: row.previous_text, nextText: row.next_text })) };
  }

  /** 還原：刪掉該批紀錄，候選退回 approved（讓人可以再決定）。 */
  recordReverted(id: string, batchId: string, sourceHash: string, cueIndexes: number[]) {
    this.db.prepare('DELETE FROM subtitle_revisions WHERE summary_id=? AND batch_id=?').run(id, batchId);
    const mark = this.db.prepare("UPDATE subtitle_review_candidates SET decision='approved' WHERE summary_id=? AND source_hash=? AND cue_index=? AND decision='applied'");
    for (const cueIndex of cueIndexes) mark.run(id, sourceHash, cueIndex);
    const previous = this.db.prepare('SELECT applied_at FROM subtitle_revisions WHERE summary_id=? ORDER BY id DESC LIMIT 1').get(id) as { applied_at: string } | undefined;
    this.db.prepare('UPDATE subtitle_reviews SET last_applied_at=?, updated_at=? WHERE summary_id=?').run(previous?.applied_at ?? null, Date.now(), id);
  }

  /** 文字已經跟候選一樣的核准句：不寫版本，但標成已寫回，免得永遠停在「已採用」。 */
  markApplied(id: string, sourceHash: string, cueIndexes: number[]) {
    const mark = this.db.prepare("UPDATE subtitle_review_candidates SET decision='applied', decided_at=? WHERE summary_id=? AND source_hash=? AND cue_index=?");
    for (const cueIndex of cueIndexes) mark.run(Date.now(), id, sourceHash, cueIndex);
  }

  setExportError(id: string, message: string | null) {
    this.db.prepare('UPDATE subtitle_reviews SET export_error=?, updated_at=? WHERE summary_id=?').run(message, Date.now(), id);
  }

  revisionCount(id: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM subtitle_revisions WHERE summary_id=?').get(id) as { n: number }).n;
  }
}
