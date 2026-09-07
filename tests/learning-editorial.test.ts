import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../app/api/summaries/[id]/learning/route';
import { parseLearningPatch, parseLearningPost, parsePointAnalysis, parseCandidateBatch, LearningInputError } from '../lib/learning/validation';
import { runLearningPipeline } from '../lib/learning/pipeline';
import { fixtureRequest, pointResult, source } from './learning-fixtures';
import type { LearningEditorialReview } from '../lib/learning/types';

const editorialReview: LearningEditorialReview = { kind: 'assistant-source-review', reviewedAt: '2026-09-07T03:00:00.000Z', originalPointCount: 7, retainedPointCount: 3, scope: 'transcript-only', notes: ['助理示範，不是人類查證。'] };
const invalidInput = (error: unknown) => error instanceof LearningInputError && error.status === 400;

test('API mutation schemas reject forged editorial-review metadata at every writable level', async () => {
  assert.throws(() => parseLearningPost({ action: 'generate', consent: true, editorialReview }), invalidInput);
  const body = { sourceHash: 'a'.repeat(64), pointId: 'point-1234567890abcdef', reason: '私人分類理由' };
  assert.throws(() => parseLearningPatch({ ...body, editorialReview }), invalidInput);
  assert.throws(() => parseLearningPatch({ ...body, implementation: { action: '試做', result: '待觀察', observedAt: '2026-09-07T03:00:00.000Z', editorialReview } }), invalidInput);
  // The real POST rejects extra metadata before creating a service or reading a database.
  const request = new Request('http://localhost:3000/api/summaries/fixture/learning', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'generate', consent: true, editorialReview }) });
  assert.equal((await POST(request, { params: Promise.resolve({ id: 'fixture' }) })).status, 400);
});

test('model output cannot claim editorial review and ordinary pipeline output remains unmarked', async () => {
  const candidate = parseCandidateBatch({ candidates: [{ core: '不要把成長當成利潤。', sourceClaims: [{ timestamp: 12.16, quote: 'Do not assume growth means profit.', explanation: '不要把成長視為利潤。' }] }] }, source().lines, 0).candidates[0];
  assert.throws(() => parsePointAnalysis({ ...pointResult(), editorialReview }, candidate), invalidInput);
  const cache = new Map<string, unknown>();
  const result = await runLearningPipeline(source(), { model: 'fixture-local', request: fixtureRequest(), signal: new AbortController().signal,
    load: key => cache.get(key), save: (key, value) => { cache.set(key, value); }, progress: () => {} });
  assert.equal(result.analysis.editorialReview, undefined);
  assert.equal('editorialReview' in result.analysis, false);
  assert.equal(JSON.stringify(result.analysis.publicCards).includes('editorialReview'), false);
});
