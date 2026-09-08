/**
 * 外部翻譯的匯出／驗證／載入（規範見 docs/external-translation-spec.md）。
 *
 *   node --import tsx scripts/translation-import.ts export <videoId> [--out dir] [--batches 140]
 *   node --import tsx scripts/translation-import.ts check  <videoId> <zh.txt> [--report out.json]
 *   node --import tsx scripts/translation-import.ts load   <videoId> <zh.txt> [--apply] [--model external:claude]
 *
 * check 只讀；load 走語意校訂的候選與套用路徑（交易內 CAS、subtitle_revisions 可整批還原、SRT／VTT 重寫），
 * 不直接 UPDATE 字幕欄位。3000 若正在跑同一支影片的字幕工作，套用會被擋下。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../lib/db';
import { getGlossary } from '../lib/glossary-store';
import { compact, missingNumbers, splitSpeakerLabel } from '../lib/review/pipeline';
import { detectRiskFlags } from '../lib/review/risk-flags';
import { SubtitleReviewService, reviewSourceHash } from '../lib/review/service';
import { SubtitleReviewStore } from '../lib/review/store';
import { SUBTITLE_REVIEW_VERSION, type ReviewCandidate } from '../lib/review/types';
import { buildReviewWindows, toReviewCues } from '../lib/review/windows';
import { requestLocalTranslation } from '../lib/watch/local-translator';
import { normalizeTaiwanSubtitle } from '../lib/watch/taiwan-terminology';
import { untranslatedLocalWords } from '../lib/watch/local-cue-translator';
import type { WatchCue } from '../lib/watch/types';
// @ts-expect-error opencc-js does not ship TypeScript declarations.
import * as OpenCC from 'opencc-js';

const toTaiwanTraditional: (text: string) => string = OpenCC.Converter({ from: 'cn', to: 'tw' });
const MAINLAND = ['視頻', '信息', '伙計', '軟件', '服務器', '網絡', '屏幕', '質量', '默認', '用戶', '打印', '鼠標', '數據庫', '互聯網', '程序員', '博客'];
const CONTROL = /[\p{Cc}\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069]+/gu;

interface Segment { start: number; end: number; text: string }
interface Row { id: string; video_id: string; title: string | null; segments: string | null; segments_zh: string | null; transcript_source: string | null }

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const has = (name: string) => args.includes(name);
const positional = args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && args[index - 1].startsWith('--') && !['--apply'].includes(args[index - 1])));
const [command, target, zhPath] = positional;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function usage(): never {
  console.error('用法：translation-import.ts export|check|load <videoId> [zh.txt] [--out dir] [--batches n] [--report out.json] [--apply] [--model name]');
  process.exit(2);
}
if (!command || !target) usage();

const db = getDb();
const row = db.prepare('SELECT id, video_id, title, segments, segments_zh, transcript_source FROM summaries WHERE id = ? OR video_id = ?').get(target, target) as Row | undefined;
if (!row?.segments) { console.error('找不到影片或沒有原文字幕'); process.exit(1); }
const segments = JSON.parse(row.segments) as Segment[];
const current = row.segments_zh ? (JSON.parse(row.segments_zh) as Segment[]) : null;
const glossary = getGlossary();

if (command === 'export') {
  const out = flag('--out') ?? process.cwd();
  const fmt = (segment: Segment, index: number) => `[${index}] [${clock(segment.start)}] ${segment.text.replace(/\s+/g, ' ').trim()}`;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${row.video_id}.en.txt`), segments.map(fmt).join('\n') + '\n');
  console.log(`已寫 ${path.join(out, `${row.video_id}.en.txt`)}（${segments.length} 句）`);
  const size = Number(flag('--batches') ?? 0);
  if (size > 0) {
    const windows = buildReviewWindows(toReviewCues(segments, null));
    const ranges: Array<[number, number]> = [];
    let start = 0;
    for (const window of windows) {
      const last = window.cues[window.cues.length - 1].index;
      if (last - start + 1 >= size) { ranges.push([start, last]); start = last + 1; }
    }
    if (start < segments.length) ranges.push([start, segments.length - 1]);
    ranges.forEach(([a, b], k) => {
      const before = segments.slice(Math.max(0, a - 3), a).map((s, i) => `(context) ${fmt(s, Math.max(0, a - 3) + i)}`);
      const after = segments.slice(b + 1, b + 4).map((s, i) => `(context) ${fmt(s, b + 1 + i)}`);
      const body = segments.slice(a, b + 1).map((s, i) => fmt(s, a + i));
      fs.writeFileSync(path.join(out, `${row.video_id}.batch-${String(k + 1).padStart(2, '0')}.en.txt`), [...before, ...body, ...after].join('\n') + '\n');
    });
    console.log(ranges.map(([a, b], k) => `batch-${String(k + 1).padStart(2, '0')}: [${a}..${b}] ${b - a + 1} 句`).join('\n'));
  }
  process.exit(0);
}

if (!zhPath) usage();

/* ---------- 解析與驗證 ---------- */

