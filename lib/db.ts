import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "summaries.db");

let db: Database.Database;

export function getDb() {
  if (!db) {
    const fs = require("fs");
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");

    db.exec(`
      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        video_id TEXT UNIQUE NOT NULL,
        url TEXT NOT NULL,
        source TEXT DEFAULT 'youtube',
        title TEXT,
        channel TEXT,
        duration INTEGER,
        duration_display TEXT,
        thumbnail_url TEXT,
        transcript TEXT,
        segments TEXT,
        transcript_zh TEXT,
        segments_zh TEXT,
        is_translated INTEGER DEFAULT 0,
        audio_url TEXT,
        transcript_source TEXT,
        summary TEXT,
        card_paths TEXT,
        slide_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'processing',
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        is_video INTEGER DEFAULT 0,
        video_url TEXT,
        srt_en_path TEXT,
        srt_zh_path TEXT,
        srt_bi_path TEXT,
        burned_video_url TEXT
      )
    `);

    // Idempotent column add for existing DBs (SQLite ALTER allows ADD COLUMN only)
    const addCol = (col: string, def: string) => {
      try { db.exec(`ALTER TABLE summaries ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
    };
    addCol("is_video", "INTEGER DEFAULT 0");
    addCol("video_url", "TEXT");
    addCol("srt_en_path", "TEXT");
    addCol("srt_zh_path", "TEXT");
    addCol("srt_bi_path", "TEXT");
    addCol("burned_video_url", "TEXT");
    // Burn 流程獨立於主 pipeline,不阻塞 status=done
    addCol("burn_status", "TEXT");
    addCol("burn_error", "TEXT");

    // Remix projects
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'uploading',
        error TEXT,
        total_duration REAL DEFAULT 0,
        total_duration_display TEXT,
        combined_transcript TEXT,
        combined_summary TEXT,
        card_paths TEXT,
        slide_count INTEGER DEFAULT 0,
        video_path TEXT,
        video_script TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS project_clips (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT,
        duration REAL DEFAULT 0,
        duration_display TEXT,
        transcript TEXT,
        segments TEXT,
        status TEXT DEFAULT 'pending',
        error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // 通用 key/value 設定表(目前用來存 glossary,以後可放其他使用者偏好)
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }
  return db;
}

export interface SummaryRow {
  id: string;
  video_id: string;
  url: string;
  source: string;
  title: string;
  channel: string;
  duration: number;
  duration_display: string;
  thumbnail_url: string;
  audio_url: string | null;
  transcript: string;
  segments: string;
  transcript_zh: string | null;
  segments_zh: string | null;
  is_translated: number;
  transcript_source: string;
  summary: string;
  card_paths: string;
  slide_count: number;
  status: string;
  error: string | null;
  created_at: string;
  is_video: number;
  video_url: string | null;
  srt_en_path: string | null;
  srt_zh_path: string | null;
  srt_bi_path: string | null;
  burned_video_url: string | null;
  burn_status: string | null;
  burn_error: string | null;
}
