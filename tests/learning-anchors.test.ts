import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkLearningSource, prepareLearningSource, verifySourceClaim } from '../lib/learning/source';
import { parseAnchoredCandidateBatch } from '../lib/learning/validation';
import { sourceInterpretationError } from '../lib/learning/source-gates';
import { normalizeLearningProse } from '../lib/learning/language';
import { runLearningPipeline, LearningPipelineError } from '../lib/learning/pipeline';
import { fixtureRequest, source } from './learning-fixtures';
const controller = () => new AbortController().signal;
test('source anchors are unique across long-line pieces, quote/time are copied from the chosen piece exactly', () => {
  const text = `Beginning ${'source fragment '.repeat(85)} ending.`;
  const data = prepareLearningSource({ transcript: text, segments: JSON.stringify([{ start: 12.16, text }]) });
  const lines = chunkLearningSource(data).flat();
  assert.equal(new Set(lines.map(line => line.anchorId)).size, lines.length);
  assert.equal(lines.map(line => line.text).join(''), text);
  assert.ok(lines.every(line => line.text.length <= 480));
  const chosen = lines[1];
  const batch = parseAnchoredCandidateBatch({ candidates: [{ core: '原片的觀點。', sourceClaims: [{ lineId: chosen.anchorId, explanation: '原片的說明。' }] }] }, lines, 0);
  assert.equal(batch.candidates.length, 1);
  const claim = batch.candidates[0].sourceClaims[0];
  assert.equal(claim.quote, chosen.text); assert.equal(claim.timestamp, 12.16); assert.equal(verifySourceClaim(claim, data.lines), true);
  assert.notEqual(claim.quote, lines[0].text);
});
test('unknown anchor and forged timestamp fields are rejected, but another valid candidate is retained', () => {
  const lines = chunkLearningSource(source()).flat();
  const good = { core: '不要把成長當獲利。', sourceClaims: [{ lineId: lines[0].anchorId, explanation: '不應假設成長就是獲利。' }] };
  const bad = { core: '錯誤引用', sourceClaims: [{ lineId: 'line-999-0', explanation: '不存在的資料。' }] };
  const batch = parseAnchoredCandidateBatch({ candidates: [bad, good] }, lines, 0);
  assert.equal(batch.candidates.length, 1); assert.equal(batch.invalidEvidenceCount, 1);
  const forged = parseAnchoredCandidateBatch({ candidates: [{ ...good, sourceClaims: [{ ...good.sourceClaims[0], timestamp: 999 }] }] }, lines, 0);
  assert.equal(forged.candidates.length, 0);
});
test('8 figures is not silently upgraded to revenue/profit; negation and unsupported numbers are blocked', () => {
  assert.equal(sourceInterpretationError('We scaled from zero to 8 figures in one year.', '受訪者自述一年達到8位數營收。'), 'EIGHT_FIGURES_NOT_REVENUE');
  assert.equal(sourceInterpretationError('We scaled from zero to 8 figures in one year.', '受訪者自述一年達到8位數規模。'), null);
  assert.equal(sourceInterpretationError('We reached 8 figures in revenue.', '受訪者自述8位數營收。'), null);
  assert.equal(sourceInterpretationError('Do not assume growth means profit.', '成長代表獲利。'), 'NEGATION_REQUIRES_REVIEW');
  assert.equal(sourceInterpretationError('Do not assume growth means profit.', '不要假定成長代表獲利。'), null);
  assert.equal(sourceInterpretationError('There are 12 employees.', '共有20名員工。'), 'UNSUPPORTED_NUMERIC_CLAIM');
  assert.equal(sourceInterpretationError('Create 100,000 jobs.', '創造10萬個工作機會。'), null);
});
test('Taiwan normalization applies only to model prose, never quote, anchor ID or timestamp', () => {
  assert.equal(normalizeLearningProse('Qwen2.5 软件界面视频'), 'Qwen2.5 軟體介面影片');
  const raw = '这是我们的视频软件界面，不是事实查证。';
  const data = prepareLearningSource({ transcript: raw, segments: JSON.stringify([{ start: 1.12, text: raw }]) }); const lines = chunkLearningSource(data).flat();
  const batch = parseAnchoredCandidateBatch({ candidates: [{ core: '视频软件界面', sourceClaims: [{ lineId: lines[0].anchorId, explanation: '这是视频软件界面。' }] }] }, lines, 0);
  assert.equal(batch.candidates[0].core, '影片軟體介面');
  assert.equal(batch.candidates[0].sourceClaims[0].quote, raw);
  assert.equal(batch.candidates[0].sourceClaims[0].timestamp, 1.12);
  assert.equal(lines[0].anchorId, 'line-0-0');
});
test('three consecutive fully-rejected chunks fail fast with a safe code and preserve partial diagnostic checkpoints', async () => {
  const segments = Array.from({ length: 20 }, (_, index) => ({ start: index, text: 'Literal source evidence. '.repeat(45) }));
  const data = prepareLearningSource({ transcript: segments.map(line => line.text).join(' '), segments: JSON.stringify(segments) });
  let calls = 0; const cache = new Map<string, unknown>();
  await assert.rejects(runLearningPipeline(data, { model: 'fixture', signal: controller(), load: key => cache.get(key), save: (key, value) => { cache.set(key, value); }, progress: () => {},
    request: async () => { calls++; return JSON.stringify({ candidates: [{ core: '無效候選', sourceClaims: [{ lineId: 'line-999999-0', explanation: '來源不存在。' }] }] }); },
  }), (error: unknown) => error instanceof LearningPipelineError && error.code === 'EXTRACTION_CONSECUTIVE_REJECTIONS');
  assert.equal(calls, 3); assert.equal(cache.size, 3); assert.ok([...cache.keys()].every(key => key.endsWith(':partial')));
});
test('one bad candidate does not block a valid point or lose its partial checkpoint', async () => {
  const cache = new Map<string, unknown>(); const base = fixtureRequest();
  const result = await runLearningPipeline(source(), { model: 'fixture', signal: controller(), load: key => cache.get(key), save: (key, value) => { cache.set(key, value); }, progress: () => {},
    request: async input => { const raw = JSON.parse(await base(input)); if (raw.candidates) raw.candidates.push({ core: '壞引用', sourceClaims: [{ lineId: 'line-999-0', explanation: '錯誤。' }] }); return JSON.stringify(raw); },
  });
  assert.equal(result.partial, true); assert.equal(result.analysis.points.length, 1);
  assert.equal(result.analysis.coverage.invalidEvidenceCount, 1); assert.ok([...cache.keys()].some(key => key.endsWith(':partial')));
});
