/**
 * NotebookLM 來源包：把影片的原文逐句與繁中譯文（台灣用語，已過字庫）輸出成
 * 一份可上傳 NotebookLM 當來源的純文字檔。每句兩行、各帶時間戳，讓 NotebookLM
 * 引用時自然帶出影片位置與台灣用語版譯文。不呼叫模型、不改資料庫。
 */
import type { TranscriptSegment } from "./fetch-transcript";

export type NotebookSourceLang = "bi" | "en" | "zh";

export interface NotebookSourceInput {
  title: string;
  channel: string;
  url: string;
  durationDisplay: string;
  segments: TranscriptSegment[];
  segmentsZh: TranscriptSegment[] | null;
  lang: NotebookSourceLang;
  generatedAt?: Date;
}

export interface NotebookSourceOutput {
  text: string;
  filename: string;
  cues: number;
  translated: number;
  /** 中譯缺席或對不齊時的說明；null 代表雙語完整。 */
  note: string | null;
}

export class NotebookSourceError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "NotebookSourceError"; this.status = status; }
}

export function parseNotebookSourceLang(raw: string | null | undefined): NotebookSourceLang {
  if (raw === null || raw === undefined || raw === "") return "bi";
  if (raw === "bi" || raw === "en" || raw === "zh") return raw;
  throw new NotebookSourceError("lang 只接受 bi、en 或 zh。");
}

export function formatCueTimestamp(seconds: number, longForm: boolean): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (longForm || h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

function safeFilename(title: string): string {
  // 依 code point 截斷，避免切斷 emoji 的 surrogate pair 讓 encodeURIComponent 炸掉。
  const base = Array.from(title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim()).slice(0, 80).join("").trim();
  return base || "video";
}

/** 中譯要與原文逐句對齊才算可用；段數不一致代表資料來自不同版本，不硬湊。 */
function alignedTranslation(segments: TranscriptSegment[], segmentsZh: TranscriptSegment[] | null): TranscriptSegment[] | null {
  if (!segmentsZh || segmentsZh.length === 0) return null;
  if (segmentsZh.length !== segments.length) return null;
  for (let i = 0; i < segments.length; i++) {
    if (Math.abs(segmentsZh[i].start - segments[i].start) > 1.5) return null;
  }
  return segmentsZh;
}

export function buildNotebookSource(input: NotebookSourceInput): NotebookSourceOutput {
  const segments = (input.segments || []).filter(cue => cue && Number.isFinite(cue.start) && typeof cue.text === "string" && cue.text.trim());
  if (segments.length === 0) throw new NotebookSourceError("這支影片還沒有可匯出的原文逐字稿。", 404);
  const zh = alignedTranslation(segments, input.segmentsZh);
  const lang = input.lang;
  let note: string | null = null;
  if (!zh) {
    if (lang === "zh") throw new NotebookSourceError("中譯尚未完成或與原文對不齊，無法輸出純中文來源包；可先輸出英文版。", 409);
    if (lang === "bi") note = input.segmentsZh && input.segmentsZh.length ? "中譯段數與原文對不齊，本檔只含英文原文。" : "中譯尚未完成，本檔只含英文原文。";
  }
  const longForm = segments[segments.length - 1].start >= 3600;
  const generatedAt = input.generatedAt || new Date();
  const languageLine = zh && lang === "bi" ? "英文原文逐句 + 繁體中文譯文（台灣用語，本機字庫校正）。每句兩行：先英文，後中文。"
    : lang === "zh" ? "繁體中文譯文（台灣用語，本機字庫校正），逐句對應影片時間。"
      : "英文原文逐句，對應影片時間。";
  const header = [
    `# ${oneLine(input.title) || "未命名影片"}`,
    `來源：${input.url}`,
    `頻道：${oneLine(input.channel) || "未知"}｜片長：${input.durationDisplay || "未知"}`,
    `內容：${languageLine}`,
    "提示：時間戳是影片位置，引用時請連同時間戳一起保留，例如 [12:34]。",
    `匯出：${generatedAt.toISOString().slice(0, 10)}｜影片字幕翻譯庫`,
    ...(note ? [`注意：${note}`] : []),
    "",
  ];
  const body: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const stamp = `[${formatCueTimestamp(segments[i].start, longForm)}]`;
    const en = oneLine(segments[i].text);
    const zhText = zh ? oneLine(zh[i].text) : "";
    if (lang !== "zh") body.push(`${stamp} ${en}`);
    if (zh && lang !== "en" && zhText) body.push(`${stamp} ${zhText}`);
    body.push("");
  }
  const text = `${header.join("\n")}\n${body.join("\n")}`.replace(/\n+$/, "\n");
  const effectiveLang: NotebookSourceLang = zh || lang === "en" ? lang : "en";
  return {
    text,
    filename: `${safeFilename(input.title)}.notebooklm.${effectiveLang}.txt`,
    cues: segments.length,
    translated: zh ? segments.length : 0,
    note,
  };
}
