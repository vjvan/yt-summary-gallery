/** Cross-route/process leases: raw downloads and manual attachments must not race. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type MediaOperation = 'download' | 'attach';
const LEASE_MS = 30 * 60 * 1000; // Both operations have shorter, enforced execution timeouts.

export function ensureMediaOperationSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS summary_media_operations (
    summary_id TEXT PRIMARY KEY, kind TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS summary_video_attachments (
    summary_id TEXT PRIMARY KEY, video_url TEXT NOT NULL, bytes INTEGER NOT NULL,
    duration REAL NOT NULL, source_duration REAL NOT NULL, subtitle_end REAL NOT NULL,
    rights_confirmed INTEGER NOT NULL, timeline_confirmation TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
}

export function activeMediaOperation(db: Database.Database, id: string): MediaOperation | null {
  ensureMediaOperationSchema(db);
  return (db.prepare('SELECT kind FROM summary_media_operations WHERE summary_id=? AND expires_at>?').get(id, Date.now()) as { kind: MediaOperation } | undefined)?.kind || null;
}

export function acquireMediaOperation(db: Database.Database, id: string, kind: MediaOperation): string | null {
  ensureMediaOperationSchema(db);
  return db.transaction(() => {
    db.prepare('DELETE FROM summary_media_operations WHERE summary_id=? AND expires_at<=?').run(id, Date.now());
    const token = randomUUID();
    const result = db.prepare('INSERT OR IGNORE INTO summary_media_operations (summary_id,kind,token,expires_at) VALUES (?,?,?,?)').run(id, kind, token, Date.now() + LEASE_MS);
    return result.changes === 1 ? token : null;
  }).immediate();
}

export function ownsMediaOperation(db: Database.Database, id: string, token: string) {
  return !!db.prepare('SELECT 1 FROM summary_media_operations WHERE summary_id=? AND token=? AND expires_at>?').get(id, token, Date.now());
}

export function releaseMediaOperation(db: Database.Database, id: string, token: string) {
  db.prepare('DELETE FROM summary_media_operations WHERE summary_id=? AND token=?').run(id, token);
}
