import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "summaries.db");

let db: Database.Database;

export function getDb() {
  if (!db) {
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

    // Layer 3 護城河: 個人筆記 (annotations) — 累積在這個工具裡的個人化 lock-in 資料
    db.exec(`
      CREATE TABLE IF NOT EXISTS annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_annotations_video ON annotations(video_id, timestamp)`);

    // Layer 7 護城河: is_featured 欄位給 curated 公開頁用
    addCol("is_featured", "INTEGER DEFAULT 0");
    addCol("featured_note", "TEXT"); // 允雷對這支影片的個人推薦理由

    // Jobs 持久化: pipeline 階段 checkpoint,server 重啟後從斷點續跑
    // 值: NULL(尚未轉錄完) → 'transcribed' → 'translated' → 'summarized' → 'done'
    addCol("pipeline_stage", "TEXT");

    // 燒錄語系選擇: bi(雙語,沿用 burned_video_url) / zh / en 各自獨立輸出
    addCol("burned_zh_url", "TEXT");
    addCol("burned_en_url", "TEXT");
    addCol("burn_track", "TEXT");  // 目前/上次燒錄的語系
    addCol("auto_burn", "TEXT");   // 上傳時勾「完成後自動燒錄」: 'bi'|'zh'|'en'
  }
  return db;
}

export interface AnnotationRow {
  id: number;
  video_id: string;
  timestamp: number;
  body: string;
  created_at: string;
  updated_at: string;
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
  is_featured: number;
  featured_note: string | null;
  pipeline_stage: string | null;
  burned_zh_url: string | null;
  burned_en_url: string | null;
  burn_track: string | null;
  auto_burn: string | null;
}
