import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { LearningStore, LEARNING_LEASE_MS } from '../lib/learning/store';
import { LearningService } from '../lib/learning/service';
import { parseLearningPatch, parseLearningPost, LearningInputError } from '../lib/learning/validation';
import { fixtureRequest, sourceInput } from './learning-fixtures';
import type { requestLocalTranslation } from '../lib/watch/local-translator';
function setup(request = fixtureRequest()) {
  const db = new Database(':memory:'); const store = new LearningStore(db); let model = 'fixture-v1';
  const service = new LearningService({ store, source: id => id === 'absent' ? undefined : id === 'legacy-empty' ? { transcript: '' } : sourceInput,
    model: () => model, request });
  return { db, store, service, model: (value: string) => { model = value; } };
}
test('legacy read is idle and never generates; empty source cannot be generated', () => {
  let calls = 0; const { db, service } = setup(fixtureRequest(() => { calls++; }));
  assert.deepEqual(service.get('legacy-empty'), { status: 'idle', progress: { stage: 'idle', completed: 0, total: 0, message: '尚未啟動；閱讀此頁不會呼叫模型。' }, analysis: null, error: null });
  assert.throws(() => service.generate('legacy-empty'), error => error instanceof LearningInputError && error.status === 422);
  assert.throws(() => service.get('absent'), error => error instanceof LearningInputError && error.status === 404);
  assert.equal(calls, 0); db.close();
});
test('reentry is idempotent, another movie is blocked, cancellation aborts without losing checkpoints', async () => {
  let calls = 0;
  const request: typeof requestLocalTranslation = async input => {
    calls++;
    return new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(new Error('mock aborted')), { once: true }));
  };
  const { db, service } = setup(request);
  const first = service.generate('video'); assert.equal(first.accepted, true);
  const second = service.generate('video'); assert.equal(second.accepted, true);
  assert.throws(() => service.generate('another'), error => error instanceof LearningInputError && error.status === 409);
  await Promise.resolve(); assert.equal(calls, 1);
  const settled = service.settled('video'); assert.equal(service.cancel('video').status, 'cancelled'); await settled;
  assert.equal(service.get('video').status, 'cancelled'); assert.equal(calls, 1); db.close();
});
test('failed retry retains last completed analysis and private notes; version change permits rerun', async () => {
  let failed = false; const base = fixtureRequest();
  const fixture = setup(async input => { if (failed) throw new Error('RAW_SECRET_PROVIDER_ERROR'); return base(input); });
  const { db, service, store } = fixture;
  service.generate('video'); await service.settled('video');
  const previous = service.get('video').analysis!; assert.equal(service.get('video').status, 'complete');
  assert.equal(service.generate('video').accepted, false);
  const point = previous.points[0];
  service.patch('video', { sourceHash: previous.sourceHash, pointId: point.id, disposition: 'later', reason: '先處理目前工作。', implementation: { action: '試做', result: 'PRIVATE_NOTE_TOKEN', observedAt: '2026-09-07T08:00:00.000Z' } });
  // Simulate a prompt version change without modifying production constants.
  const staleVersion = { ...previous, version: 'previous-version' };
  db.prepare('UPDATE learning_analyses SET analysis_json=? WHERE summary_id=?').run(JSON.stringify(staleVersion), 'video');
  assert.equal(store.start('video', previous.sourceHash, previous.model).started, true); store.cancel('video');
  failed = true; fixture.model('fixture-v2'); service.generate('video'); await service.settled('video');
  const response = service.get('video'); assert.equal(response.status, 'failed');
  assert.equal(response.analysis!.points[0].disposition, 'later');
  assert.equal(response.analysis!.points[0].implementationRecords[0].result, 'PRIVATE_NOTE_TOKEN');
  assert.equal(JSON.stringify(response.analysis!.publicCards).includes('PRIVATE_NOTE_TOKEN'), false);
  assert.equal(response.error!.includes('RAW_SECRET'), false);
  assert.throws(() => service.patch('video', { sourceHash: 'f'.repeat(64), pointId: point.id, reason: 'wrong version' }), error => error instanceof LearningInputError && error.status === 409);
  db.close();
});
test('expired restart becomes failed, never silently reruns; migration does not modify summaries', () => {
  const { db, store } = setup();
  db.exec("CREATE TABLE summaries(id TEXT PRIMARY KEY, summary TEXT, transcript TEXT); INSERT INTO summaries VALUES('video','LEGACY_SUMMARY','LEGACY_TRANSCRIPT');");
  store.start('video', 'a'.repeat(64), 'fixture');
  db.prepare('UPDATE learning_analyses SET updated_at=?').run(Date.now() - LEARNING_LEASE_MS - 10);
  assert.equal(store.get('video').status, 'failed');
  assert.deepEqual(db.prepare('SELECT * FROM summaries').get(), { id: 'video', summary: 'LEGACY_SUMMARY', transcript: 'LEGACY_TRANSCRIPT' });
  db.close();
});
test('strict payload validation rejects forged fields, missing consent, malformed classification and dates', () => {
  assert.deepEqual(parseLearningPost({ action: 'generate', consent: true }), { action: 'generate', consent: true });
  for (const value of [{ action: 'generate' }, { action: 'generate', consent: 'true' }, { action: 'generate', consent: true, model: 'evil' }, { action: 'cancel', consent: true }]) assert.throws(() => parseLearningPost(value));
  const base = { sourceHash: 'a'.repeat(64), pointId: 'point-1234567890abcdef' };
  for (const value of [{ ...base }, { ...base, disposition: 'urgent' }, { ...base, reason: 'x'.repeat(1201) }, { ...base, sourceClaims: [] }, { ...base, implementation: { action: 'x', result: 'y', observedAt: 'yesterday' } }]) assert.throws(() => parseLearningPatch(value));
  assert.equal(parseLearningPatch({ ...base, reason: '' }).reason, '');
});
test('changed source keeps previous result visibly stale but refuses stale-hash note writes', async () => {
  const db = new Database(':memory:'); const store = new LearningStore(db); let raw = sourceInput;
  const service = new LearningService({ store, source: () => raw, model: () => 'fixture-local', request: fixtureRequest() });
  service.generate('video'); await service.settled('video'); const old = service.get('video').analysis!;
  raw = { ...sourceInput, transcript: `${sourceInput.transcript} Updated source.` };
  const stale = service.get('video'); assert.equal(stale.status, 'partial'); assert.ok(stale.error!.includes('STALE_ANALYSIS')); assert.equal(stale.analysis!.sourceHash, old.sourceHash);
  assert.throws(() => service.patch('video', { sourceHash: old.sourceHash, pointId: old.points[0].id, disposition: 'now' }), error => error instanceof LearningInputError && error.status === 409);
  assert.equal(service.generate('video').accepted, true); await service.settled('video'); assert.notEqual(service.get('video').analysis!.sourceHash, old.sourceHash); db.close();
});
test('cancelled or deleted runs cannot write orphan checkpoints', () => {
  const { db, store } = setup(); const run = store.start('video', 'a'.repeat(64), 'fixture');
  store.saveCheckpoint('video', run.token!, 'valid', { ok: true }); store.cancel('video');
  assert.throws(() => store.saveCheckpoint('video', run.token!, 'cancelled', { bad: true }));
  db.prepare('DELETE FROM learning_analyses WHERE summary_id=?').run('video');
  assert.throws(() => store.saveCheckpoint('video', run.token!, 'orphan', { bad: true }));
  assert.equal((db.prepare('SELECT count(*) AS n FROM learning_checkpoints').get() as { n: number }).n, 1); db.close();
});
