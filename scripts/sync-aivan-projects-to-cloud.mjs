import Database from "better-sqlite3";
import path from "node:path";

const localBase = new URL(process.env.LOCAL_YT_SUMMARY_URL || "http://127.0.0.1:3000/");
const dbPath = path.join(process.cwd(), "data", "summaries.db");
const db = new Database(dbPath, { readonly: true });

const rows = db.prepare(`
  SELECT id, title
  FROM summaries
  WHERE status = 'done' AND summary IS NOT NULL
  ORDER BY created_at ASC
`).all();

if (!rows.length) {
  console.log("沒有可同步的 YT Summary 專案。");
  process.exit(0);
}

let synced = 0;
for (const row of rows) {
  const endpoint = new URL(`/api/summaries/${row.id}/aivan-cloud-link`, localBase);
  const response = await fetch(endpoint, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${row.id} 同步失敗：${body.error || `HTTP ${response.status}`}`);
  }

  const projectUrl = new URL(body.projectUrl);
  console.log(`PASS ${row.id}｜${row.title || "未命名"}｜${projectUrl.origin}${projectUrl.pathname}?access=<redacted>`);
  synced += 1;
}

console.log(`同步完成：${synced}/${rows.length} 個 Project JSON 已送往雲端。`);
