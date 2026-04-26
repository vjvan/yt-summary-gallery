/**
 * 逐字稿翻譯模組
 * 偵測英文逐字稿,用 GPT 翻譯成繁體中文,保留時間戳結構。
 *
 * Batch 截斷防護:
 * - BATCH_SIZE 控制在 15 段(避免 GPT 輸出超 max_tokens)
 * - 每 batch 翻完檢查是否齊;不齊就把漏的段拆成單段 retry
 * - 仍漏的段保留原文(fallback,但極少發生)
 */

import type { TranscriptSegment } from "./fetch-transcript";
import { buildGlossaryPromptSection } from "./glossary";
import { getGlossary } from "../glossary-store";
// @ts-expect-error opencc-js has no type declarations
import * as OpenCC from "opencc-js";

const s2tConverter = OpenCC.Converter({ from: "cn", to: "tw" });

const BATCH_SIZE = 15;
const MAX_TOKENS = 8000;
const MODEL = "gpt-4o-mini";

function isEnglish(text: string): boolean {
  const ascii = (text.match(/[a-zA-Z]/g) || []).length;
  const cjk = (text.match(/[一-鿿㐀-䶿]/g) || []).length;
  const total = ascii + cjk;
  if (total === 0) return false;
  return ascii / total > 0.6;
}

function hasSimplifiedChinese(text: string): boolean {
  const simplified = /[这个们来说对着没时会为发经让给长关学还点开问实现机东车书买画义与专业]/;
  return simplified.test(text);
}

function convertToTraditional(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.map((s) => ({
    start: s.start, end: s.end, text: s2tConverter(s.text),
  }));
}

/**
 * P2P AI Lab 風格 system prompt:
 *  - 領域定位:AI 影片創作 / 設計系統 / Web 開發
 *  - glossary section 在 prompt 中段,GPT 較會遵循
 *  - 強調意譯 + 一致性,不直譯
 *
 * 每次 translateSegments() call 動態 build,讓使用者改了 glossary 立刻生效,
 * 不需要重啟 server。
 */
function buildSystemPrompt(): string {
  const glossary = getGlossary();
  return [
    "你是專業翻譯,專長是 AI 影片創作、設計系統、Web 開發領域的英文逐字稿英譯中。",
    "把以下英文逐字稿翻譯成自然流暢的繁體中文,讀起來像台灣人寫的、不要有 AI 直譯感。",
    "",
    buildGlossaryPromptSection(glossary),
    "",
    "【格式硬規則】",
    "- 每行開頭有 [編號],翻譯後務必保留相同的 [編號] 格式",
    "- 輸入幾行就輸出幾行,不准漏行不准合併",
    "- 只輸出翻譯結果,不要任何額外說明、開場白、結語",
  ].join("\n");
}

async function callGptBatch(
  apiKey: string,
  systemPrompt: string,
  texts: string[]
): Promise<Map<number, string>> {
  const input = texts.map((t, idx) => `[${idx}] ${t}`).join("\n");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: input },
      ],
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
    }),
  });
  if (!resp.ok) return new Map();
  const data = await resp.json();
  const output: string = data.choices?.[0]?.message?.content || "";

  const lineMap = new Map<number, string>();
  for (const line of output.split("\n")) {
    const m = line.match(/^\[(\d+)\]\s*(.+)/);
    if (m) lineMap.set(parseInt(m[1]), m[2].trim());
  }
  return lineMap;
}

export async function translateSegments(
  segments: TranscriptSegment[]
): Promise<{ translated: TranscriptSegment[]; wasTranslated: boolean }> {
  if (segments.length === 0) return { translated: segments, wasTranslated: false };

  const sampleText = segments.slice(0, 20).map((s) => s.text).join(" ");
  if (!isEnglish(sampleText)) {
    if (hasSimplifiedChinese(sampleText)) {
      return { translated: convertToTraditional(segments), wasTranslated: true };
    }
    return { translated: segments, wasTranslated: false };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { translated: segments, wasTranslated: false };

  // 一次讀 glossary、組 prompt,整次 translateSegments() 共用,
  // 避免每 batch 都讀 DB(雖然 SQLite local 也不慢,但語意更清楚)
  const systemPrompt = buildSystemPrompt();

  const translated: TranscriptSegment[] = new Array(segments.length);

  // Pass 1: batch translate
  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    const batch = segments.slice(i, i + BATCH_SIZE);
    const lineMap = await callGptBatch(apiKey, systemPrompt, batch.map((s) => s.text));
    for (let j = 0; j < batch.length; j++) {
      const t = lineMap.get(j);
      translated[i + j] = {
        start: batch[j].start,
        end: batch[j].end,
        text: t || "", // 暫時留空,Pass 2 會補
      };
    }
  }

  // Pass 2: 漏譯段拆成單段 retry(不超過 3 個一組,避免再次截斷)
  const missingIndices: number[] = [];
  for (let i = 0; i < translated.length; i++) {
    if (!translated[i].text) missingIndices.push(i);
  }

  if (missingIndices.length > 0) {
    console.log(`[translate] pass 2 retry ${missingIndices.length}/${segments.length} missing segments`);
    const RETRY_BATCH = 3;
    for (let i = 0; i < missingIndices.length; i += RETRY_BATCH) {
      const idxBatch = missingIndices.slice(i, i + RETRY_BATCH);
      const texts = idxBatch.map((idx) => segments[idx].text);
      const lineMap = await callGptBatch(apiKey, systemPrompt, texts);
      for (let j = 0; j < idxBatch.length; j++) {
        const idx = idxBatch[j];
        const t = lineMap.get(j);
        if (t) translated[idx].text = t;
      }
    }
  }

  // Pass 3: final fallback(若還是空,留原文,至少不空)
  for (let i = 0; i < translated.length; i++) {
    if (!translated[i].text) translated[i].text = segments[i].text;
  }

  return { translated, wasTranslated: true };
}

export function translatePlainText(segments: TranscriptSegment[]): string {
  return segments.map((s) => s.text).join(" ");
}
