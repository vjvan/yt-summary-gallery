/**
 * 從影片逐字稿萃取結構化摘要 (給 20 頁社群學習卡用)。
 *
 * v2 設計原則: 卡片要對應「使用者完成的事」,所以 summary 結構也要分三層:
 *  - 獲取層 (encoding): tldr_paragraph / key_points / highlights
 *  - 實作層 (transfer): action_items (升級含 expected_outcome + time_estimate) / pitfalls
 *  - 記憶層 (retention): key_quote / recall_questions
 *
 * 加 video_genre 是為了智能布局: 不同類型影片走不同卡組 preset,避免每張影片強塞 9 卡。
 *
 * augmentSummary 給舊資料 lazy upgrade 用: 只算缺的新欄位,不重跑既有 key_points / highlights 等,省 GPT cost。
 *
 * Layer 2 護城河: prompt 從外部檔案載入 (prompts/*.txt 已 gitignore),env var 指路徑,
 * 找不到就 fallback 到 baked demo 版 (功能可用但缺核心對齊邏輯,給 self-host 學員看的版本)。
 * 詳見 references/sops/yt-tool-moat-architecture.md Layer 2。
 *
 * Layer 4 護城河: PROMPT_VERSION 寫進每筆 summary,給未來 A/B test 跟版本溯源用。
 * 改 prompt 時必加 patch number,讓模仿者永遠落後一個版本。
 */

import fs from "fs";
import path from "path";
import { processingMode } from "../watch/provider";

export const PROMPT_VERSION = "v3.0-social-20";

/**
 * 從外部檔案載入 prompt,失敗 fallback 到 demo 版。
 * 完整 production prompt 放 prompts/*.txt (gitignored),只有訂閱者拿得到。
 */
function loadPromptOrFallback(envVar: string, defaultPath: string, fallback: string): string {
  const customPath = process.env[envVar];
  const resolvedPath = customPath
    ? path.resolve(customPath)
    : path.join(process.cwd(), defaultPath);
  try {
    if (fs.existsSync(resolvedPath)) {
      return fs.readFileSync(resolvedPath, "utf-8");
    }
  } catch {
    /* fallthrough to fallback */
  }
  return fallback;
}

// === Demo 版 prompt (50% 能力,給 self-host 學員 / 公開 repo 用) ===
// 完整 production 版在 prompts/extract-system.txt (gitignored)
const SYSTEM_PROMPT_DEMO = `你是一個影片內容摘要工具。讀逐字稿產出結構化 JSON 繁體中文摘要。

輸出格式:
{
  "title_display": "卡片標題 15字內",
  "one_liner": "一句話總結 20字內",
  "tldr_paragraph": "段落式 TL;DR 80-120字",
  "key_points": [{"label":"標籤","content":"說明"}],
  "key_quote": "金句",
  "action_items": [{"action":"動作","expected_outcome":"結果","time_estimate":"時間"}],
  "pitfalls": [{"warn":"警示","why":"原因"}],
  "recall_questions": ["問句"],
  "tags": ["標籤"],
  "highlights": [{"timestamp":125,"label":"標題","description":"說明"}],
  "social_cards": [{"role":"insight","eyebrow":"重點","title":"單頁標題","body":"單頁內文","accent":"關鍵短句"}],
  "video_genre": "tutorial | opinion | interview | news | review | other"
}

規則:繁體中文,不用 emoji,key_points 3-5 個,action_items / pitfalls 各 1-3 個,recall_questions 2-3 個,highlights 5-8 個按時間順序。social_cards 必須剛好 20 頁：第 1 頁是 hook、第 20 頁是 closing；中間依來源安排核心主張、機制、證據、商業結構／商業模式（只有來源真的談到時）、工作流程、實作、風險與反思。每頁只講一件事，不重複、不捏造。`;

const SYSTEM_PROMPT = loadPromptOrFallback(
  "OPENAI_EXTRACT_PROMPT_PATH",
  "prompts/extract-system.txt",
  SYSTEM_PROMPT_DEMO
);

export interface Highlight {
  timestamp: number;
  label: string;
  description: string;
}

export interface Pitfall {
  warn: string;
  why: string;
}

