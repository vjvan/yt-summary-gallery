import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import * as styleModule from '../lib/card-style';
import * as renderModule from '../lib/pipeline/render-card';
import * as summaryModule from '../lib/pipeline/extract-summary';
import * as captionModule from '../lib/pipeline/build-caption';
import * as storeModule from '../lib/aivan-project-store';
import * as projectModule from '../lib/pipeline/build-aivan-project';
import { migrateLearningStorage } from '../lib/learning/store';
import type { VideoMetadata } from '../lib/pipeline/fetch-transcript';

const rowId = 'style_fixture';
const summary = summaryModule.ensureSummaryShape({ title_display: '測試 </script><img src=x onerror=alert(1)>', one_liner: '風格不改變摘要原文' });
const metadata = { video_id: rowId, channel: 'fixture', duration_display: '0:30', title: 'fixture', transcript_source: 'fixture' } as VideoMetadata;
const style = { palette: 'forest-cream', fontPreset: 'bold-statement', background: 'grid-vertical' };
function fixture(rawStyle: string | null = JSON.stringify(style)) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE summaries (id TEXT PRIMARY KEY, video_id TEXT, summary TEXT, card_style TEXT, card_render_token TEXT, pipeline_stage TEXT, error TEXT, card_paths TEXT, slide_count INTEGER)`);
  db.prepare('INSERT INTO summaries VALUES (?,?,?,?,?,?,?,?,?)').run(rowId, rowId, JSON.stringify(summary), rawStyle, null, 'library_complete', null, '["/old.png"]', 20);
  db.exec(`CREATE TABLE aivan_project_versions (id INTEGER PRIMARY KEY, summary_id TEXT, project_id TEXT, revision INTEGER, project_json TEXT, created_at TEXT)`);
  return { db, row: () => db.prepare('SELECT * FROM summaries WHERE id = ?').get(rowId) as Record<string, unknown> };
}
function loadRoute(file: string, db: Database.Database, renderer = renderModule) {
  const testModule = { exports: {} as Record<string, (...args: unknown[]) => Promise<Response>> };
  const imports: Record<string, unknown> = {
    'next/server': { NextRequest, NextResponse }, '@/lib/db': { getDb: () => db },
    '@/lib/card-style': styleModule, '@/lib/pipeline/render-card': renderer,
    '@/lib/pipeline/extract-summary': summaryModule, '@/lib/pipeline/build-caption': captionModule,
    '@/lib/pipeline/build-aivan-project': projectModule, '@/lib/aivan-project-store': storeModule,
    path: { default: path }, 'node:fs': fs, 'node:crypto': crypto,
  };
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(js, { module: testModule, exports: testModule.exports, require: (name: string) => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`);
    if (name === 'path') return path;
    return imports[name];
  }, console: { warn() {}, error() {}, log() {} }, process, URL, Buffer, Set, Error });
  return testModule.exports;
}
function request(route: string, query = '') { return new NextRequest(`http://127.0.0.1:3000/api/summaries/${rowId}/${route}${query}`); }
const context = { params: Promise.resolve({ id: rowId }) };
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('three-axis catalog keeps legacy themes and local-font metadata', async () => {
  const { db } = fixture();
  try {
    const api = loadRoute('app/api/themes/route.ts', db);
    const data = await (await api.GET()).json();
    assert.equal(data.palettes.length, 6); assert.equal(data.themes.length, 6);
    assert.equal(data.fontPresets.length, 4); assert.equal(data.backgrounds.length, 6);
    assert.equal(data.fontPresets[0].display.family, 'Source Han Serif TW');
  } finally { db.close(); }
});

test('regenerate is style-only, holds prior DB style until success, and rejects simultaneous jobs', async () => {
  const { db, row } = fixture(); let release!: (paths: string[]) => void; let calledStyle: unknown;
  try {
    const api = loadRoute('app/api/summaries/[id]/regenerate-cards/route.ts', db, { ...renderModule,
      renderCard: async (_summary: unknown, _metadata: unknown, _dir: unknown, value: unknown) => {
        calledStyle = value; return new Promise<string[]>(resolve => { release = resolve; });
      },
    } as typeof renderModule);
    const response = await api.POST(request('regenerate-cards', '?font=round-display&bg=paper-fiber'), context);
    assert.equal(response.status, 202); assert.equal(row().pipeline_stage, 'library_rendering');
    const token = row().card_render_token; assert.equal(typeof token, 'string');
    assert.equal(row().card_style, JSON.stringify(style)); assert.equal(row().summary, JSON.stringify(summary));
    // A separate subtitle job can finish during rendering; it must NOT unlock us.
    db.prepare("UPDATE summaries SET pipeline_stage='done'").run();
    assert.equal((await api.POST(request('regenerate-cards'), context)).status, 409);
    assert.equal(row().card_render_token, token);
    assert.deepEqual(calledStyle, { ...style, fontPreset: 'round-display', background: 'paper-fiber' });
    release(Array.from({ length: 20 }, (_, i) => `/slide-${i + 1}.png`)); await settle();
    assert.equal(row().pipeline_stage, 'library_complete');
    assert.deepEqual(JSON.parse(String(row().card_style)), calledStyle);
    assert.equal(row().card_render_token, null); assert.equal(row().slide_count, 20); assert.equal(row().summary, JSON.stringify(summary));
  } finally { db.close(); }
});

