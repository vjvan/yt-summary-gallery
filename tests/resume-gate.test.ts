import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';

// resume.ts 拉進整條舊管線；這裡把模型與渲染相依全部換成會爆炸的替身，
// 任何被呼叫都代表「重啟時偷偷續跑了」。
function loadResume(db: Database.Database, calls: string[]) {
  const boom = (name: string) => async () => { calls.push(name); throw new Error(`${name} must not run on restart`); };
  const testModule = { exports: {} as Record<string, unknown> };
  const imports: Record<string, unknown> = {
    path: path, '@/lib/db': { getDb: () => db },
    './translate': { translateSegments: boom('translateSegments'), translatePlainText: () => '' },
    './burn-bilingual': { writeSubtitleFiles: boom('writeSubtitleFiles') },
    './extract-summary': { extractSummaryVerified: boom('extractSummaryVerified'), ensureSummaryShape: (value: unknown) => value },
    './render-card': { renderCard: boom('renderCard') },
    './start-burn': { maybeAutoBurn: () => {} },
    '../card-style': { resolveCardStyle: () => ({}) },
    './local-youtube-library': { recoverLocalLibraryJobs: () => { calls.push('recoverLocalLibraryJobs'); } },
  };
  const js = ts.transpileModule(fs.readFileSync('lib/pipeline/resume.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  vm.runInNewContext(js, { module: testModule, exports: testModule.exports, require: (name: string) => {
    if (!(name in imports)) throw new Error(`Unexpected dependency ${name}`);
    return imports[name];
  }, console: { log() {}, error() {}, warn() {} }, process, Set, Error, JSON, Promise, Array, Math, String, Number, Object });
  return testModule.exports as {
    recoverZombieJobs: (options?: { autoResume?: boolean }) => void;
    planZombieRecovery: (rows: Array<{ id: string; title: string | null; pipeline_stage: string | null }>, autoResume: boolean) => { resume: unknown[]; fail: Array<{ id: string; reason: string }> };
    autoResumeEnabled: (env: Record<string, string | undefined>) => boolean;
    RESUME_DISABLED_MESSAGE: string;
  };
}

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE summaries (id TEXT PRIMARY KEY, video_id TEXT, title TEXT, status TEXT, pipeline_stage TEXT, error TEXT, burn_status TEXT, burn_error TEXT, segments TEXT, segments_zh TEXT, transcript TEXT, transcript_zh TEXT, is_translated INTEGER, summary TEXT);
    CREATE TABLE project_clips (id TEXT PRIMARY KEY, status TEXT, error TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT, error TEXT);`);
  const insert = db.prepare("INSERT INTO summaries (id, video_id, title, status, pipeline_stage, segments, transcript) VALUES (?,?,?,?,?,?,?)");
  insert.run('a', 'a', '轉錄完', 'processing', 'transcribed', '[{"start":0,"end":1,"text":"hi"}]', 'hi');
  insert.run('b', 'b', '翻譯完', 'processing', 'translated', '[]', 'hi');
  insert.run('c', 'c', '摘要完', 'processing', 'summarized', '[]', 'hi');
  insert.run('d', 'd', '轉錄中', 'processing', null, null, null);
  insert.run('e', 'e', '好的', 'done', 'done', '[]', 'hi');
  db.prepare("UPDATE summaries SET burn_status='burning' WHERE id='e'").run();
  return db;
}

test('the env gate only accepts 1 or true', () => {
  const { autoResumeEnabled } = loadResume(fixture(), []);
  assert.equal(autoResumeEnabled({}), false);
  assert.equal(autoResumeEnabled({ YT_SUMMARY_AUTO_RESUME: '0' }), false);
  assert.equal(autoResumeEnabled({ YT_SUMMARY_AUTO_RESUME: 'yes' }), false);
  assert.equal(autoResumeEnabled({ YT_SUMMARY_AUTO_RESUME: '1' }), true);
  assert.equal(autoResumeEnabled({ YT_SUMMARY_AUTO_RESUME: ' TRUE ' }), true);
});

test('with the gate off, restart marks interrupted jobs as retryable errors and never calls a model', async () => {
  const db = fixture(); const calls: string[] = [];
  const resume = loadResume(db, calls);
  resume.recoverZombieJobs({ autoResume: false });
  await new Promise(resolve => setTimeout(resolve, 30));
  const rows = db.prepare("SELECT id, status, error, segments, transcript FROM summaries ORDER BY id").all() as Array<{ id: string; status: string; error: string | null; segments: string | null; transcript: string | null }>;
  for (const id of ['a', 'b', 'c']) {
    const row = rows.find(item => item.id === id)!;
    assert.equal(row.status, 'error');
    assert.equal(row.error, resume.RESUME_DISABLED_MESSAGE);
    assert.ok(row.transcript, 'finished artefacts stay on the row');
  }
  assert.match(rows.find(item => item.id === 'd')!.error || '', /轉錄尚未完成/);
  assert.equal(rows.find(item => item.id === 'e')!.status, 'done');
  assert.equal((db.prepare("SELECT burn_status FROM summaries WHERE id='e'").get() as { burn_status: string }).burn_status, 'error', 'burn state is still reset');
  assert.deepEqual(calls, ['recoverLocalLibraryJobs'], 'no translate/summarise/render call happened');
});

test('with the gate on, resumable stages are resumed (and the model boundary is hit)', async () => {
  const db = fixture(); const calls: string[] = [];
  const resume = loadResume(db, calls);
  resume.recoverZombieJobs({ autoResume: true });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(calls.includes('translateSegments'), 'stage transcribed resumes into translation');
  const plan = resume.planZombieRecovery([{ id: 'x', title: null, pipeline_stage: 'summarized' }, { id: 'y', title: null, pipeline_stage: null }], true);
  assert.equal(plan.resume.length, 1);
  assert.equal(plan.fail.length, 1);
  // VM realm 的陣列原型不同，不能用 deepEqual 比空陣列。
  assert.equal(resume.planZombieRecovery([{ id: 'x', title: null, pipeline_stage: 'summarized' }], false).resume.length, 0);
});

test('the process env default keeps the gate closed', () => {
  const { autoResumeEnabled } = loadResume(fixture(), []);
  const saved = process.env.YT_SUMMARY_AUTO_RESUME;
  delete process.env.YT_SUMMARY_AUTO_RESUME;
  try { assert.equal(autoResumeEnabled(process.env), false); } finally { if (saved !== undefined) process.env.YT_SUMMARY_AUTO_RESUME = saved; }
});
