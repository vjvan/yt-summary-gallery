import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canPumpWatchWindow, canRetryWatchWindow, mayApplyWatchResult, shouldCancelWatchWindow,
  watchBlockForTime, watchClientFailure, watchFailureCopy, watchTargetBlock,
} from '../lib/watch/client-state';
import type { WatchCue } from '../lib/watch/types';

const cues: WatchCue[] = Array.from({ length: 24 }, (_, index) => ({
  id: `cue-${index}`, start: index * 2.5, end: (index + 1) * 2.5, text: `Original ${index}`,
}));
const failed = watchClientFailure(0, '翻譯未產生繁中字幕；不會把原文 fallback 當作成功結果。', 502, 'MODEL_FAILED');
const run = () => ({ enabled: true, playing: true, stopped: false, pending: null as unknown,
  failure: failed as typeof failed | null, retryRequested: false });

test('model failure keeps enabled intent but blocks every automatic pump, including later batches', () => {
  const state = run();
  for (const time of [0, 19.9, 20, 41, 59]) {
    assert.ok(watchBlockForTime(cues, time) >= 0);
    assert.equal(canPumpWatchWindow(state), false);
  }
  assert.equal(state.enabled, true);
  assert.match(watchFailureCopy(failed, { ...state, pending: false }).status, /已啟用，但翻譯失敗/);
  assert.equal(watchFailureCopy(failed, { ...state, pending: false }).button, '重試目前區段');
});

test('pause and resume do not erase failure or trigger implicit retry', () => {
  const state = run();
  for (const playing of [false, true, false, true]) {
    state.playing = playing;
    assert.equal(canPumpWatchWindow(state), false);
    assert.equal(state.failure?.message, failed.message);
    assert.doesNotMatch(watchFailureCopy(failed, { ...state, pending: false }).caption, /尚未啟用/);
  }
});

test('manual retry is queued while paused, then admits one request, not concurrent retries', () => {
  const state = run(); state.playing = false;
  const allowed = () => canRetryWatchWindow({ ...state, consent: true, sourceReady: true });
  assert.equal(allowed(), true);
  state.retryRequested = true;
  assert.equal(allowed(), false);
  assert.equal(canPumpWatchWindow(state), false);
  const copy = watchFailureCopy(failed, { ...state, pending: false });
  assert.match(copy.status, /已排定重試.*等待播放/);
  assert.match(copy.description, /原始錯誤.*保留到重試成功/);
  state.playing = true;
  assert.equal(canPumpWatchWindow(state), true);
  state.pending = { block: 0 };
  assert.equal(canPumpWatchWindow(state), false);
  assert.equal(allowed(), false);
  // A second failure consumes the manual retry; no clock tick can retry again.
  state.pending = null; state.retryRequested = false;
  assert.equal(canPumpWatchWindow(state), false);
  // Only an actual success clears failure and permits normal progress.
  state.failure = null;
  assert.equal(canPumpWatchWindow(state), true);
});

test('consent withdrawal, stopped work and unavailable source forbid retry', () => {
  const input = { ...run(), consent: true, sourceReady: true };
  for (const patch of [{ consent: false }, { sourceReady: false }, { stopped: true }, { pending: {} }, { retryRequested: true }]) {
    assert.equal(canRetryWatchWindow({ ...input, ...patch }), false);
  }
});

test('expired pairing, session and changed provider require reload; quota cannot be bypassed', () => {
  for (const [status, code] of [[401, 'UNAUTHORIZED'], [410, 'SESSION_EXPIRED'], [409, 'SESSION_PROVIDER_CHANGED'], [403, 'PROCESSING_MODE_CHANGED']] as const) {
    const failure = watchClientFailure(0, 'original error', status, code);
    assert.equal(failure.recovery, 'reload');
    assert.equal(canRetryWatchWindow({ ...run(), failure, consent: true, sourceReady: true }), false);
    assert.equal(canPumpWatchWindow({ ...run(), failure, retryRequested: true }), false);
    assert.equal(watchFailureCopy(failure, { enabled: false, retryRequested: false, playing: true, pending: false }).button, '重新載入影片與原文');
  }
  assert.equal(watchClientFailure(0, 'quota', 429, 'SESSION_LIMIT').recovery, 'limit');
  assert.equal(watchClientFailure(0, 'busy', 503, 'BUSY').recovery, 'retry');
});

