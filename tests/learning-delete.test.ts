import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
import { migrateLearningStorage } from '../lib/learning/store';

// Exercise the production DELETE route against a temporary synthetic SQLite DB.
// Every route filesystem deletion is intercepted; never touch staged/real media.
const code = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'app/api/summaries/[id]/route.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const tables = ['learning_analyses', 'learning_checkpoints', 'learning_point_reviews'] as const;
async function fixture(run: (db: Database.Database) => Promise<void>, learningTables = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-delete-fixture-'));
  const db = new Database(path.join(directory, 'fixture.db'));
  try {
    db.exec(`CREATE TABLE summaries(id TEXT PRIMARY KEY, video_id TEXT UNIQUE, video_url TEXT, audio_url TEXT,
      burned_video_url TEXT, burned_zh_url TEXT, burned_en_url TEXT);
      CREATE TABLE aivan_project_versions(summary_id TEXT PRIMARY KEY, payload TEXT);`);
    for (const suffix of ['a', 'b']) {
      db.prepare('INSERT INTO summaries(id,video_id,video_url) VALUES(?,?,?)').run(`summary-${suffix}`, `video-${suffix}`, `/videos/video-${suffix}.mp4`);
      db.prepare('INSERT INTO aivan_project_versions(summary_id,payload) VALUES(?,?)').run(`summary-${suffix}`, `project-${suffix}`);
    }
    if (learningTables) {
      migrateLearningStorage(db);
      for (const suffix of ['a', 'b']) {
        const id = `summary-${suffix}`;
        db.prepare('INSERT INTO learning_analyses(summary_id,status,progress_json,analysis_json,updated_at) VALUES(?,?,?,?,?)').run(id, 'complete', '{}', `private-analysis-${suffix}`, 1);
        db.prepare('INSERT INTO learning_checkpoints(summary_id,cache_key,payload_json,updated_at) VALUES(?,?,?,?)').run(id, 'checkpoint', `private-checkpoint-${suffix}`, 1);
        db.prepare('INSERT INTO learning_point_reviews(summary_id,source_hash,point_id,reason,implementation_json,updated_at) VALUES(?,?,?,?,?,?)').run(id, 'source', 'point', `private-reason-${suffix}`, `private-practice-${suffix}`, 1);
      }
    }
    await run(db);
  } finally { db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
function route(db: Database.Database) {
  const removed: string[] = [];
  const exports: { DELETE?: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> } = {};
  vm.runInNewContext(code, { exports, process: { cwd: () => process.cwd() },
    require(name: string) {
      if (name === 'next/server') return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
      if (name === '@/lib/db') return { getDb: () => db };
      if (name === 'fs') return { rmSync: (file: string) => { removed.push(file); } };
      if (name === 'path') return path;
      throw Error('Unexpected route dependency: ' + name);
    },
  });
  return { removed, delete: (id: string) => exports.DELETE!(new Request(`http://127.0.0.1/api/summaries/${id}`, { method: 'DELETE' }), { params: Promise.resolve({ id }) }) };
}
const count = (db: Database.Database, table: string, id: string) => (db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE summary_id=?`).get(id) as { total: number }).total;

test('DELETE by video alias removes that summary private analysis/checkpoints/notes but leaves another video intact', async () => {
  await fixture(async db => {
    const api = route(db); const response = await api.delete('video-a');
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
    for (const table of [...tables, 'aivan_project_versions']) {
      assert.equal(count(db, table, 'summary-a'), 0, table);
      assert.equal(count(db, table, 'summary-b'), 1, `${table}: other video retained`);
    }
    assert.equal(db.prepare('SELECT id FROM summaries WHERE id=?').get('summary-a'), undefined);
    assert.ok(db.prepare('SELECT id FROM summaries WHERE id=?').get('summary-b'));
    assert.ok(api.removed.length > 0);
    assert.ok(api.removed.every(file => file.includes('video-a') && !file.includes('video-b')), 'only intercepted target media paths were selected');
  });
});

test('legacy database without learning tables still deletes safely without creating private storage', async () => {
  await fixture(async db => {
    const response = await route(db).delete('summary-a'); assert.equal(response.status, 200);
    for (const table of tables) assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), undefined);
    assert.ok(db.prepare('SELECT id FROM summaries WHERE id=?').get('summary-b'));
  }, false);
});

test('private table cleanup rolls back atomically when summary deletion fails', async () => {
  await fixture(async db => {
    db.exec("CREATE TRIGGER block_fixture_delete BEFORE DELETE ON summaries WHEN OLD.id='summary-a' BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END;");
    await assert.rejects(() => route(db).delete('summary-a'), /synthetic rollback/);
    for (const table of [...tables, 'aivan_project_versions']) assert.equal(count(db, table, 'summary-a'), 1, `${table} rolled back`);
    assert.ok(db.prepare('SELECT id FROM summaries WHERE id=?').get('summary-a'));
  });
});

test('missing summary returns 404 without deleting media or another video private data', async () => {
  await fixture(async db => {
    const api = route(db); const response = await api.delete('not-present');
    assert.equal(response.status, 404); assert.deepEqual(api.removed, []);
    assert.deepEqual(await response.json(), { error: 'Not found' });
    for (const table of tables) assert.equal(count(db, table, 'summary-b'), 1);
  });
});