test('failed render retains previous style/card paths and reports missing font error', async () => {
  const { db, row } = fixture();
  try {
    const api = loadRoute('app/api/summaries/[id]/regenerate-cards/route.ts', db, { ...renderModule, renderCard: async () => { throw new Error('缺少字型：JetBrains Mono'); } });
    assert.equal((await api.POST(request('regenerate-cards', '?font=round-display'), context)).status, 202);
    await settle();
    assert.equal(row().card_render_token, null); assert.equal(row().pipeline_stage, 'library_render_error'); assert.equal(row().error, 'library_render_error: 缺少字型：JetBrains Mono');
    assert.equal(row().card_style, JSON.stringify(style)); assert.equal(row().card_paths, '["/old.png"]');
  } finally { db.close(); }
});

test('all three routes reject invalid ids with 400 and leave DB untouched', async () => {
  const { db, row } = fixture();
  try {
    const before = row();
    for (const route of ['regenerate-cards', 'editor', 'aivan-project']) {
      const api = loadRoute(`app/api/summaries/[id]/${route}/route.ts`, db);
      const response = await api[route === 'regenerate-cards' ? 'POST' : 'GET'](request(route, '?font=does-not-exist'), context);
      assert.equal(response.status, 400, route);
    }
    assert.deepEqual(row(), before);
  } finally { db.close(); }
});

test('legacy NULL styles use defaults in editor/Studio and on successful re-render', async () => {
  const { db, row } = fixture(null);
  try {
    const editor = loadRoute('app/api/summaries/[id]/editor/route.ts', db);
    const html = await (await editor.GET(request('editor', '?preview=1'), context)).text();
    assert.match(html, /Source Han Serif TW/); assert.match(html, /bg-notebook-warm/);
    const studio = loadRoute('app/api/summaries/[id]/aivan-project/route.ts', db);
    const project = await (await studio.GET(request('aivan-project'), context)).json();
    assert.deepEqual(project.cardStyle, styleModule.DEFAULT_CARD_STYLE);
    const regen = loadRoute('app/api/summaries/[id]/regenerate-cards/route.ts', db, { ...renderModule, renderCard: async () => Array(20).fill('fixture.png') });
    await regen.POST(request('regenerate-cards'), context); await settle();
    assert.deepEqual(JSON.parse(String(row().card_style)), styleModule.DEFAULT_CARD_STYLE);
  } finally { db.close(); }
});

