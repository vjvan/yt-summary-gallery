import test from 'node:test';
import assert from 'node:assert/strict';
import { runLearningPipeline, LearningPipelineError } from '../lib/learning/pipeline';
import { prepareLearningSource } from '../lib/learning/source';
import { fixtureRequest, pointResult, source } from './learning-fixtures';
import type { requestLocalTranslation } from '../lib/watch/local-translator';
const deps = (request: typeof requestLocalTranslation, cache = new Map<string, unknown>()) => ({ model: 'fixture-local', request, signal: new AbortController().signal,
  load: (key: string) => cache.get(key), save: (key: string, value: unknown) => { cache.set(key, value); }, progress: () => {} });
test('pipeline uses source-only extraction/public draft and authorized private goals; retry uses checkpoints', async () => {
  let calls = 0; const cache = new Map<string, unknown>();
  const request = fixtureRequest(input => {
    calls++;
    const data = JSON.parse(input.messages[1].content);
    if (data.sourceLines) { assert.equal(data.authorizedProfile, undefined); assert.equal(JSON.stringify(data).includes('企業主'), false); }
    if (data.candidate) assert.deepEqual(data.authorizedProfile.goals, ['AI 影片製作', '建立可重複使用的工作流程', '影像編輯', '教學與服務中高齡企業主']);
  });
  const first = await runLearningPipeline(source(), deps(request, cache));
  assert.equal(first.partial, false); assert.equal(first.analysis.points.length, 1);
  assert.equal(first.analysis.coverage.processedSourceLines, 2);
  assert.equal(first.analysis.points[0].application.decision.includes('PRIVATE_APP_TOKEN'), true);
  assert.equal(JSON.stringify(first.analysis.publicCards).includes('PRIVATE_APP_TOKEN'), false);
  const count = calls; await runLearningPipeline(source(), deps(request, cache)); assert.equal(calls, count);
});
test('a failed source chunk remains in coverage and is retried without repeating good extraction', async () => {
  const lines = Array.from({ length: 7 }, (_, index) => ({ start: index * 10, text: `Source ${index}: ${'reliable literal source evidence. '.repeat(30)}` }));
  const long = prepareLearningSource({ transcript: lines.map(line => line.text).join(' '), segments: JSON.stringify(lines) });
  const cache = new Map<string, unknown>(); let failing = true; const inputs: string[] = [];
  const base = fixtureRequest();
  const request: typeof base = async input => {
    const data = JSON.parse(input.messages[1].content);
    if (data.sourceLines) { inputs.push(data.sourceLines[0].text); if (failing && data.sourceLines.some((line: { timestamp: number }) => line.timestamp === 30)) throw new Error('mock extraction failure'); }
    return base(input);
  };
  const result = await runLearningPipeline(long, deps(request, cache));
  assert.equal(result.partial, true); assert.ok(result.analysis.coverage.failedChunks.length);
  const initial = inputs.length; failing = false;
  const retried = await runLearningPipeline(long, deps(request, cache));
  assert.equal(retried.partial, false); assert.equal(inputs.length, initial + result.analysis.coverage.failedChunks.length);
});
test('unsupported core/explanation cannot enter private points or public draft', async () => {
  const base = fixtureRequest();
  await assert.rejects(runLearningPipeline(source(), deps(async input => {
    const data = JSON.parse(input.messages[1].content);
    return data.candidate ? JSON.stringify(pointResult(false)) : base(input);
  })), (error: unknown) => error instanceof LearningPipelineError && error.code === 'SOURCE_REVIEW_REJECTED');
});
test('bounded selection yields at most 8 points, never pads to 20 and selected source draft excludes omitted candidates', async () => {
  const lines = Array.from({ length: 16 }, (_, index) => ({ start: index * 10, text: `Unique line ${index}: ${'A source claim with evidence and conditions. '.repeat(50)}` }));
  const long = prepareLearningSource({ transcript: lines.map(line => line.text).join(' '), segments: JSON.stringify(lines) });
  const result = await runLearningPipeline(long, deps(fixtureRequest()));
  assert.ok(result.analysis.coverage.candidateCount > 8);
  assert.ok(result.analysis.points.length <= 8);
  const kept = new Set(result.analysis.points.flatMap(point => point.sourceClaims.map(claim => claim.timestamp)));
  assert.ok(result.analysis.publicCards.cards.every(card => card.sourceClaims.every(claim => kept.has(claim.timestamp))));
  assert.equal(result.analysis.publicCards.status, 'insufficient-evidence');
});
test('a split long source line is counted only when all pieces have been processed', async () => {
  const text = 'Exact literal source evidence. '.repeat(300);
  const long = prepareLearningSource({ transcript: text, segments: JSON.stringify([{ start: 1, text }, { start: 20, text: 'A separate source line with enough evidence.' }]) });
  let extraction = 0; const base = fixtureRequest();
  const result = await runLearningPipeline(long, deps(async input => {
    const data = JSON.parse(input.messages[1].content);
    if (data.sourceLines && ++extraction === 2) throw new Error('mock second piece failed');
    return base(input);
  }));
  assert.equal(result.partial, true); assert.equal(result.analysis.coverage.totalSourceLines, 2);
  assert.equal(result.analysis.coverage.processedSourceLines, 1);
});
