/**
 * Glossary 持久化:讀寫 settings 表的 'glossary' key。
 * 第一次讀取時若 DB 無資料,自動 seed 預設值。
 */

import { getDb } from "./db";
import { DEFAULT_GLOSSARY, type Glossary } from "./glossary-defaults";

const KEY = "glossary";

function isValidGlossary(g: unknown): g is Glossary {
  if (!g || typeof g !== "object") return false;
  const x = g as Glossary;
  if (!Array.isArray(x.no_translate_terms)) return false;
  if (!Array.isArray(x.term_map)) return false;
  if (!Array.isArray(x.style_rules)) return false;
  if (x.no_translate_terms.some((t) => typeof t !== "string")) return false;
  if (x.style_rules.some((t) => typeof t !== "string")) return false;
  if (x.term_map.some((p) => !Array.isArray(p) || p.length !== 2 ||
    typeof p[0] !== "string" || typeof p[1] !== "string")) return false;
  return true;
}

export function getGlossary(): Glossary {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(KEY) as { value: string } | undefined;

  if (!row) {
    // 第一次跑,seed defaults
    saveGlossary(DEFAULT_GLOSSARY);
    return DEFAULT_GLOSSARY;
  }

  try {
    const parsed = JSON.parse(row.value);
    if (isValidGlossary(parsed)) return parsed;
  } catch { /* fall through */ }

  // 壞資料,還原預設(不覆寫,避免使用者誤刪;但 caller 拿到能用的東西)
  return DEFAULT_GLOSSARY;
}

export function saveGlossary(g: Glossary): void {
  if (!isValidGlossary(g)) {
    throw new Error("Invalid glossary shape");
  }
  const db = getDb();
  // 去重 + trim
  const cleaned: Glossary = {
    no_translate_terms: Array.from(new Set(g.no_translate_terms.map((t) => t.trim()).filter(Boolean))),
    term_map: g.term_map
      .map(([en, zh]) => [en.trim(), zh.trim()] as [string, string])
      .filter(([en, zh]) => en && zh),
    style_rules: g.style_rules.map((r) => r.trim()).filter(Boolean),
  };
  const value = JSON.stringify(cleaned);
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(KEY, value);
}

export function resetGlossary(): Glossary {
  saveGlossary(DEFAULT_GLOSSARY);
  return DEFAULT_GLOSSARY;
}
