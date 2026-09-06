import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { WatchError } from './errors';
/** Audio bytes/transcripts are never stored here: only conservative daily request counts. */
export class AudioUsageStore {
  private db: Database.Database;
  constructor(filename = path.join(process.cwd(), 'data', 'watch.db')) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS watch_audio_usage (day TEXT PRIMARY KEY, chunks INTEGER NOT NULL DEFAULT 0)');
  }
  private day() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  used() { return (this.db.prepare('SELECT chunks FROM watch_audio_usage WHERE day = ?').get(this.day()) as { chunks: number } | undefined)?.chunks || 0; }
  reserve(limit: number) {
    return this.db.transaction(() => {
      const day = this.day();
      const used = (this.db.prepare('SELECT chunks FROM watch_audio_usage WHERE day = ?').get(day) as { chunks: number } | undefined)?.chunks || 0;
      if (used >= limit) throw new WatchError('AUDIO_DAILY_LIMIT', '已達每日音訊辨識上限；已完成的字幕仍可觀看。', 429);
      this.db.prepare('INSERT INTO watch_audio_usage(day,chunks) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET chunks=chunks+1').run(day);
      return used + 1;
    })();
  }
  close() { this.db.close(); }
}
