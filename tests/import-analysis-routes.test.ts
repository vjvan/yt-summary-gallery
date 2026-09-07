import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import * as summaryModule from '../lib/pipeline/extract-summary';
import * as importModule from '../lib/pipeline/import-analysis';
import * as sourceModule from '../lib/pipeline/notebooklm-source';

const rowId = 'import_fixture';
const originalCards = Array.from({ length: 20 }, (_, index) => ({ role: index === 0 ? 'hook' : index === 19 ? 'closing' : 'insight', eyebrow: '本機', title: `本機第 ${index + 1} 頁`, body: '本機萃取的內容。', accent: '' }));
// 刻意保留舊格式與未知欄位：匯入只能改圖卡兩個欄位，其餘原封不動。
const legacySummary = { title_display: '測試影片', one_liner: '一句話', action_items: ['先安裝工具'], custom_extension: { keep: true }, social_cards: originalCards };
const segments = [{ start: 0, end: 2, text: 'Hello there.' }, { start: 2, end: 4, text: 'Second line.' }];
const segmentsZh = [{ start: 0, end: 2, text: '哈囉。' }, { start: 2, end: 4, text: '第二句。' }];

const analysis = ['# 匯入標題', '', '開場段落，說明整部影片在講什麼。', '', '**第一章**', '',
  ...Array.from({ length: 18 }, (_, index) => `- **要點 ${index + 1}**：這是第 ${index + 1} 個要點的內容，足夠長到可以成為一頁，並且不重複其他頁。`)].join('\n');

