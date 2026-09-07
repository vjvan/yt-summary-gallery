/**
 * 外部分析貼入：把 NotebookLM 這類工具產出的繁中報告，用確定性規則切成剛好 20 頁
 * SocialCard，交給既有的三軸圖卡渲染。不呼叫任何模型；標題、段落、清單都取自貼入
 * 文字本身，只有第 2、19、20 頁是固定的結構頁（交代、帶走、收尾），不新增主張。
 */
import { SOCIAL_CARD_COUNT, type SocialCard, type SocialCardRole } from "./extract-summary";

export interface ImportAnalysisOptions {
  /** 影片標題，貼入文字沒有一級標題時當 hook 標題。 */
  title?: string;
  provider?: string;
}

export interface ImportAnalysisResult {
  cards: SocialCard[];
  /** 從文字切出的內容頁數（未截斷前）。 */
  contentCards: number;
  /** 超出可用頁數而未放進圖卡的內容頁。 */
  dropped: number;
  /** 內容不足時補的反思頁數（模板句，不含新主張）。 */
  padded: number;
  sections: string[];
  warnings: string[];
}

export class ImportAnalysisError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "ImportAnalysisError"; this.status = status; }
}

export const IMPORT_LIMITS = Object.freeze({ eyebrow: 12, title: 30, body: 110, accent: 24, minText: 120, maxText: 60_000 });
const STRUCTURAL_CARDS = 4; // hook + context + recap + closing
const MAX_PADDING = 6;
const CONTENT_SLOTS = SOCIAL_CARD_COUNT - STRUCTURAL_CARDS;

/**
 * NotebookLM 複製出來的引用編號：句尾的「 1 」「 3 4 」、上標數字、[1]。
 * 只認「中文字或右括號之後、前後都有空白、句末標點或行尾之前」的 1 到 3 位小數字；
 * 「完成數： 20。」「第 3、4 步」「排名 2。」這類沒有空白包夾的真數字不會被動到。
 * 量詞都有上界，避免在超長空白上回溯。
 */
export function stripCitationMarkers(text: string): string {
  return text
    // 上標只在中文字或句號之後才算引用；「(x+y)²」這種次方保留。
    .replace(/(?<=[㐀-鿿。])[¹²³⁰-⁹]{1,3}/g, "")
    .replace(/(?<![A-Za-z0-9])\[\d{1,3}(?:\s*[,，]\s*\d{1,3})*\](?![A-Za-z0-9(])/g, "")
    // 只清「句末標點之前、前後都有空白」的引用；行尾裸數字（本次得分 100）有歧義，預設保留。
    .replace(/(?<=[㐀-鿿）)])(?:[ \t]{1,4}\d{1,3}){1,6}[ \t]{1,4}(?=[。！？：])/g, "");
}

function stripInlineMarkup(line: string): string {
  return line
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\[\]\n]{1,200})\]\([^()\s]{1,500}\)/g, "$1")
    .replace(/^\s*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]️?\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

const chars = (value: string) => Array.from(value).length;
function clip(value: string, max: number): string {
  const list = Array.from(value.trim());
  return list.length <= max ? list.join("") : `${list.slice(0, max - 1).join("")}…`;
}

