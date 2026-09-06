import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { TranslatedCue, WatchCue, WatchProcessingMode } from './types';
import { WatchError } from './errors';

/** Match canonical provenance, not just an ID or a nonempty model string. */
export function translationMatchesSource(value: unknown, source: WatchCue): value is TranslatedCue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cue = value as Partial<TranslatedCue>;
  return Object.keys(value).sort().join() === 'end,id,originalText,start,text'
    && cue.id === source.id && cue.start === source.start && cue.end === source.end
    && cue.originalText === source.text && typeof cue.text === 'string'
    && cue.text.trim().length > 0 && cue.text.length <= 8000 && !/[\r\n]/.test(cue.text);
}

export class WatchStore {
  private db: Database.Database;
  constructor(filename = path.join(process.cwd(), 'data', 'watch.db')) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watch_cache (cache_key TEXT PRIMARY KEY, cues TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS watch_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS watch_local_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0);
    `);
  }
  get(key: string): TranslatedCue[] | undefined {
    const row = this.db.prepare('SELECT cues FROM watch_cache WHERE cache_key = ?').get(key) as { cues: string } | undefined;
    if (!row) return;
    try {
      const cues: unknown = JSON.parse(row.cues);
      if (!Array.isArray(cues) || !cues.every(cue => cue && typeof cue === 'object'
        && typeof cue.id === 'string' && typeof cue.text === 'string' && cue.text.trim()
        && typeof cue.originalText === 'string' && Number.isFinite(cue.start) && Number.isFinite(cue.end)
        && cue.start >= 0 && cue.end > cue.start)) return;
      return cues;
    } catch { return; }
  }
  put(key: string, cues: TranslatedCue[]) {
    this.db.prepare('INSERT OR REPLACE INTO watch_cache(cache_key, cues) VALUES (?, ?)').run(key, JSON.stringify(cues));
  }
  /** Invalid, reordered or cross-source cache data is a miss, never displayed. */
  getMatching(key: string, sources: WatchCue[]): TranslatedCue[] | undefined {
    const cues = this.get(key);
    return cues && cues.length === sources.length && cues.every((cue, index) => translationMatchesSource(cue, sources[index])) ? cues : undefined;
  }
  getCue(key: string, source: WatchCue): TranslatedCue | undefined {
    return this.getMatching(key, [source])?.[0];
  }
  putCue(key: string, source: WatchCue, cue: TranslatedCue) {
    if (!translationMatchesSource(cue, source)) throw new WatchError('INVALID_TRANSLATION', '字幕資料與原文不符，未寫入成功快取。', 502);
    this.put(key, [cue]);
  }
  private day() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  used(mode: WatchProcessingMode = 'cloud') {
    const table = mode === 'local' ? 'watch_local_usage' : 'watch_usage';
    return (this.db.prepare(`SELECT calls FROM ${table} WHERE day = ?`).get(this.day()) as { calls: number } | undefined)?.calls || 0;
  }
  reserve(limit: number | null, mode: WatchProcessingMode = 'cloud') {
    if (mode === 'cloud' && (!Number.isInteger(limit) || limit === null || limit < 1)) throw new WatchError('INVALID_LIMIT', '雲端翻譯必須設定有效批次上限。', 503);
    const table = mode === 'local' ? 'watch_local_usage' : 'watch_usage';
    return this.db.transaction(() => {
      const used = this.used(mode);
      if (mode === 'cloud' && limit !== null && used >= limit) throw new WatchError('DAILY_LIMIT', '已達每日翻譯批次上限；快取仍可使用。', 429);
      this.db.prepare(`INSERT INTO ${table}(day,calls) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1`).run(this.day());
      return used + 1;
    })();
  }
  close() { this.db.close(); }
}