interface FixtureOptions { translated?: boolean; token?: string | null; stage?: string; summary?: string | null; status?: string; cardPaths?: string | null }
function fixture(options: FixtureOptions = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE summaries (id TEXT PRIMARY KEY, video_id TEXT, url TEXT, title TEXT, channel TEXT, duration_display TEXT,
    segments TEXT, segments_zh TEXT, is_translated INTEGER, summary TEXT, external_analysis TEXT, card_render_token TEXT, pipeline_stage TEXT, status TEXT, card_paths TEXT)`);
  db.prepare('INSERT INTO summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rowId, rowId, 'https://www.youtube.com/watch?v=fixture', '測試影片', '頻道', '0:04',
    JSON.stringify(segments), options.translated === false ? null : JSON.stringify(segmentsZh), options.translated === false ? 0 : 1,
    options.summary === undefined ? JSON.stringify(legacySummary) : options.summary, null, options.token ?? null, options.stage ?? 'library_complete', options.status ?? 'done', options.cardPaths === undefined ? JSON.stringify(['/cards/x/slide-1.png']) : options.cardPaths);
  return { db, row: () => db.prepare('SELECT * FROM summaries WHERE id = ?').get(rowId) as Record<string, string | null> };
}
function loadRoute(file: string, db: Database.Database, library: { active: boolean } = { active: false }) {
  const testModule = { exports: {} as Record<string, (...args: unknown[]) => Promise<Response>> };
  const imports: Record<string, unknown> = {
    'next/server': { NextRequest, NextResponse }, '@/lib/db': { getDb: () => db },
    '@/lib/pipeline/extract-summary': summaryModule, '@/lib/pipeline/import-analysis': importModule,
    '@/lib/pipeline/notebooklm-source': sourceModule, 'node:fs': fs, 'node:path': path, 'node:crypto': crypto,
    '@/lib/pipeline/local-youtube-library': { libraryJobActive: () => library.active, libraryCardsReady: (value: unknown) => { try { const paths = typeof value === 'string' ? JSON.parse(value) : value; return Array.isArray(paths) && paths.length > 0; } catch { return false; } } },
  };
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(js, { module: testModule, exports: testModule.exports, require: (name: string) => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`);
    return imports[name];
  }, console: { warn() {}, error() {}, log() {} }, process, URL, Buffer, Set, Error, Date, JSON, Map, Array, Number, String, Object, Math, RegExp });
  return testModule.exports;
}
const context = { params: Promise.resolve({ id: rowId }) };
const url = (route: string, query = '') => `http://127.0.0.1:3000/api/summaries/${rowId}/${route}${query}`;
const post = (body: unknown) => new NextRequest(url('import-analysis'), { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const del = () => new NextRequest(url('import-analysis'), { method: 'DELETE' });

test('dry run returns 20 parsed cards and writes nothing', async () => {
  const { db, row } = fixture();
  try {
    const api = loadRoute('app/api/summaries/[id]/import-analysis/route.ts', db);
    const response = await api.POST(post({ text: analysis, dryRun: true }), context);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.dryRun, true); assert.equal(result.cards.length, 20);
    assert.equal(result.cards[0].title, '匯入標題');
    assert.equal(row().external_analysis, null);
    assert.equal(row().summary, JSON.stringify(legacySummary));
    assert.equal((await api.POST(post({ text: '太短', dryRun: true }), context)).status, 400);
  } finally { db.close(); }
});

test('import only touches the two card fields, keeps legacy shapes verbatim, and DELETE restores the raw original', async () => {
  const { db, row } = fixture();
  try {
    const api = loadRoute('app/api/summaries/[id]/import-analysis/route.ts', db);
    const response = await api.POST(post({ text: analysis, provider: 'notebooklm' }), context);
    assert.equal(response.status, 200);
    const saved = JSON.parse(row().summary!);
    assert.equal(saved.social_cards.length, 20);
    assert.equal(saved.social_cards[0].title, '匯入標題');
    assert.equal(saved.social_cards_source, 'external:notebooklm');
    assert.deepEqual(saved.action_items, ['先安裝工具'], 'legacy string action_items are not normalised away');
    assert.deepEqual(saved.custom_extension, { keep: true }, 'unknown fields survive');
    assert.equal(saved.title_display, '測試影片');
    const record = JSON.parse(row().external_analysis!);
    assert.equal(record.provider, 'notebooklm');
    assert.equal(record.text, analysis);
    assert.deepEqual(record.previous_social_cards, originalCards);
    assert.equal(record.previous_source_present, false, 'the original had no social_cards_source field');

    // A second import must still remember the very first (local) version.
    const again = await api.POST(post({ text: analysis.replace('匯入標題', '第二次匯入') }), context);
    assert.equal(again.status, 200);
    assert.equal(JSON.parse(row().summary!).social_cards[0].title, '第二次匯入');
    assert.deepEqual(JSON.parse(row().external_analysis!).previous_social_cards, originalCards);

    const restored = await api.DELETE(del(), context);
    assert.equal(restored.status, 200);
    const back = JSON.parse(row().summary!);
    assert.deepEqual(back, legacySummary, 'restore returns the byte-identical original object');
    assert.equal(row().external_analysis, null);
    assert.equal((await api.DELETE(del(), context)).status, 404);
  } finally { db.close(); }
});

test('restore reproduces the exact original field shapes: missing, null and explicit source values', async () => {
  for (const original of [
    { title_display: '沒有圖卡欄位' },
    { title_display: '圖卡為 null', social_cards: null },
    { title_display: '明確標 local', social_cards: originalCards, social_cards_source: 'local' },
    { title_display: '雲端來源', social_cards: originalCards, social_cards_source: 'cloud:gpt-4o-mini' },
  ]) {
    const { db, row } = fixture({ summary: JSON.stringify(original) });
    try {
      const api = loadRoute('app/api/summaries/[id]/import-analysis/route.ts', db);
      assert.equal((await api.POST(post({ text: analysis }), context)).status, 200, original.title_display);
      assert.equal(JSON.parse(row().summary!).social_cards.length, 20);
      assert.equal((await api.DELETE(del(), context)).status, 200, original.title_display);
      assert.deepEqual(JSON.parse(row().summary!), original, original.title_display);
    } finally { db.close(); }
  }
});

test('import refuses states where the summary is missing, broken, rendering, still being produced, or oversized', async () => {
  for (const [options, expected] of [
    [{ token: 'busy-token', stage: 'library_rendering' }, 409],
    [{ summary: null }, 409],
    [{ summary: '{not json' }, 422],
    [{ status: 'processing' }, 409],
  ] as Array<[FixtureOptions, number]>) {
    const { db, row } = fixture(options);
    try {
      const api = loadRoute('app/api/summaries/[id]/import-analysis/route.ts', db);
      assert.equal((await api.POST(post({ text: analysis }), context)).status, expected, JSON.stringify(options));
      assert.equal(row().external_analysis, null);
    } finally { db.close(); }
  }
  // The first library render is still running and there are no cards yet: importing now would race the renderer.
  const racing = fixture({ cardPaths: null });
  try {
    const api = loadRoute('app/api/summaries/[id]/import-analysis/route.ts', racing.db, { active: true });
    assert.equal((await api.POST(post({ text: analysis }), context)).status, 409);
    assert.equal((await api.POST(post({ text: analysis, dryRun: true }), context)).status, 200, 'dry run is read-only and still allowed');
  } finally { racing.db.close(); }
  const big = fixture();
  try {
    const api = loadRoute('app/api/summaries/[id]/import-analysis/route.ts', big.db);
    assert.equal((await api.POST(post({ text: `${analysis}${' '.repeat(70_000)}` }), context)).status, 413, 'whitespace does not bypass the length limit');
    assert.equal((await api.POST(post({ text: 'x'.repeat(500_000) }), context)).status, 413, 'raw body bytes are capped');
    assert.equal(big.row().external_analysis, null);
  } finally { big.db.close(); }
});

test('notebooklm source download streams timestamped bilingual text and validates lang', async () => {
  const { db } = fixture();
  try {
    const api = loadRoute('app/api/summaries/[id]/notebooklm-source/route.ts', db);
    const response = await api.GET(new NextRequest(url('notebooklm-source')), context);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/plain/);
    assert.match(response.headers.get('content-disposition') || '', /attachment/);
    assert.equal(response.headers.get('x-notebook-source-cues'), '2');
    assert.equal(response.headers.get('x-notebook-source-translated'), '2');
    const text = await response.text();
    assert.ok(text.includes('來源：https://www.youtube.com/watch?v=fixture'));
    assert.ok(text.includes('[00:00] Hello there.\n[00:00] 哈囉。'));
    assert.equal((await api.GET(new NextRequest(url('notebooklm-source', '?lang=fr')), context)).status, 400);
  } finally { db.close(); }
});

test('untranslated rows still export english and refuse a chinese-only pack', async () => {
  const { db } = fixture({ translated: false });
  try {
    const api = loadRoute('app/api/summaries/[id]/notebooklm-source/route.ts', db);
    const bi = await api.GET(new NextRequest(url('notebooklm-source', '?lang=bi')), context);
    assert.equal(bi.status, 200);
    assert.equal(bi.headers.get('x-notebook-source-translated'), '0');
    assert.match(await bi.text(), /注意：中譯尚未完成/);
    assert.equal((await api.GET(new NextRequest(url('notebooklm-source', '?lang=zh')), context)).status, 409);
  } finally { db.close(); }
});