test('eight-cue selection preserves one-batch, 30-second lookahead', () => {
  assert.equal(watchBlockForTime(cues, 19.99), 0);
  assert.equal(watchBlockForTime(cues, 20), 1);
  assert.equal(watchTargetBlock(cues, 0, new Set()), 0);
  assert.equal(watchTargetBlock(cues, 0, new Set([0])), 1);
  assert.equal(watchTargetBlock(cues, 0, new Set([0, 1])), -1);
  assert.equal(watchTargetBlock(cues, 60, new Set()), -1);
  const distant = cues.map((cue, index) => index >= 8 ? { ...cue, start: cue.start + 100, end: cue.end + 100 } : cue);
  assert.equal(watchTargetBlock(distant, 0, new Set([0])), -1);
});

test('slow response survives normal 40-second playback crossing two 20-second batches', async () => {
  let generation = 1;
  const requestGeneration = generation;
  const controller = new AbortController();
  let resolve!: (value: string) => void;
  const response = new Promise<string>(done => { resolve = done; });
  let previousTime = 0;
  for (let time = 0.25; time <= 40; time += 0.25) {
    if (shouldCancelWatchWindow({ previousTime, nextTime: time, elapsedMs: 250, playing: true,
      pendingBlock: 0, destinationBlock: watchBlockForTime(cues, time) })) {
      generation++; controller.abort();
    }
    previousTime = time;
  }
  resolve('真正繁中譯文');
  const result = await response;
  assert.equal(controller.signal.aborted, false);
  assert.equal(mayApplyWatchResult({ requestGeneration, generation, requestSessionId: 'same-session', sessionId: 'same-session', aborted: controller.signal.aborted }), true);
  assert.equal(result, '真正繁中譯文');
});

test('2x playback and delayed background polling are not mistaken for seeks', () => {
  for (const [previousTime, nextTime, elapsedMs] of [[19.8, 20.3, 250], [19, 39, 10_000], [19, 59, 20_000]]) {
    assert.equal(shouldCancelWatchWindow({ previousTime, nextTime, elapsedMs, playing: true,
      pendingBlock: 0, destinationBlock: watchBlockForTime(cues, nextTime) }), false);
  }
});

test('real forward/backward jumps and explicit transcript seek supersede only other pending batches', () => {
  const base = { previousTime: 10, nextTime: 45, elapsedMs: 250, playing: true, pendingBlock: 0, destinationBlock: 2 };
  assert.equal(shouldCancelWatchWindow(base), true);
  assert.equal(shouldCancelWatchWindow({ ...base, previousTime: 45, nextTime: 1, pendingBlock: 2, destinationBlock: 0 }), true);
  assert.equal(shouldCancelWatchWindow({ ...base, previousTime: 19.9, nextTime: 20, destinationBlock: 1, explicitSeek: true }), true);
  assert.equal(shouldCancelWatchWindow({ ...base, destinationBlock: 0, explicitSeek: true }), false);
  assert.equal(shouldCancelWatchWindow({ ...base, pendingBlock: null, explicitSeek: true }), false);
});

test('a late response after seek, cancellation, stop or switching videos cannot be applied', () => {
  const base = { requestGeneration: 1, generation: 1, requestSessionId: 'old', sessionId: 'old', aborted: false };
  assert.equal(mayApplyWatchResult(base), true);
  for (const patch of [{ generation: 2 }, { aborted: true }, { sessionId: 'new' }, { sessionId: undefined }]) {
    assert.equal(mayApplyWatchResult({ ...base, ...patch }), false);
  }
});

test('WatchClient wires tested gates and never clears all failed blocks during enable/retry', () => {
  const client = readFileSync(new URL('../components/WatchClient.tsx', import.meta.url), 'utf8');
  assert.match(client, /watchScheduleDecision\(\{ \.\.\.current/);
  assert.match(client, /decision\.kind === "idle"/);
  assert.match(client, /current\.pending\?\.controller === controller/);
  assert.match(client, /shouldPreemptWatchWindow\(current\.scheduleMode/);
  assert.match(client, /!mayApplyWatchResult\(/);
  const retry = client.slice(client.indexOf('function enableTranslation()'), client.indexOf('function updateConsent('));
  assert.doesNotMatch(retry, /failed\.clear\(/);
  assert.match(client, /translationFailure\?\.recovery === "reload"[\s\S]*?type="submit" form="watch-load-form"/);
});
