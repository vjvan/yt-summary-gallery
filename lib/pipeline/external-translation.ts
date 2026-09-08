/**
 * 外部翻譯（Claude／Codex／人工翻整片）的解析、驗證與來源指紋。純函式，給 scripts/translation-import.ts 與測試用。
 * 規範見 docs/external-translation-spec.md。
 */
import type { Glossary } from '../glossary-defaults';
import { missingNumbers, splitSpeakerLabel } from '../review/pipeline';
import { untranslatedLocalWords } from '../watch/local-cue-translator';
import { normalizeTaiwanSubtitle } from '../watch/taiwan-terminology';
import type { WatchCue } from '../watch/types';

export interface ExternalSegment { start: number; end: number; text: string }
export interface TranslationManifest { videoId: string; summaryId: string; sourceHash: string; cues: number; exportedAt: string }
export interface ParsedLine { index: number; text: string }
export interface CheckedCue { index: number; source: string; text: string; current: string | null; warnings: string[] }

export const MAX_FILE_CHARS = 20 * 1024 * 1024;
export const MAX_LINE_CHARS = 8000;
export const CONTROL = /[\p{Cc}\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069]+/gu;
const CONTROL_ONE = /[\p{Cc}\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069]/gu;
/** 「優化」台灣也這樣講，不列。 */
export const MAINLAND_TERMS = ['視頻', '信息', '伙計', '軟件', '服務器', '網絡', '屏幕', '質量', '默認', '用戶', '打印', '鼠標', '數據庫', '互聯網', '程序員', '博客'];
const LINE = /^\[(\d{1,7})\][ \t]*(?:\[\d{1,4}:\d{2}(?::\d{2})?\][ \t]*)?(.*)$/;

