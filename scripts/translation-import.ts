/**
 * 外部翻譯的匯出／驗證／載入（規範見 docs/external-translation-spec.md；純函式在 lib/pipeline/external-translation.ts）。
 *
 *   node --import tsx scripts/translation-import.ts export <videoId> [--out dir] [--batches 140]
 *   node --import tsx scripts/translation-import.ts check  <videoId> <zh.txt> [--manifest path] [--report out.json]
 *   node --import tsx scripts/translation-import.ts load   <videoId> <zh.txt> [--apply] [--model external:claude] [--server http://127.0.0.1:3000]
 *
 * export 會寫 `<videoId>.manifest.json`（來源 hash 與句數）；check／load 預設在譯文檔同目錄找它，對不上就拒絕，
 * 舊譯文不能整批套到換過軌或重轉錄的字幕上（`--no-manifest` 可跳過，僅限你確定原文沒變）。
 * load 走語意校訂的候選與套用路徑，整段（建立批次、存候選、標採用、套用、補套漂移句）在同一個資料庫交易裡完成；
 * 載入前先問 3000 有沒有正在跑的字幕寫入工作，有就不載。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../lib/db';
import { getGlossary } from '../lib/glossary-store';
import { checkTranslation, describeWarning, parseTranslationText, verifyManifest, visible, type ExternalSegment, type TranslationManifest } from '../lib/pipeline/external-translation';
import { compact } from '../lib/review/pipeline';
import { detectRiskFlags } from '../lib/review/risk-flags';
import { SubtitleReviewService, reviewSourceHash } from '../lib/review/service';
import { SubtitleReviewStore } from '../lib/review/store';
import { SUBTITLE_REVIEW_VERSION, type ReviewCandidate } from '../lib/review/types';
import { buildReviewWindows, toReviewCues } from '../lib/review/windows';
import { requestLocalTranslation } from '../lib/watch/local-translator';
// @ts-expect-error opencc-js does not ship TypeScript declarations.
import * as OpenCC from 'opencc-js';

const toTaiwanTraditional: (text: string) => string = OpenCC.Converter({ from: 'cn', to: 'tw' });

interface Row { id: string; video_id: string; title: string | null; segments: string | null; segments_zh: string | null; transcript_source: string | null }

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--out', '--batches', '--report', '--model', '--manifest', '--server']);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const has = (name: string) => args.includes(name);
const positional = args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && VALUE_FLAGS.has(args[index - 1])));
const [command, target, zhPath] = positional;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function usage(): never {
  console.error('用法：translation-import.ts export|check|load <videoId> [zh.txt] [--out dir] [--batches n] [--report out.json] [--apply] [--model name] [--manifest path] [--no-manifest] [--server url]');
  process.exit(2);
}
if (!command || !target) usage();

const db = getDb();
const row = db.prepare('SELECT id, video_id, title, segments, segments_zh, transcript_source FROM summaries WHERE id = ? OR video_id = ?').get(target, target) as Row | undefined;
if (!row?.segments) { console.error('找不到影片或沒有原文字幕'); process.exit(1); }
const segments = JSON.parse(row.segments) as ExternalSegment[];
const current = row.segments_zh ? (JSON.parse(row.segments_zh) as ExternalSegment[]) : null;
const glossary = getGlossary();
const sourceHash = reviewSourceHash(segments, row.transcript_source);

if (command === 'export') {
  const out = flag('--out') ?? process.cwd();
  const fmt = (segment: ExternalSegment, index: number) => `[${index}] [${clock(segment.start)}] ${segment.text.replace(/\s+/g, ' ').trim()}`;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${row.video_id}.en.txt`), segments.map(fmt).join('\n') + '\n');
  const manifest: TranslationManifest = { videoId: row.video_id, summaryId: row.id, sourceHash, cues: segments.length, exportedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(out, `${row.video_id}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
  // 給翻譯者看的字庫：keep 逐字保留、term map 優先採用、style rules 口吻。
  fs.writeFileSync(path.join(out, 'glossary.md'), [
    '## keep（逐字保留，不翻）', glossary.no_translate_terms.join('、'), '',
    '## term map（優先採用）', glossary.term_map.map(([en, zh]) => `${en} → ${zh}`).join('；'), '',
    '## style rules', ...glossary.style_rules.map((rule, index) => `${index + 1}. ${rule}`), '',
  ].join('\n'));
  console.log(`已寫 ${path.join(out, `${row.video_id}.en.txt`)}（${segments.length} 句）、${row.video_id}.manifest.json 與 glossary.md`);
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

/* ---------- 來源指紋 ---------- */
const manifestPath = flag('--manifest') ?? path.join(path.dirname(path.resolve(zhPath)), `${row.video_id}.manifest.json`);
const manifestErrors: string[] = [];
if (has('--no-manifest')) console.log('警告 跳過來源指紋核對（--no-manifest）；只有你確定原文字幕沒變才這樣做。');
else if (!fs.existsSync(manifestPath)) manifestErrors.push(`找不到來源指紋 ${manifestPath}；請用 export 產生，或確定原文沒變再加 --no-manifest`);
else {
  let manifest: unknown;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { manifest = null; }
  manifestErrors.push(...verifyManifest(manifest, { videoId: row.video_id, summaryId: row.id, sourceHash, cues: segments.length }));
}

