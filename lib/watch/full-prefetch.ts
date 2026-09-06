import type { WatchCue } from './types';
import { WATCH_BATCH_SIZE, canPumpWatchWindow, watchBlockForTime, watchTargetBlock, shouldCancelWatchWindow, type WatchClientFailure } from './client-state';

export type WatchScheduleMode = 'nearby' | 'full';
export interface WatchScheduleInput {
  mode: WatchScheduleMode;
  processingMode?: 'local' | 'cloud';
  cues: WatchCue[]; time: number; completed: ReadonlySet<number>;
  consent: boolean; enabled: boolean; playing: boolean; stopped: boolean; pending: unknown;
  failure: WatchClientFailure | null; retryRequested: boolean;
  failed?: ReadonlyMap<number, WatchClientFailure>;
}
export type WatchScheduleDecision = { kind: 'idle' } | { kind: 'done' } | { kind: 'blocked' } | { kind: 'dispatch'; block: number };

/** Current missing block wins. Otherwise fill holes in stable source order, without a total batch cap. */
export function watchFullTargetBlock(cues: WatchCue[], time: number, completed: ReadonlySet<number>, retryBlock?: number, skipped: ReadonlySet<number> = new Set()): number {
  const total = Math.ceil(cues.length / WATCH_BATCH_SIZE);
  if (retryBlock !== undefined && retryBlock >= 0 && retryBlock < total && !completed.has(retryBlock)) return retryBlock;
  const current = watchBlockForTime(cues, time);
  if (current >= 0 && !completed.has(current) && !skipped.has(current)) return current;
  for (let block = 0; block < total; block++) if (!completed.has(block) && !skipped.has(block)) return block;
  return -1;
}

/** Full-video prefetch is an explicit local-only mode. Pausing the player is not revoking that consent. */
export function watchScheduleDecision(input: WatchScheduleInput): WatchScheduleDecision {
  if (!input.consent || !input.cues.length || (input.mode === 'full' && input.processingMode !== 'local')) return { kind: 'idle' };
  const isolated = input.mode === 'full' && input.failure?.code === 'LOCAL_TRANSLATION_QUALITY';
  if (!canPumpWatchWindow({ ...input, failure: isolated ? null : input.failure, playing: input.playing || input.mode === 'full' })) return { kind: 'idle' };
  const skipped = new Set([...(input.failed ?? [])].filter(([, value]) => value.code === 'LOCAL_TRANSLATION_QUALITY').map(([block]) => block));
  const block = input.mode === 'full'
    ? watchFullTargetBlock(input.cues, input.time, input.completed, input.retryRequested ? input.failure?.block : undefined, skipped)
    : watchTargetBlock(input.cues, input.time, input.completed);
  return block < 0 ? { kind: input.mode === 'full' ? skipped.size ? 'blocked' : 'done' : 'idle' } : { kind: 'dispatch', block };
}


/** Full prefetch changes priority at a batch boundary, never by aborting a paid-for/in-progress batch.
 * This also prevents a fast same-window re-request from inheriting the old HTTP request's late abort.
 * Explicit stop/consent revocation/reload still cancel through their dedicated lifecycle handlers. */
export function shouldPreemptWatchWindow(mode: WatchScheduleMode, input: Parameters<typeof shouldCancelWatchWindow>[0]): boolean {
  return mode !== 'full' && shouldCancelWatchWindow(input);
}