export interface ActionItem {
  action: string;
  expected_outcome: string;
  time_estimate: string;
}

export const SOCIAL_CARD_COUNT = 20;

export type SocialCardRole =
  | "hook"
  | "context"
  | "thesis"
  | "insight"
  | "business"
  | "workflow"
  | "evidence"
  | "action"
  | "warning"
  | "quote"
  | "reflection"
  | "recap"
  | "closing";

export interface SocialCard {
  role: SocialCardRole;
  eyebrow: string;
  title: string;
  body: string;
  accent: string;
}

export type VideoGenre =
  | "tutorial"
  | "opinion"
  | "interview"
  | "news"
  | "review"
  | "other";

export interface Summary {
  title_display: string;
  one_liner: string;
  tldr_paragraph: string;
  key_points: { label: string; content: string }[];
  key_quote: string;
  action_items: ActionItem[];
  pitfalls: Pitfall[];
  recall_questions: string[];
  tags: string[];
  highlights: Highlight[];
  social_cards: SocialCard[];
  video_genre: VideoGenre;
  prompt_version?: string;
}

/**
 * 確保 summary 有所有新欄位 (給舊資料反序列化用)。
 * 缺什麼補什麼空值,不會清掉既有資料。
 */
export function ensureSummaryShape(raw: Partial<Summary>): Summary {
  return {
    title_display: raw.title_display || "",
    one_liner: raw.one_liner || "",
    tldr_paragraph: raw.tldr_paragraph || "",
    key_points: raw.key_points || [],
    key_quote: raw.key_quote || "",
    action_items: normalizeActionItems(raw.action_items),
    pitfalls: raw.pitfalls || [],
    recall_questions: raw.recall_questions || [],
    tags: raw.tags || [],
    highlights: raw.highlights || [],
    social_cards: normalizeSocialCards(raw.social_cards),
    video_genre: (raw.video_genre as VideoGenre) || "other",
    prompt_version: raw.prompt_version, // 不 default 成 PROMPT_VERSION,保留 null 以便辨識「未經 augment 的舊資料」
  };
}

function normalizeSocialCards(raw: unknown): SocialCard[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<SocialCardRole>([
    "hook", "context", "thesis", "insight", "business", "workflow", "evidence",
    "action", "warning", "quote", "reflection", "recap", "closing",
  ]);
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const role = String(value.role || "") as SocialCardRole;
    if (!allowed.has(role)) return [];
    const card = {
      role,
      eyebrow: String(value.eyebrow || "").trim(),
      title: String(value.title || "").trim(),
      body: String(value.body || "").trim(),
      accent: String(value.accent || "").trim(),
    };
    return card.title && card.body ? [card] : [];
  });
}

/**
 * 舊版 action_items 是 string[],新版是 ActionItem[]。
 * 反序列化時自動轉換,不破壞舊資料。
 */
function normalizeActionItems(raw: unknown): ActionItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    if (typeof item === "string") {
      return { action: item, expected_outcome: "", time_estimate: "" };
    }
    if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      return {
        action: String(obj.action || ""),
        expected_outcome: String(obj.expected_outcome || ""),
        time_estimate: String(obj.time_estimate || ""),
      };
    }
    return { action: "", expected_outcome: "", time_estimate: "" };
  });
}