/** 診斷訊息裡的不可信文字：控制字元與雙向控制碼改成可見的跳脫，ESC／BEL 到不了終端。 */
export const visible = (text: string) => text.replace(CONTROL_ONE, character => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`);
const hasContent = (text: string) => /[\p{L}\p{N}]/u.test(text);
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** 一行一句 `[n] 譯文`（可帶時間戳），`(context)` 行與空行略過；檔案與單行有大小上限，Unicode 換行先當成換行，正則不會回溯。 */
export function parseTranslationText(content: string): { items: ParsedLine[]; errors: string[] } {
  const errors: string[] = [];
  const items: ParsedLine[] = [];
  if (content.length > MAX_FILE_CHARS) return { items, errors: [`檔案超過 ${MAX_FILE_CHARS / 1024 / 1024} MB，拒絕解析`] };
  const seen = new Set<number>();
  content.split(/\r\n|\r|\n|\u2028|\u2029/).forEach((raw, lineNo) => {
    if (raw.length > MAX_LINE_CHARS) { errors.push(`第 ${lineNo + 1} 行超過 ${MAX_LINE_CHARS} 字元`); return; }
    const line = raw.trim();
    if (!line || line.startsWith('(context)')) return;
    const match = LINE.exec(line);
    if (!match) { errors.push(`第 ${lineNo + 1} 行不是「[n] 譯文」格式：${visible(line.slice(0, 60))}`); return; }
    const index = Number(match[1]);
    if (seen.has(index)) { errors.push(`[${index}] 重複出現`); return; }
    seen.add(index);
    items.push({ index, text: match[2] });
  });
  return { items, errors };
}

/** 來源指紋：匯出時記下原文 hash 與句數，載入時核對，舊譯文不能整批套到換過軌或重轉錄的字幕上。 */
export function verifyManifest(manifest: unknown, expected: { videoId: string; summaryId: string; sourceHash: string; cues: number }): string[] {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return ['manifest 不是物件'];
  const value = manifest as Partial<TranslationManifest>;
  const errors: string[] = [];
  if (value.videoId !== expected.videoId) errors.push(`manifest 的影片（${visible(String(value.videoId))}）不是這支（${expected.videoId}）`);
  if (value.summaryId !== expected.summaryId) errors.push('manifest 的 summary 不是這一列');
  if (value.sourceHash !== expected.sourceHash) errors.push('原文字幕在匯出後已變更（來源 hash 不同），這份譯文不能套用；請重新匯出再翻');
  if (value.cues !== expected.cues) errors.push(`manifest 句數 ${visible(String(value.cues))} 與現在的 ${expected.cues} 不同`);
  return errors;
}

export interface CheckInput {
  segments: ExternalSegment[];
  current: ExternalSegment[] | null;
  items: ParsedLine[];
  glossary: Glossary;
  toTraditional: (text: string) => string;
}

export function checkTranslation({ segments, current, items, glossary, toTraditional }: CheckInput): { checked: CheckedCue[]; errors: string[] } {
  const errors: string[] = [];
  const byIndex = new Map(items.map(item => [item.index, item.text]));
  for (let index = 0; index < segments.length; index++) if (!byIndex.has(index)) errors.push(`缺少 [${index}]`);
  for (const item of items) if (item.index < 0 || item.index >= segments.length) errors.push(`[${item.index}] 超出範圍（原稿只有 ${segments.length} 句）`);
  const checked: CheckedCue[] = [];
  const keepTerms = glossary.no_translate_terms.filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    const source = segments[index].text.replace(/\s+/g, ' ').trim();
    const raw = byIndex.get(index);
    if (raw === undefined) continue;
    const warnings: string[] = [];
    if (CONTROL.test(raw)) warnings.push('含控制字元，已攤平');
    CONTROL.lastIndex = 0;
    let text = normalizeTaiwanSubtitle(raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), glossary, toTraditional);
    const label = splitSpeakerLabel(source);
    // 先驗正文，再接標籤：只有標籤或只有 >> 的輸入（含兩者任意順序、重複）不能靠補回的標籤混過去。
    // 剝到不再變動為止：每輪至少少一個字元，重複前綴（>> 標籤 >> 標籤…）不會有殘留。
    let body = text.trim();
    for (let previous = ''; body !== previous; ) {
      previous = body;
      body = (label.label && body.startsWith(label.label) ? body.slice(label.label.length) : body).replace(/^\s*>{2,}\s*/, '').trim();
    }
    if (!hasContent(body)) { errors.push(`[${index}] 譯文空白`); continue; }
    if (/^>{2,}(?:\s|$)/.test(label.text) && !/^(?:[^>]*\s)?>{2,}/.test(text)) { text = `>> ${text}`; warnings.push('行首 >> 已自動補回'); }
    if (label.label && !text.startsWith(label.label)) { text = `${label.label} ${text}`; warnings.push('講者標籤已自動補回'); }
    const letters = (source.match(/[A-Za-z]/g) ?? []).length;
    if (letters > 3 && !/[㐀-鿿]/.test(text)) warnings.push('沒有中文');
    const cue: WatchCue = { id: `cue-${index}`, start: segments[index].start, end: segments[index].end, text: source };
    const leftover = untranslatedLocalWords(text, cue, glossary).slice(0, 5);
    if (leftover.length) warnings.push(`殘留英文：${leftover.join('、')}`);
    const numbers = missingNumbers(source, text);
    if (numbers.length) warnings.push(`數字未逐字保留：${numbers.join('、')}`);
    const dropped = keepTerms.filter(term => new RegExp(`(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9])`, 'i').test(source) && !text.toLowerCase().includes(term.toLowerCase()));
    if (dropped.length) warnings.push(`保留詞未出現：${dropped.join('、')}`);
    const mainland = MAINLAND_TERMS.filter(word => text.includes(word));
    if (mainland.length) warnings.push(`大陸用語：${mainland.join('、')}`);
    const ratio = Array.from(body).length / Math.max(1, label.text.length);
    if (label.text.length >= 20 && ratio > 0.8) warnings.push(`偏長（比 ${ratio.toFixed(2)}），可能混入前後行`);
    else if (label.text.length >= 20 && ratio < 0.12) warnings.push(`偏短（比 ${ratio.toFixed(2)}），可能漏譯`);
    checked.push({ index, source, text, current: current?.[index]?.text ?? null, warnings });
  }
  return { checked, errors };
}

export function describeWarning(segments: ExternalSegment[], item: CheckedCue): string {
  return `警告 [${item.index}] ${clock(segments[item.index].start)} ${item.warnings.join('；')}\n   原：${visible(item.source)}\n   譯：${visible(item.text)}`;
}