/* ---------- 解析與驗證 ---------- */
const stat = fs.statSync(zhPath);
if (stat.size > 40 * 1024 * 1024) { console.error('譯文檔超過 40 MB，拒絕讀取'); process.exit(1); }
const parsed = parseTranslationText(fs.readFileSync(zhPath, 'utf8'));
const result = checkTranslation({ segments, current, items: parsed.items, glossary, toTraditional: toTaiwanTraditional });
const errors = [...manifestErrors, ...parsed.errors, ...result.errors];
const warned = result.checked.filter(item => item.warnings.length);
const summary = {
  video: row.video_id, title: row.title, cues: segments.length, translated: result.checked.length, errors: errors.length, warnings: warned.reduce((sum, item) => sum + item.warnings.length, 0),
  byKind: Object.entries(warned.flatMap(item => item.warnings).reduce<Record<string, number>>((acc, warning) => { const kind = warning.split(/[：（]/)[0]; acc[kind] = (acc[kind] ?? 0) + 1; return acc; }, {})),
};
console.log(JSON.stringify(summary));
for (const error of errors) console.log(`錯誤 ${visible(error)}`);
for (const item of warned) console.log(describeWarning(segments, item));
const report = flag('--report');
if (report) fs.writeFileSync(report, JSON.stringify({ summary, errors, cues: result.checked }, null, 2));

if (command === 'check') process.exit(errors.length ? 1 : 0);
if (command !== 'load') usage();
if (errors.length) { console.error(`有 ${errors.length} 個錯誤，先修到 0 再載入。`); process.exit(1); }

/* ---------- 載入：整段在一個交易裡，當成語意校訂的候選、標已採用、可選擇直接套用 ---------- */

async function writerBusy(server: string, id: string): Promise<boolean | null> {
  try {
    const response = await fetch(`${server.replace(/\/$/, '')}/api/summaries/${encodeURIComponent(id)}/subtitle-review`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    const data = await response.json() as { writerActive?: unknown; status?: unknown };
    return data.writerActive === true || data.status === 'running';
  } catch { return null; }
}

async function main() {
  const model = flag('--model') ?? 'external:claude';
  const server = flag('--server') ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const busy = await writerBusy(server, row!.id);
  if (busy === true) { console.error(`${server} 這支影片正有字幕寫入或校訂工作在跑，先等它結束再載入。`); process.exit(1); }
  if (busy === null) console.log(`警告 問不到 ${server}（沒開或逾時）；沒有服務在跑就不會有撞寫，繼續。`);

  const cues = toReviewCues(segments, current);
  const windows = buildReviewWindows(cues);
  const windowOf = new Map<number, string>();
  for (const window of windows) for (const cue of window.cues) windowOf.set(cue.index, window.key);
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
  const outcome = db.transaction(() => {
    store.recoverExpired();
    const started = store.start(row!.id, sourceHash, model, SUBTITLE_REVIEW_VERSION, windows.length);
    if (!started.started || !started.token) throw new Error('這支影片的語意校訂正在跑，先取消或等它結束（租約 180 秒過期會自動回收）。');
    store.saveCandidates(row!.id, started.token, sourceHash, model, candidates, SUBTITLE_REVIEW_VERSION);
    const changed = candidates.filter(item => item.changed).map(item => item.cueIndex);
    store.decide(row!.id, sourceHash, changed, 'approved');
    store.finish(row!.id, started.token, { stage: 'complete', completed: windows.length, total: windows.length, message: `外部譯文載入：${candidates.length} 句候選（${model}），${changed.length} 句與現行不同，已全部標為已採用。` }, false);
    if (!has('--apply')) return { changed: changed.length, applied: null as null | { applied: number; batchId: string | null; exportError: string | null }, reapplied: 0 };
    const applied = service.apply(row!.id, sourceHash);
    // 曾套用又被整片重譯蓋掉的句子仍是 applied，apply 不會再寫；用 reapply 把這次匯入的內容補回去。
    const drifted = service.get(row!.id).drifted;
    const reapplied = drifted > 0 ? service.reapply(row!.id, sourceHash).applied : 0;
    return { changed: changed.length, applied: { applied: applied.applied, batchId: applied.batchId, exportError: applied.exportError }, reapplied };
  })();
  console.log(`已載入 ${candidates.length} 句候選，${outcome.changed} 句標為已採用。`);
  if (!outcome.applied) { console.log('尚未寫回字幕；到影片頁「語意校訂」分頁按「套用已採用」，或重跑加 --apply。'); return; }
  console.log(`已套用 ${outcome.applied.applied} 句，批次 ${outcome.applied.batchId}${outcome.reapplied ? `，另補套 ${outcome.reapplied} 句被覆蓋過的已寫回句` : ''}${outcome.applied.exportError ? `；字幕檔匯出失敗：${visible(outcome.applied.exportError)}` : '，SRT／VTT 已重寫'}。面板「還原上一批」可整批退回。`);
}

void main().catch(error => { console.error(visible(error instanceof Error ? error.message : String(error))); process.exit(1); });
