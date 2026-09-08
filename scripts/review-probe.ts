/**
 * 語意校訂探針：對一部影片的指定視窗跑一次本機重譯，把逐句候選印出來，不寫任何東西進資料庫。
 * 用來校準 prompt、比較模型，或重現使用者回報的漂移句。
 *
 *   node --import tsx scripts/review-probe.ts <videoId|summaryId> <windowKey[,windowKey…]> [--model qwen2.5:7b] [--json]
 *   node --import tsx scripts/review-probe.ts GtxJdBTXKwE w-122-127,w-326-331 --model qwen3.5:9b
 *
 * windowKey 可用 `list` 列出所有高風險視窗（不呼叫模型）。
 */
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_GLOSSARY } from '../lib/glossary-defaults';
import { parseReviewOutput, reviewMessages, reviewSchema, sentenceItems } from '../lib/review/pipeline';
import { splitWindowSentences } from '../lib/review/sentences';
import { buildReviewWindows, prioritizeWindows, toReviewCues } from '../lib/review/windows';
import { requestLocalTranslation } from '../lib/watch/local-translator';

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const [target, keysArg] = args.filter(arg => !arg.startsWith('--') && arg !== flag('--model'));
const model = flag('--model') ?? process.env.WATCH_LOCAL_MODEL ?? 'qwen2.5:7b';
const asJson = args.includes('--json');
if (!target || !keysArg) { console.error('用法：review-probe.ts <videoId|summaryId> <windowKey,…|list> [--model m] [--json]'); process.exit(2); }

const db = new Database(path.join(process.cwd(), 'data', 'summaries.db'), { readonly: true });
const row = db.prepare('SELECT id, title, segments, segments_zh FROM summaries WHERE id = ? OR video_id = ?').get(target, target) as { id: string; title: string | null; segments: string | null; segments_zh: string | null } | undefined;
if (!row?.segments) { console.error('找不到影片或沒有字幕'); process.exit(1); }
const title = row.title || '';
const cues = toReviewCues(JSON.parse(row.segments), row.segments_zh ? JSON.parse(row.segments_zh) : null);
const windows = buildReviewWindows(cues);
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

if (keysArg === 'list') {
  for (const window of prioritizeWindows(windows)) console.log(window.key, `${clock(window.cues[0].start)}-${clock(window.cues[window.cues.length - 1].end)}`, `風險 ${window.score}`, window.flags.map(flag => flag.code).join(','));
  process.exit(0);
}

const wanted = new Set(keysArg.split(','));
const selected = windows.filter(window => wanted.has(window.key));
if (!selected.length) { console.error('指定的視窗不存在；用 list 看視窗鍵'); process.exit(1); }

async function main() {
  for (const window of selected) {
  const sentences = splitWindowSentences(window);
  const messages = reviewMessages(window, title, DEFAULT_GLOSSARY);
  const started = Date.now();
  const content = await requestLocalTranslation({ model, messages, schema: reviewSchema(Math.max(1, sentences.length)), temperature: 0, maxOutputTokens: Math.min(4000, 300 + window.cues.length * 220 + sentences.length * 20) });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const raw = JSON.parse(content) as unknown;
  const aligned = !!sentenceItems(raw, sentences.length);
  if (asJson) { console.log(JSON.stringify({ window: window.key, model, seconds, sentences: sentences.map(item => item.text), raw }, null, 2)); continue; }
  console.log(`\n=== ${window.key} ${clock(window.cues[0].start)}-${clock(window.cues[window.cues.length - 1].end)} · ${model} · ${seconds}s · ${sentences.length} 句 · ${aligned ? '一句對一句' : '句數不符'}`);
  try {
    for (const item of parseReviewOutput(raw, window, cues, title, DEFAULT_GLOSSARY)) {
      console.log(`[${clock(item.start)}] ${item.source}`);
      console.log(`   現行：${item.current ?? '（無）'}`);
      console.log(`   候選：${item.candidate}${item.notes.length ? `\n   備註：${item.notes.join('；')}` : ''}`);
    }
  } catch (error) {
    console.log('解析失敗：', error instanceof Error ? error.message : error);
    console.log(JSON.stringify(raw));
  }
}
}

void main();