interface Parsed { index: number; text: string }
function parseTranslation(file: string): { items: Parsed[]; errors: string[] } {
  const errors: string[] = [];
  const items: Parsed[] = [];
  const seen = new Set<number>();
  for (const [lineNo, raw] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('(context)')) continue;
    const match = /^\[(\d+)\]\s*(?:\[\d+:\d{2}(?::\d{2})?\]\s*)?(.*)$/.exec(line);
    if (!match) { errors.push(`第 ${lineNo + 1} 行不是「[n] 譯文」格式：${line.slice(0, 60)}`); continue; }
    const index = Number(match[1]);
    if (seen.has(index)) { errors.push(`[${index}] 重複出現`); continue; }
    seen.add(index);
    items.push({ index, text: match[2] });
  }
  return { items, errors };
}

interface Checked { index: number; source: string; text: string; current: string | null; warnings: string[] }
function check(items: Parsed[]): { checked: Checked[]; errors: string[] } {
  const errors: string[] = [];
  const byIndex = new Map(items.map(item => [item.index, item.text]));
  for (let index = 0; index < segments.length; index++) if (!byIndex.has(index)) errors.push(`缺少 [${index}]`);
  for (const item of items) if (item.index < 0 || item.index >= segments.length) errors.push(`[${item.index}] 超出範圍（原稿只有 ${segments.length} 句）`);
  const checked: Checked[] = [];
  const keepTerms = glossary.no_translate_terms.filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    const source = segments[index].text.replace(/\s+/g, ' ').trim();
    const raw = byIndex.get(index);
    if (raw === undefined) continue;
    const warnings: string[] = [];
    if (CONTROL.test(raw)) warnings.push('含控制字元，已攤平');
    let text = normalizeTaiwanSubtitle(raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), glossary, toTaiwanTraditional);
    const label = splitSpeakerLabel(source);
    if (/^>{2,}(?:\s|$)/.test(label.text) && !/^(?:[^>]*\s)?>{2,}/.test(text)) { text = `>> ${text}`; warnings.push('行首 >> 已自動補回'); }
    if (label.label && !text.startsWith(label.label)) { text = `${label.label} ${text}`; warnings.push('講者標籤已自動補回'); }
    if (!/[\p{L}\p{N}]/u.test(text)) { errors.push(`[${index}] 譯文空白`); continue; }
    const letters = (source.match(/[A-Za-z]/g) ?? []).length;
    if (letters > 3 && !/[㐀-鿿]/.test(text)) warnings.push('沒有中文');
    const cue: WatchCue = { id: `cue-${index}`, start: segments[index].start, end: segments[index].end, text: source };
    const leftover = untranslatedLocalWords(text, cue, glossary).slice(0, 5);
    if (leftover.length) warnings.push(`殘留英文：${leftover.join('、')}`);
    const numbers = missingNumbers(source, text);
    if (numbers.length) warnings.push(`數字未逐字保留：${numbers.join('、')}`);
    // 保留詞大小寫不計：keep 清單寫 Podcast，譯文照原文寫 podcast 也算保留。
    const dropped = keepTerms.filter(term => new RegExp(`(^|[^A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9])`, 'i').test(source) && !text.toLowerCase().includes(term.toLowerCase()));
    if (dropped.length) warnings.push(`保留詞未出現：${dropped.join('、')}`);
    const mainland = MAINLAND.filter(word => text.includes(word));
    if (mainland.length) warnings.push(`大陸用語：${mainland.join('、')}`);
    const ratio = Array.from(text.replace(/^>>\s*/, '')).length / Math.max(1, label.text.length);
    if (label.text.length >= 20 && ratio > 0.8) warnings.push(`偏長（比 ${ratio.toFixed(2)}），可能混入前後行`);
    else if (label.text.length >= 20 && ratio < 0.12) warnings.push(`偏短（比 ${ratio.toFixed(2)}），可能漏譯`);
    checked.push({ index, source, text, current: current?.[index]?.text ?? null, warnings });
  }
  return { checked, errors };
}