/** 依中文句讀切段，每段不超過 body 上限；單句過長才硬切。 */
export function chunkBody(text: string, max: number = IMPORT_LIMITS.body): string[] {
  if (!Number.isInteger(max) || max < 2) throw new RangeError("chunkBody max 至少為 2");
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^。！？；]+[。！？；]?/g) || [clean];
  const chunks: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (chars(sentence) > max) {
      if (current) { chunks.push(current); current = ""; }
      const list = Array.from(sentence);
      let cursor = 0;
      while (list.length - cursor > max) { chunks.push(list.slice(cursor, cursor + max - 1).join("") + "…"); cursor += max - 1; }
      current = list.slice(cursor).join("");
      continue;
    }
    if (current && chars(current) + chars(sentence) > max) { chunks.push(current); current = sentence; }
    else current = current ? `${current}${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "item"; indent: number; text: string }
  | { kind: "paragraph"; text: string };

const BULLET = /^(\s*)(?:[-*•・▪◦]|\d{1,2}[.、)]|[（(]\d{1,2}[)）])\s+(.+)$/;

/** `# 標題` 與 `**標題**`：用游標解析，不用會在超長空白上回溯的 regex。 */
function headingText(line: string): { level: number; text: string } | null {
  const trimmed = line.trim();
  const hashes = /^#{1,6}(?=[ \t])/.exec(trimmed);
  if (hashes) {
    let text = trimmed.slice(hashes[0].length).trim();
    while (text.endsWith("#")) text = text.slice(0, -1);
    text = text.trim();
    return text ? { level: hashes[0].length, text } : null;
  }
  if (trimmed.startsWith("**") && trimmed.length > 4) {
    const close = trimmed.indexOf("**", 2);
    if (close > 2) {
      const tail = trimmed.slice(close + 2).trim();
      if (tail === "" || tail === ":" || tail === "：") return { level: 3, text: trimmed.slice(2, close).trim() };
    }
  }
  return null;
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = stripCitationMarkers(text).replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) { const joined = stripInlineMarkup(paragraph.join(" ")); if (joined) blocks.push({ kind: "paragraph", text: joined }); paragraph = []; }
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "    ");
    if (!line.trim()) { flush(); continue; }
    if (/^\s*(thoughts?|想法)\s*[▾▼⌄]?\s*$/i.test(line)) { flush(); continue; }
    const heading = headingText(line);
    if (heading) { flush(); const text = stripInlineMarkup(heading.text); if (text) blocks.push({ kind: "heading", level: heading.level, text }); continue; }
    const bullet = BULLET.exec(line);
    if (bullet) { flush(); const body = stripInlineMarkup(bullet[2]); if (body) blocks.push({ kind: "item", indent: bullet[1].length, text: body }); continue; }
    const plain = stripInlineMarkup(line);
    if (!plain) continue;
    // 短句以冒號收尾、沒有其他句讀，視為段落標題（NotebookLM 常用粗體加冒號）；
    // 較長的「以下是……：」導語只是過場，不成一頁。
    if (/[:：]$/.test(plain) && chars(plain) <= 60) {
      flush();
      const label = plain.replace(/[:：]$/, "").trim();
      const leadIn = /^(以下|下面|如下|接下來|包含|包括|主要有|分別是|例如)/.test(label);
      if (!leadIn && chars(label) <= IMPORT_LIMITS.title && !/[。！？；，]/.test(label)) blocks.push({ kind: "heading", level: 3, text: label });
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

interface Candidate { eyebrow: string; title: string; body: string; }

/** 把「標籤：內容」或「標籤（English）：內容」拆成標題與內文；沒有冒號就取第一個子句當標題。 */
function splitTitled(text: string, fallbackTitle: string): { title: string; body: string } {
  const labelled = /^(.{1,40}?)\s*[：:]\s*(.+)$/.exec(text);
  if (labelled && !/[。！？]/.test(labelled[1]) && chars(labelled[1]) <= 40) {
    return { title: clip(labelled[1], IMPORT_LIMITS.title), body: labelled[2].trim() };
  }
  const firstClause = /^(.{4,30}?)[，,。！？；]\s*(.+)$/.exec(text);
  if (firstClause && chars(text) > IMPORT_LIMITS.title) {
    return { title: clip(firstClause[1], IMPORT_LIMITS.title), body: text };
  }
  return { title: clip(chars(text) <= IMPORT_LIMITS.title ? text : fallbackTitle, IMPORT_LIMITS.title), body: text };
}

export function inferRole(title: string, body: string): SocialCardRole {
  const both = `${title} ${body}`;
  // 整個標題被引號包住才是金句；「三刺一勾」主動出擊這種只是強調詞。
  if (/^[「『"“].*[」』"”]$/.test(title) || (/^[「『"“]/.test(body) && chars(body) <= 80)) return "quote";
  if (/注意|風險|陷阱|避免|不要|誤區|倦怠|錯誤|失敗|踩雷|警告|迷思/.test(title)) return "warning";
  if (/步驟|執行|開始|做法|指南|計劃|計畫|實作|實戰|腳本|清單|怎麼做|如何|出擊|策略|方法/.test(title)) return "action";
  if (/流程|工作流|系統化|分級|排程|節奏|管理法|決策法/.test(title)) return "workflow";
  if (/營收|收入|訂閱|品牌|客戶|市場|商業|獲利|定價|贊助|合作|平台|變現|生意/.test(both)) return "business";
  if (/\d+\s*(萬|億|%|％|美元|美金|元|倍|支|篇|個月|天|小時|年|次)/.test(body)) return "evidence";
  if (/[？?]$/.test(title) || /反思|為什麼|思考/.test(title)) return "reflection";
  return "insight";
}

function cardFrom(candidate: Candidate): SocialCard {
  return {
    role: inferRole(candidate.title, candidate.body),
    eyebrow: clip((candidate.eyebrow || "重點").replace(/[「」『』]/g, ""), IMPORT_LIMITS.eyebrow),
    title: clip(candidate.title, IMPORT_LIMITS.title),
    body: clip(candidate.body, IMPORT_LIMITS.body),
    accent: "",
  };
}

/** 一段內文超過上限時拆成多頁，同標題、眉標加「續」。 */
function expand(candidate: Candidate): Candidate[] {
  const chunks = chunkBody(candidate.body);
  if (chunks.length <= 1) return [{ ...candidate, body: chunks[0] || candidate.body }];
  return chunks.map((body, index) => ({ eyebrow: index === 0 ? candidate.eyebrow : clip(`${candidate.eyebrow || "重點"}・續`, IMPORT_LIMITS.eyebrow), title: candidate.title, body }));
}

export function parseExternalAnalysis(rawText: string, options: ImportAnalysisOptions = {}): ImportAnalysisResult {
  // 上限看原始長度（含空白），不是 trim 後；否則塞幾百萬個空白就能繞過。
  if (typeof rawText !== "string" || rawText.length > IMPORT_LIMITS.maxText) throw new ImportAnalysisError(`貼入的分析超過 ${IMPORT_LIMITS.maxText} 字（含空白），請先刪減。`, 413);
  const text = rawText.trim();
  if (chars(text) < IMPORT_LIMITS.minText) throw new ImportAnalysisError(`貼入的分析太短（至少約 ${IMPORT_LIMITS.minText} 字），無法組成 20 頁。`);
  const blocks = parseBlocks(text);
  const warnings: string[] = [];

  let docTitle = "";
  const intro: string[] = [];
  const sections: string[] = [];
  const candidates: Candidate[] = [];
  let section = "";
  let sub = "";
  let subIndent = -1;
  let seenContent = false;

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.kind === "heading") {
      if (block.level === 1 && !docTitle && !seenContent) { docTitle = block.text; continue; }
      // 一到三級標題都是章節（NotebookLM 的粗體行等於章節）；更深的才當小節。
      if (block.level <= 3 || !section) { section = block.text; sub = ""; subIndent = -1; sections.push(block.text); }
      else { sub = block.text; subIndent = -1; }
      continue;
    }
    if (block.kind === "paragraph") {
      if (!seenContent && !section) { intro.push(block.text); continue; }
      seenContent = true;
      const eyebrow = sub || section || "重點";
      const titled = splitTitled(block.text, sub || section || docTitle || options.title || "重點");
      candidates.push(...expand({ eyebrow, title: titled.title, body: titled.body }));
      continue;
    }
    // item
    seenContent = true;
    const next = blocks[index + 1];
    const hasChildren = next && next.kind === "item" && next.indent > block.indent;
    const labelOnly = !/[：:]/.test(block.text) && chars(block.text) <= IMPORT_LIMITS.title;
    if (hasChildren && labelOnly) { sub = block.text; subIndent = block.indent; continue; }
    if (subIndent >= 0 && block.indent <= subIndent) { sub = ""; subIndent = -1; }
    const eyebrow = sub || section || "重點";
    const titled = splitTitled(block.text, eyebrow);
    candidates.push(...expand({ eyebrow, title: titled.title, body: titled.body }));
  }

  const hookTitle = clip(docTitle || options.title || sections[0] || "本集核心", IMPORT_LIMITS.title);
  const introChunks = chunkBody(intro.join(" "));
  const content = candidates.map(cardFrom);
  const usable = content.slice(0, CONTENT_SLOTS);
  const dropped = Math.max(0, content.length - CONTENT_SLOTS);
  if (dropped) warnings.push(`內容超過可用頁數，後面 ${dropped} 段沒有放進圖卡；可先刪減貼入文字再匯入。`);

  let padded = 0;
  while (usable.length < CONTENT_SLOTS && padded < MAX_PADDING && usable.length > 0) {
    const source = usable[padded % usable.length];
    usable.push({ role: "reflection", eyebrow: "再想一步", title: clip(`${source.title}成立的條件`, IMPORT_LIMITS.title),
      body: clip(`回到原片對應段落，寫下這一點在你的情境成立的條件與限制：${source.body}`, IMPORT_LIMITS.body), accent: "" });
    padded++;
  }
  if (padded) warnings.push(`內容不足，補了 ${padded} 頁反思提示（模板句，不含新主張）。`);
  if (usable.length < CONTENT_SLOTS) {
    throw new ImportAnalysisError(`貼入的分析只夠組成 ${usable.length + STRUCTURAL_CARDS} 頁，需要 20 頁。請貼更完整的報告，或把多次提問的回答合併後再貼。`);
  }

  const hook: SocialCard = { role: "hook", eyebrow: "本集核心", title: hookTitle, body: clip(introChunks[0] || usable[0].body, IMPORT_LIMITS.body), accent: "" };
  const contextBody = introChunks[1] || (sections.length ? `這份分析分成：${sections.join("、")}` : usable[1]?.body || usable[0].body);
  const context: SocialCard = { role: "context", eyebrow: "快速進入狀況", title: "這部影片在談什麼", body: clip(contextBody, IMPORT_LIMITS.body), accent: "" };
  const recapSource = sections.length ? sections : usable.slice(0, 4).map(card => card.title);
  const recap: SocialCard = { role: "recap", eyebrow: "帶走這些", title: "把 20 頁收斂成幾件事", body: clip(recapSource.join("、"), IMPORT_LIMITS.body), accent: "" };
  const closing: SocialCard = { role: "closing", eyebrow: "下一步", title: "收藏，然後回到原片驗證", body: "選一個最有用的觀點，回看對應段落，寫下它適用的情境與下一個動作。", accent: "" };

  const cards = [hook, context, ...usable, recap, closing];
  if (cards.length !== SOCIAL_CARD_COUNT) throw new ImportAnalysisError("圖卡頁數組裝異常，未匯入。");
  return { cards, contentCards: content.length, dropped, padded, sections, warnings };
}

/** 選用的護城河檢查：data/moat-terms.txt（不進 git）一行一詞，命中只提醒不阻擋。 */
export function findMoatTerms(text: string, terms: string[]): string[] {
  const hits: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (!term || term.startsWith("#")) continue;
    if (text.includes(term)) hits.push(term);
  }
  return hits;
}