export async function extractSummary(
  transcriptWithTimestamps: string,
  videoTitle: string,
  channel: string
): Promise<Summary> {
  if (processingMode() === 'local') {
    const { extractLocalSummary } = await import('./local-summary');
    return extractLocalSummary(transcriptWithTimestamps, videoTitle, channel);
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  let text = transcriptWithTimestamps;
  if (text.length > 100000) {
    text = text.slice(0, 48000) + "\n\n[...中間省略...]\n\n" + text.slice(-48000);
  }

  const userMsg = `影片標題: ${videoTitle}\n頻道: ${channel}\n\n逐字稿 (含時間戳):\n${text}`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 6000,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenAI");

  const raw = JSON.parse(content) as Partial<Summary>;
  return ensureSummaryShape({ ...raw, prompt_version: PROMPT_VERSION });
}

/**
 * extractSummary + highlights 時間戳自動驗證。
 *
 * GPT 首次萃取常把 highlights 全擠在影片開頭(誤判時間戳單位),
 * 以前要靠使用者手動打 regenerate-highlights 補救。
 * 這裡在首次生成後就用 highlightsLookBroken() 檢查,爛的話立刻重產一次。
 * 修不好就保留原樣,不擋整個 pipeline。
 */
export async function extractSummaryVerified(
  transcriptWithTimestamps: string,
  videoTitle: string,
  channel: string,
  durationSec: number
): Promise<Summary> {
  const summary = await extractSummary(transcriptWithTimestamps, videoTitle, channel);
  if (processingMode() === "local") return summary;
  if (durationSec > 0 && highlightsLookBroken(summary.highlights, durationSec)) {
    try {
      const fixed = await regenerateHighlights(
        transcriptWithTimestamps, videoTitle, channel, durationSec
      );
      if (fixed.length >= 3) summary.highlights = fixed;
    } catch (err) {
      console.warn("[extract-summary] highlights 自動修正失敗,保留原版:", err);
    }
  }
  return summary;
}

/**
 * Lazy upgrade: 給舊 summary 補新版欄位與 20 頁社群學習卡。
 *
 * 不重新計算既有的 title_display / key_points / highlights 等,只請 GPT 回傳缺的部分,
 * 用較小的 max_tokens (省 cost) + 較短的 prompt (省 input cost)。
 *
 * 跟 SYSTEM_PROMPT 一樣走 prompt 外部檔載入 + demo fallback。
 */
const AUGMENT_PROMPT_DEMO = `你是一個影片內容摘要工具。已有讀者的影片摘要,請補充缺的欄位 (tldr_paragraph / pitfalls / recall_questions / video_genre / social_cards),並把舊 action_items 升級成 v2 結構。

輸出 JSON:
{
  "tldr_paragraph": "段落 80-120字",
  "pitfalls": [{"warn":"...","why":"..."}],
  "recall_questions": ["..."],
  "video_genre": "tutorial | opinion | interview | news | review | other",
  "action_items_v2": [{"action":"...","expected_outcome":"...","time_estimate":"..."}],
  "social_cards": [{"role":"hook","eyebrow":"分類","title":"單頁標題","body":"單頁內文","accent":"關鍵短句"}]
}

規則: 繁體中文,不用 emoji。social_cards 剛好20頁，第1頁role=hook、第20頁role=closing，每頁只講一件事、不重複、不捏造；只有來源支持時才分析商業結構或商業模式。`;

const AUGMENT_PROMPT = loadPromptOrFallback(
  "OPENAI_AUGMENT_PROMPT_PATH",
  "prompts/augment-system.txt",
  AUGMENT_PROMPT_DEMO
);

export async function augmentSummary(
  oldSummary: Summary,
  transcriptWithTimestamps: string,
  videoTitle: string,
  channel: string
): Promise<Summary> {
  if (processingMode() === 'local') {
    const { extractLocalSummary } = await import('./local-summary');
    const fresh = await extractLocalSummary(transcriptWithTimestamps, videoTitle, channel);
    return { ...oldSummary, tldr_paragraph: fresh.tldr_paragraph, pitfalls: fresh.pitfalls,
      recall_questions: fresh.recall_questions, video_genre: fresh.video_genre, action_items: fresh.action_items,
      social_cards: fresh.social_cards,
      prompt_version: fresh.prompt_version };
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  let text = transcriptWithTimestamps;
  if (text.length > 60000) {
    text = text.slice(0, 28000) + "\n\n[...中間省略...]\n\n" + text.slice(-28000);
  }

  const existingSummary = JSON.stringify(
    {
      title_display: oldSummary.title_display,
      one_liner: oldSummary.one_liner,
      key_points: oldSummary.key_points,
      key_quote: oldSummary.key_quote,
      action_items_old: oldSummary.action_items,
      social_cards_old: oldSummary.social_cards,
      tags: oldSummary.tags,
    },
    null,
    2
  );

  const userMsg = `影片標題: ${videoTitle}\n頻道: ${channel}\n\n既有摘要 (供參考,不需重產):\n${existingSummary}\n\n逐字稿 (含時間戳):\n${text}`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: AUGMENT_PROMPT },
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_tokens: 6000,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error (augment): ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenAI augment");

  const augmented = JSON.parse(content) as {
    tldr_paragraph?: string;
    pitfalls?: Pitfall[];
    recall_questions?: string[];
    video_genre?: VideoGenre;
    action_items_v2?: ActionItem[];
    social_cards?: SocialCard[];
  };

  return ensureSummaryShape({
    ...oldSummary,
    tldr_paragraph: augmented.tldr_paragraph || oldSummary.tldr_paragraph,
    pitfalls: augmented.pitfalls || oldSummary.pitfalls,
    recall_questions: augmented.recall_questions || oldSummary.recall_questions,
    video_genre: augmented.video_genre || oldSummary.video_genre,
    action_items: augmented.action_items_v2?.length
      ? augmented.action_items_v2
      : normalizeActionItems(oldSummary.action_items),
    social_cards: augmented.social_cards?.length === SOCIAL_CARD_COUNT
      ? augmented.social_cards
      : oldSummary.social_cards,
    prompt_version: PROMPT_VERSION,
  });
}

/**
 * 偵測 highlights 是否異常 (時間戳全集中在影片開頭 / 沒按時間順序)。
 * 通常是當初 GPT extract 時誤判 transcript 時間戳單位。
 */
export function highlightsLookBroken(
  highlights: Highlight[],
  durationSec: number
): boolean {
  if (!highlights || highlights.length < 3) return true;
  if (durationSec < 300) return false; // 短片不檢查
  const maxTs = Math.max(...highlights.map((h) => h.timestamp || 0));
  // 影片 > 5 分鐘但 highlights 最大時間戳不到 30% → 視為爛
  return maxTs < durationSec * 0.3;
}

/**
 * 強制重產 highlights (給「時間戳似乎不準確」的 lazy fix 用)。
 * 不動其他欄位,只重新呼叫 GPT 拿合理 timestamp 的 highlights。
 */
const REGEN_HIGHLIGHTS_PROMPT = `你是影片內容萃取專家。請根據附帶時間戳的逐字稿,產出 5 到 8 個精華片段 (highlights),時間戳必須:
1. 是該段落起始的「秒數」(integer)
2. 涵蓋影片從頭到尾 (不能全集中在前 1 分鐘)
3. 按時間順序升序排列

輸出嚴格 JSON:
{
  "highlights": [
    { "timestamp": 125, "label": "標題 5-10字", "description": "描述 15-30字" }
  ]
}

規則:繁體中文,不用 emoji,專有名詞保留原文。注意逐字稿的時間戳格式 [m:ss],要正確轉成秒數 (例如 [12:30] = 750 秒)。`;

export async function regenerateHighlights(
  transcriptWithTimestamps: string,
  videoTitle: string,
  channel: string,
  durationSec: number
): Promise<Highlight[]> {
  if (processingMode() === 'local') {
    const { extractLocalSummary } = await import('./local-summary');
    const summary = await extractLocalSummary(transcriptWithTimestamps, videoTitle, channel);
    return summary.highlights.filter(item => durationSec <= 0 || item.timestamp <= durationSec + 5);
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  let text = transcriptWithTimestamps;
  if (text.length > 60000) {
    text = text.slice(0, 28000) + "\n\n[...中間省略...]\n\n" + text.slice(-28000);
  }

  const userMsg = `影片標題: ${videoTitle}\n頻道: ${channel}\n影片總長: ${durationSec} 秒\n\n逐字稿 (含時間戳):\n${text}`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: REGEN_HIGHLIGHTS_PROMPT },
        { role: "user", content: userMsg },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_tokens: 1500,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI API error (regen highlights): ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("Empty response from OpenAI regen highlights");

  const parsed = JSON.parse(content) as { highlights?: Highlight[] };
  // 過掉:不是數字 / 負值 / 超出影片長度 (容忍 5 秒 buffer)
  const upperBound = durationSec > 0 ? durationSec + 5 : Infinity;
  const list = (parsed.highlights || [])
    .filter(
      (h) =>
        Number.isFinite(h.timestamp) &&
        h.timestamp >= 0 &&
        h.timestamp <= upperBound &&
        typeof h.label === "string" &&
        typeof h.description === "string"
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  return list;
}
