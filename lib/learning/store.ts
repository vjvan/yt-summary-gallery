import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { LEARNING_VERSION } from './types';
import type { LearningAnalysis, LearningPatchPayload, LearningProgress, LearningResponse, LearningStatus, LearningImplementation } from './types';
import { LearningInputError } from './validation';
export const LEARNING_LEASE_MS = 180_000;
export function migrateLearningStorage(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_analyses (
      summary_id TEXT PRIMARY KEY, status TEXT NOT NULL, source_hash TEXT, model TEXT,
      progress_json TEXT NOT NULL, analysis_json TEXT, error TEXT, run_token TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_checkpoints (
      summary_id TEXT NOT NULL, cache_key TEXT NOT NULL, payload_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY(summary_id, cache_key)
    );
    CREATE TABLE IF NOT EXISTS learning_point_reviews (
      summary_id TEXT NOT NULL, source_hash TEXT NOT NULL, point_id TEXT NOT NULL,
      disposition TEXT, reason TEXT, implementation_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL, PRIMARY KEY(summary_id, source_hash, point_id)
    );
  `);
}
interface RunRow { summary_id: string; status: LearningStatus; progress_json: string; analysis_json: string | null; error: string | null; run_token: string | null; updated_at: number; source_hash: string; model: string }
interface ReviewRow { point_id: string; disposition: LearningPatchPayload['disposition'] | null; reason: string | null; implementation_json: string }
const idleProgress = (): LearningProgress => ({ stage: 'idle', completed: 0, total: 0, message: '尚未啟動；閱讀此頁不會呼叫模型。' });
export class LearningStore {
  constructor(readonly db: Database.Database) { migrateLearningStorage(db); }
  row(id: string): RunRow | undefined { return this.db.prepare('SELECT * FROM learning_analyses WHERE summary_id=?').get(id) as RunRow | undefined; }
  recoverExpired(now = Date.now()) {
    this.db.prepare("UPDATE learning_analyses SET status='failed', error=?, run_token=NULL WHERE status='running' AND updated_at<?")
      .run('工作中斷或服務已重啟；已保留先前分析與檢查點，請手動重試。', now - LEARNING_LEASE_MS);
  }
  get(id: string): LearningResponse {
    this.recoverExpired(); const row = this.row(id);
    if (!row) return { status: 'idle', progress: idleProgress(), analysis: null, error: null };
    const analysis = row.analysis_json ? JSON.parse(row.analysis_json) as LearningAnalysis : null;
    if (analysis) {
      const reviews = this.db.prepare('SELECT point_id,disposition,reason,implementation_json FROM learning_point_reviews WHERE summary_id=? AND source_hash=?').all(id, analysis.sourceHash) as ReviewRow[];
      analysis.points = analysis.points.map(point => {
        const review = reviews.find(item => item.point_id === point.id);
        return review ? { ...point, disposition: review.disposition || point.disposition, reason: review.reason ?? point.reason, implementationRecords: JSON.parse(review.implementation_json) } : point;
      });
    }
    return { status: row.status, progress: JSON.parse(row.progress_json), analysis, error: row.error };
  }
  start(id: string, sourceHash: string, model: string): { started: boolean; token: string | null } {
    return this.db.transaction(() => {
      this.recoverExpired();
      const row = this.row(id);
      if (row?.status === 'running') return { started: false, token: row.run_token };
      if (row?.status === 'complete' && row.source_hash === sourceHash && row.model === model && row.analysis_json && (JSON.parse(row.analysis_json) as LearningAnalysis).version === LEARNING_VERSION) return { started: false, token: null };
      const busy = this.db.prepare("SELECT summary_id FROM learning_analyses WHERE status='running' LIMIT 1").get();
      if (busy) throw new LearningInputError('另一片學習分析正在執行；請完成或取消後再試。', 409);
      const token = randomUUID(); const progress: LearningProgress = { stage: 'extracting', completed: 0, total: 0, message: '已手動啟動，準備逐段核對原文。' };
      this.db.prepare(`INSERT INTO learning_analyses(summary_id,status,source_hash,model,progress_json,error,run_token,updated_at) VALUES(?,'running',?,?,?,NULL,?,?)
        ON CONFLICT(summary_id) DO UPDATE SET status='running',source_hash=excluded.source_hash,model=excluded.model,progress_json=excluded.progress_json,error=NULL,run_token=excluded.run_token,updated_at=excluded.updated_at`)
        .run(id, sourceHash, model, JSON.stringify(progress), token, Date.now());
      return { started: true, token };
    })();
  }
  active(id: string, token: string): boolean { const row = this.row(id); return row?.status === 'running' && row.run_token === token; }
  progress(id: string, token: string, progress: LearningProgress) {
    this.db.prepare("UPDATE learning_analyses SET progress_json=?,updated_at=? WHERE summary_id=? AND run_token=? AND status='running'")
      .run(JSON.stringify(progress), Date.now(), id, token);
  }
  checkpoint(id: string, key: string): unknown | undefined {
    const row = this.db.prepare('SELECT payload_json FROM learning_checkpoints WHERE summary_id=? AND cache_key=?').get(id, key) as { payload_json: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.payload_json); } catch { return undefined; }
  }
  saveCheckpoint(id: string, token: string, key: string, value: unknown) {
    this.db.transaction(() => {
      if (!this.active(id, token)) throw new LearningInputError('工作已取消。', 409);
      this.db.prepare('INSERT INTO learning_checkpoints(summary_id,cache_key,payload_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(summary_id,cache_key) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at')
        .run(id, key, JSON.stringify(value), Date.now());
    })();
  }
  finish(id: string, token: string, analysis: LearningAnalysis, partial: boolean) {
    const progress: LearningProgress = { stage: 'complete', completed: analysis.points.length, total: analysis.points.length, message: partial ? '部分完成；請查看涵蓋範圍與缺漏，重試會沿用有效檢查點。' : '分析草稿已完成；仍需自行核對來源與實作成效。' };
    this.db.prepare("UPDATE learning_analyses SET status=?,analysis_json=?,progress_json=?,error=NULL,run_token=NULL,updated_at=? WHERE summary_id=? AND run_token=? AND status='running'")
      .run(partial ? 'partial' : 'complete', JSON.stringify(analysis), JSON.stringify(progress), Date.now(), id, token);
  }
  fail(id: string, token: string, message: string) {
    this.db.prepare("UPDATE learning_analyses SET status='failed',error=?,run_token=NULL,updated_at=? WHERE summary_id=? AND run_token=? AND status='running'")
      .run(message, Date.now(), id, token); // analysis_json is deliberately untouched.
  }
  cancel(id: string) {
    this.db.prepare("UPDATE learning_analyses SET status='cancelled',error=?,run_token=NULL,updated_at=? WHERE summary_id=? AND status='running'")
      .run('已取消；先前分析及已完成檢查點均保留，可手動重試。', Date.now(), id);
  }
  patch(id: string, body: LearningPatchPayload): LearningResponse {
    this.db.transaction(() => {
      const analysis = this.get(id).analysis;
      if (!analysis || analysis.sourceHash !== body.sourceHash) throw new LearningInputError('分析版本已變更或尚未產生，請重新載入後再儲存。', 409);
      if (!analysis.points.some(point => point.id === body.pointId)) throw new LearningInputError('找不到指定學習重點。', 404);
      const existing = this.db.prepare('SELECT point_id,disposition,reason,implementation_json FROM learning_point_reviews WHERE summary_id=? AND source_hash=? AND point_id=?').get(id, body.sourceHash, body.pointId) as ReviewRow | undefined;
      const records: LearningImplementation[] = existing ? JSON.parse(existing.implementation_json) : [];
      if (body.implementation) {
        if (records.length >= 50) throw new LearningInputError('本重點已達 50 筆實作紀錄上限。', 409);
        records.push({ id: randomUUID(), action: body.implementation.action, result: body.implementation.result, observedAt: body.implementation.observedAt, createdAt: new Date().toISOString() });
      }
      this.db.prepare(`INSERT INTO learning_point_reviews(summary_id,source_hash,point_id,disposition,reason,implementation_json,updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(summary_id,source_hash,point_id) DO UPDATE SET disposition=excluded.disposition,reason=excluded.reason,implementation_json=excluded.implementation_json,updated_at=excluded.updated_at`)
        .run(id, body.sourceHash, body.pointId, body.disposition ?? existing?.disposition ?? null, body.reason ?? existing?.reason ?? null, JSON.stringify(records), Date.now());
    })();
    return this.get(id);
  }
}
