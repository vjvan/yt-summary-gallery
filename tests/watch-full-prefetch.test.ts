import test from 'node:test';
import assert from 'node:assert/strict';
import { watchFullTargetBlock, watchScheduleDecision, shouldPreemptWatchWindow, type WatchScheduleInput } from '../lib/watch/full-prefetch';
import { mayApplyWatchResult, watchClientFailure } from '../lib/watch/client-state';
import type { WatchCue } from '../lib/watch/types';

const cues: WatchCue[] = Array.from({ length: 221 }, (_, index) => ({ id: `full-${index}`, start: index * 4, end: index * 4 + 4, text: `Original ${index}` }));
const base: WatchScheduleInput = {
  mode: 'full', processingMode: 'local', cues, time: 0, completed: new Set(),
  consent: true, enabled: true, playing: false, stopped: false, pending: null, failure: null, retryRequested: false,
};

test('explicit local full mode dispatches while paused; default nearby mode still requires playback', () => {
  assert.deepEqual(watchScheduleDecision(base), { kind: 'dispatch', block: 0 });
  assert.deepEqual(watchScheduleDecision({ ...base, mode: 'nearby' }), { kind: 'idle' });
  assert.deepEqual(watchScheduleDecision({ ...base, mode: 'nearby', playing: true }), { kind: 'dispatch', block: 0 });
  assert.deepEqual(watchScheduleDecision({ ...base, enabled: false }), { kind: 'idle' });
});

test('current missing block wins on seek, then stable source-order holes are filled', () => {
  const completed = new Set([0, 1]);
  assert.equal(watchFullTargetBlock(cues, 320, completed), 10);
  assert.deepEqual(watchScheduleDecision({ ...base, completed, time: 320 }), { kind: 'dispatch', block: 10 });
  completed.add(10);
  assert.equal(watchFullTargetBlock(cues, 320, completed), 2);
  assert.equal(watchFullTargetBlock(cues, 9999, completed), 2, 'after playback ends, full prefetch still fills missing earlier blocks');
});

test('221 cues finish all 28 blocks while paused, including the short final batch, then stop', () => {
  const completed = new Set<number>(); const dispatched: number[] = [];
  for (let tick = 0; tick < 30; tick++) {
    const next = watchScheduleDecision({ ...base, completed });
    if (next.kind === 'done') break;
    assert.equal(next.kind, 'dispatch');
    if (next.kind === 'dispatch') { dispatched.push(next.block); completed.add(next.block); }
  }
  assert.deepEqual(dispatched, Array.from({ length: 28 }, (_, index) => index));
  assert.deepEqual(watchScheduleDecision({ ...base, completed }), { kind: 'done' });
  assert.deepEqual(watchScheduleDecision({ ...base, completed, enabled: false }), { kind: 'idle' });
  assert.deepEqual(watchScheduleDecision({ ...base, cues: [] }), { kind: 'idle' });
});

test('one in-flight slot is respected until cancellation settles and stale generation results cannot apply', () => {
  const pending = { block: 0, controller: new AbortController() };
  assert.deepEqual(watchScheduleDecision({ ...base, time: 320, pending }), { kind: 'idle' });
  pending.controller.abort();
  assert.deepEqual(watchScheduleDecision({ ...base, time: 320, pending }), { kind: 'idle' }, 'an abort request alone does not release the slot');
  assert.deepEqual(watchScheduleDecision({ ...base, time: 320, pending: null }), { kind: 'dispatch', block: 10 });
  assert.equal(mayApplyWatchResult({ requestGeneration: 1, generation: 2, requestSessionId: 'old', sessionId: 'old', aborted: true }), false);
  assert.equal(mayApplyWatchResult({ requestGeneration: 1, generation: 1, requestSessionId: 'old', sessionId: 'new', aborted: false }), false);
});

test('cloud, unknown provider, revoked consent and stopped sessions cannot start full mode', () => {
  for (const override of [{ processingMode: 'cloud' as const }, { processingMode: undefined }, { consent: false }, { stopped: true }, { enabled: false }]) {
    assert.deepEqual(watchScheduleDecision({ ...base, playing: true, ...override }), { kind: 'idle' });
  }
  assert.deepEqual(watchScheduleDecision({ ...base, mode: 'nearby', processingMode: 'cloud', playing: true }), { kind: 'dispatch', block: 0 }, 'existing opted-in cloud nearby flow is unchanged');
});

test('failures do not auto-loop on time or pause changes; only explicit retry resumes the failed block', () => {
  const failure = watchClientFailure(3, 'Model failed', 502, 'MODEL_FAILED');
  for (const time of [0, 128, 320]) for (const playing of [true, false]) {
    assert.deepEqual(watchScheduleDecision({ ...base, failure, time, playing }), { kind: 'idle' });
  }
  assert.deepEqual(watchScheduleDecision({ ...base, failure, time: 320, retryRequested: true }), { kind: 'dispatch', block: 3 });
  assert.deepEqual(watchScheduleDecision({ ...base, failure, time: 320, retryRequested: true, enabled: false }), { kind: 'idle' });
  for (const permanent of [watchClientFailure(3, 'Expired', 410), watchClientFailure(3, 'Limit', 429)]) {
    assert.deepEqual(watchScheduleDecision({ ...base, failure: permanent, retryRequested: true }), { kind: 'idle' });
  }
});


test('full seek keeps the current batch alive, then prioritizes the latest missing destination without same-key cancellation churn', () => {
  const controller = new AbortController();
  const pending = { block: 26, controller };
  const completed = new Set(Array.from({ length: 26 }, (_, i) => i));
  const completedSeek = { previousTime: 720, nextTime: 482, elapsedMs: 50, playing: false, pendingBlock: 26, destinationBlock: 15, explicitSeek: true };
  assert.equal(shouldPreemptWatchWindow('full', completedSeek), false, 'seeking to an already translated block must not cancel background block 26');
  assert.equal(shouldPreemptWatchWindow('nearby', completedSeek), true, 'nearby/cloud preemption behavior stays unchanged');
  assert.deepEqual(watchScheduleDecision({ ...base, time: 482, pending, completed }), { kind: 'idle' });
  assert.equal(controller.signal.aborted, false);
  completed.add(26);
  assert.deepEqual(watchScheduleDecision({ ...base, time: 482, pending: null, completed }), { kind: 'dispatch', block: 27 });
  const missingSeek = { ...completedSeek, nextTime: 320, destinationBlock: 10 };
  assert.equal(shouldPreemptWatchWindow('full', missingSeek), false);
  const earlier = new Set([0]);
  assert.deepEqual(watchScheduleDecision({ ...base, time: 320, pending: { block: 1, controller }, completed: earlier }), { kind: 'idle' });
  earlier.add(1);
  assert.deepEqual(watchScheduleDecision({ ...base, time: 320, pending: null, completed: earlier }), { kind: 'dispatch', block: 10 }, 'a seek takes priority immediately after the in-flight batch settles');
  assert.equal(mayApplyWatchResult({ requestGeneration: 1, generation: 1, requestSessionId: 'same', sessionId: 'same', aborted: false }), true, 'the completed old-position batch is retained by ID, not discarded as stale');
});