test('editor preview has no scripts and shared DB style; quick editor safely serializes title and does not restore old palette', async () => {
  const { db } = fixture();
  try {
    const editor = loadRoute('app/api/summaries/[id]/editor/route.ts', db);
    const preview = await editor.GET(request('editor', '?preview=1'), context);
    const html = await preview.text();
    assert.doesNotMatch(html, /<script\b/i); assert.match(html, /bg-grid-vertical/);
    assert.match(html, /--social-display: "Gekiran"/); assert.equal(preview.headers.get('cache-control'), 'no-store');
    const quickHtml = await (await editor.GET(request('editor'), context)).text();
    assert.match(quickHtml, /"activeStyle":\{"palette":"forest-cream","fontPreset":"bold-statement","background":"grid-vertical"\}/);
    assert.match(quickHtml, /\.split\(\/\\s\+\/\)/);
    assert.doesNotMatch(quickHtml, /CFG\.title \+ '<\/span>/);
    const shell = quickHtml.match(/<script id="editor-script">([\s\S]*?)<\/script>/)?.[1];
    assert.ok(shell); assert.doesNotThrow(() => new vm.Script(shell));
    assert.match(quickHtml, /\\u003c\/script>/); assert.doesNotMatch(quickHtml, /saved\.theme/);
  } finally { db.close(); }
});

test('Studio style matches render HTML and replaces stale draft CSS while preserving text patches', () => {
  const base = projectModule.buildAivanProject(summary, metadata, { projectId: 'yt-fixture', sourceUrl: 'http://localhost/card/fixture', sourceType: 'youtube', originalUrl: '', cardStyle: style });
  assert.equal(base.slides.length, 20); assert.deepEqual(base.cardStyle, style);
  assert.match(base.slides[0].elements[0].css, /--social-display: "Gekiran"/);
  assert.match(base.slides[0].elements[0].html, /bg-grid-vertical/);
  assert.match(base.slides[0].elements[0].html, /class="card-watermark"/);
  assert.doesNotMatch(base.import.css, /\.card::after/);
  const draft = structuredClone(base);
  draft.slides[0].elements[0].html = draft.slides[0].elements[0].html.replace('bg-grid-vertical', 'bg-plain-white');
  draft.slides[0].elements[0].css = ':root{--social-display: serif}';
  draft.slides[0].elements[0].textPatches = { headline: '保留使用者手動改字' };
  projectModule.applyCanonicalProjectStyle(draft, base);
  assert.deepEqual(draft.slides[0].elements[0].textPatches, { headline: '保留使用者手動改字' });
  assert.match(draft.slides[0].elements[0].css, /--social-display: "Gekiran"/);
  assert.match(draft.slides[0].elements[0].html, /bg-grid-vertical/);
  assert.doesNotMatch(draft.slides[0].elements[0].html, /bg-plain-white/);
});


test('DB commit failure cannot replace old images/style and only removes the new version directory', async () => {
  const { db, row } = fixture(); let output = '';
  try {
    const faultDb = { prepare: (sql: string) => {
      if (sql.startsWith('UPDATE summaries SET card_paths')) return { run: () => { throw new Error('simulated commit failure'); } };
      return db.prepare(sql);
    } } as unknown as Database.Database;
    const api = loadRoute('app/api/summaries/[id]/regenerate-cards/route.ts', faultDb, { ...renderModule,
      renderCard: async (_s: unknown, _m: unknown, dir: string) => { output = dir; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'slide-1.png'), 'new isolated output'); return Array(20).fill('fixture.png'); },
    });
    assert.equal((await api.POST(request('regenerate-cards', '?font=round-display'), context)).status, 202);
    await settle();
    assert.match(output, /style-[0-9a-f-]{36}$/); assert.equal(fs.existsSync(output), false);
    assert.equal(row().card_paths, '["/old.png"]'); assert.equal(row().card_style, JSON.stringify(style));
    assert.equal(row().pipeline_stage, 'library_render_error');
  } finally { db.close(); if (output) fs.rmSync(output, { recursive: true, force: true }); }
});

test('startup migration adds nullable card_style to existing summaries without rewriting old records', () => {
  const databaseModule = { exports: {} as { getDb: () => Database.Database } };
  const temporary = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'card-style-migration-'));
  fs.mkdirSync(path.join(temporary, 'data'));
  const oldDb = new Database(path.join(temporary, 'data/summaries.db'));
  oldDb.exec("CREATE TABLE summaries(id TEXT PRIMARY KEY, video_id TEXT, summary TEXT); INSERT INTO summaries VALUES('old','old-video','{\"one_liner\":\"preserved\"}')");
  oldDb.close();
  const js = ts.transpileModule(fs.readFileSync('lib/db.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  let migrated: Database.Database | undefined;
  try {
    const imports: Record<string, unknown> = { 'better-sqlite3': Database, fs, path, './learning/store': { migrateLearningStorage } };
    vm.runInNewContext(js, { module: databaseModule, exports: databaseModule.exports,
      require: (name: string) => { if (!(name in imports)) throw new Error(name); return imports[name]; },
      process: { cwd: () => temporary },
    });
    migrated = databaseModule.exports.getDb();
    const row = migrated.prepare("SELECT summary, card_style FROM summaries WHERE id='old'").get() as Record<string, unknown>;
    assert.equal(row.card_style, null); assert.equal(row.summary, '{"one_liner":"preserved"}');
    for (const table of ['learning_analyses', 'learning_checkpoints', 'learning_point_reviews']) {
      assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} must be migrated by the real startup path`);
      assert.equal((migrated.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0, `${table} must remain empty for an unanalyzed legacy summary`);
    }
    assert.equal(databaseModule.exports.getDb(), migrated);
  } finally { migrated?.close(); fs.rmSync(temporary, { recursive: true, force: true }); }
});