const parsed = parseTranslation(zhPath);
const result = check(parsed.items);
const errors = [...parsed.errors, ...result.errors];
const warned = result.checked.filter(item => item.warnings.length);
const summary = {
  video: row.video_id, title: row.title, cues: segments.length, translated: result.checked.length, errors: errors.length, warnings: warned.reduce((sum, item) => sum + item.warnings.length, 0),
  byKind: Object.entries(warned.flatMap(item => item.warnings).reduce<Record<string, number>>((acc, warning) => { const kind = warning.split(/[：（]/)[0]; acc[kind] = (acc[kind] ?? 0) + 1; return acc; }, {})),
};
console.log(JSON.stringify(summary));
for (const error of errors) console.log(`錯誤 ${error}`);
for (const item of warned) console.log(`警告 [${item.index}] ${clock(segments[item.index].start)} ${item.warnings.join('；')}\n   原：${item.source}\n   譯：${item.text}`);
const report = flag('--report');
if (report) fs.writeFileSync(report, JSON.stringify({ summary, errors, cues: result.checked }, null, 2));

if (command === 'check') process.exit(errors.length ? 1 : 0);
if (command !== 'load') usage();
if (errors.length) { console.error(`有 ${errors.length} 個錯誤，先修到 0 再載入。`); process.exit(1); }

/* ---------- 載入：當成語意校訂的候選，全部標已採用，可選擇直接套用 ---------- */

const model = flag('--model') ?? 'external:claude';
const cues = toReviewCues(segments, current);
const windows = buildReviewWindows(cues);
const windowOf = new Map<number, string>();
for (const window of windows) for (const cue of window.cues) windowOf.set(cue.index, window.key);
const sourceHash = reviewSourceHash(segments, row.transcript_source);
const candidates: ReviewCandidate[] = result.checked.map(item => {
  const cue = cues[item.index];
  return {
    cueIndex: item.index, cueId: cue.id, windowKey: windowOf.get(item.index) ?? `w-${item.index}-${item.index}`, start: cue.start, end: cue.end, source: cue.source, current: cue.current,
    candidate: item.text, flags: detectRiskFlags(cue, item.index > 0 ? cues[item.index - 1] : null), changed: cue.current === null || compact(item.text) !== compact(cue.current),
    notes: item.warnings, decision: 'candidate',
  };
});
const store = new SubtitleReviewStore(db);
const service = new SubtitleReviewService({ db, store, model: () => model, processingMode: () => 'local', glossary: () => glossary, request: requestLocalTranslation, projectRoot: path.resolve(__dirname, '..') });
if (store.row(row.id)?.status === 'running') { console.error('這支影片的語意校訂正在跑，先取消或等它結束。'); process.exit(1); }
const started = store.start(row.id, sourceHash, model, SUBTITLE_REVIEW_VERSION, windows.length);
if (!started.started || !started.token) { console.error('無法建立載入批次'); process.exit(1); }
store.saveCandidates(row.id, started.token, sourceHash, model, candidates, SUBTITLE_REVIEW_VERSION);
store.finish(row.id, started.token, { stage: 'complete', completed: windows.length, total: windows.length, message: `外部譯文載入：${candidates.length} 句候選（${model}），${candidates.filter(item => item.changed).length} 句與現行不同，已全部標為已採用。` }, false);
const changed = candidates.filter(item => item.changed).map(item => item.cueIndex);
store.decide(row.id, sourceHash, changed, 'approved');
console.log(`已載入 ${candidates.length} 句候選，${changed.length} 句標為已採用。`);
if (has('--apply')) {
  const applied = service.apply(row.id, sourceHash);
  console.log(`已套用 ${applied.applied} 句，批次 ${applied.batchId}${applied.exportError ? `；字幕檔匯出失敗：${applied.exportError}` : '，SRT／VTT 已重寫'}。面板「還原上一批」可整批退回。`);
} else {
  console.log('尚未寫回字幕；到影片頁「語意校訂」分頁按「套用已採用」，或重跑加 --apply。');
}
