import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkLearningSource, prepareLearningSource, verifySourceClaim } from '../lib/learning/source';
import { buildLearningPublicDraft } from '../lib/learning/public-draft';
import { parseCandidateBatch, parsePointAnalysis, UnsupportedInterpretationError } from '../lib/learning/validation';
import { pointResult, source, sourceInput } from './learning-fixtures';
test('exact evidence requires source-owned fractional timestamp and literal quote', () => {
  const lines = source().lines;
  assert.equal(verifySourceClaim({ timestamp: 12.16, quote: 'Do not assume growth means profit.' }, lines), true);
  assert.equal(verifySourceClaim({ timestamp: 12, quote: 'Do not assume growth means profit.' }, lines), false);
  assert.equal(verifySourceClaim({ timestamp: 12.16, quote: 'Do assume growth means profit.' }, lines), false);
  assert.equal(verifySourceClaim({ timestamp: 12.16, quote: '不要假定成長就是獲利。' }, lines), false);
  assert.equal(verifySourceClaim({ timestamp: 12.16, quote: 'Do not assume growth means profit. First test' }, lines), false);
});
test('all source lines are retained without middle slicing; invalid timing is visible', () => {
  const segments = Array.from({ length: 60 }, (_, index) => ({ start: index * 5, text: `Line ${index}: ${'source evidence '.repeat(45)}` }));
  const data = prepareLearningSource({ transcript: segments.map(item => item.text).join(' '), segments: JSON.stringify([...segments, { start: -1, text: 'Untimed evidence remains visible.' }]) });
  const chunks = chunkLearningSource(data);
  assert.equal(chunks.flat().map(line => line.text).join(''), data.lines.map(line => line.text).join(''));
  assert.equal(data.unparsedLines, 1);
  assert.ok(chunks.length > 8);
  assert.throws(() => prepareLearningSource({ transcript: '', segments: null }));
  assert.throws(() => prepareLearningSource({ transcript: 'No time stamp in this legacy plain transcript.' }));
});
test('one invalid claim rejects the whole candidate; source semantics must also pass', () => {
  const valid = { timestamp: 12.16, quote: 'Do not assume growth means profit.', explanation: '不要把規模當成利潤。' };
  const mixed = parseCandidateBatch({ candidates: [{ core: '候選', sourceClaims: [valid, { ...valid, timestamp: 999 }] }] }, source().lines, 0);
  assert.equal(mixed.invalidEvidenceCount, 1); assert.equal(mixed.candidates.length, 0);
  const candidate = parseCandidateBatch({ candidates: [{ core: '規模不等於利潤', sourceClaims: [valid] }] }, source().lines, 0).candidates[0];
  assert.throws(() => parsePointAnalysis(pointResult(false), candidate), UnsupportedInterpretationError);
  const point = parsePointAnalysis(pointResult(), candidate);
  assert.equal(point.assessment.credible.answer, 'uncertain');
  assert.ok(point.assessment.credible.reason.includes('未獨立查證'));
});
test('public projection includes only source draft fields, not extra private input fields', () => {
  const claim = { timestamp: 12.16, quote: 'Do not assume growth means profit.', explanation: '原片提醒，成長不能直接當成利潤。', application: 'PRIVATE_APP_TOKEN', profile: 'PRIVATE_PROFILE_TOKEN', notes: 'PRIVATE_NOTE_TOKEN' };
  const draft = buildLearningPublicDraft([claim, claim, { ...claim, timestamp: 999 }], source());
  assert.equal(draft.status, 'insufficient-evidence'); assert.equal(draft.cards.length, 1);
  assert.equal(draft.cards[0].reviewStatus, 'needs-semantic-review');
  assert.equal(JSON.stringify(draft).includes('PRIVATE_'), false);
  assert.deepEqual(Object.keys(draft.cards[0].sourceClaims[0]).sort(), ['quote', 'timestamp']);
  assert.equal(draft.cards[0].sourceHash, prepareLearningSource(sourceInput).hash);
});
