import type { WatchCue } from './types';

export const WATCH_BATCH_SIZE = 8;
export interface WatchClientFailure {
  block: number;
  code: string;
  message: string;
  recovery: 'retry' | 'reload' | 'limit';
}

export function watchBlockForTime(cues: WatchCue[], time: number): number {
  const index = cues.findIndex(cue => cue.end > time);
  return index < 0 ? -1 : Math.floor(index / WATCH_BATCH_SIZE);
}

/** Current batch first, then at most its immediate successor within 30 seconds. */
export function watchTargetBlock(cues: WatchCue[], time: number, completed: ReadonlySet<number>): number {
  const block = watchBlockForTime(cues, time);
  if (block < 0 || !completed.has(block)) return block;
  const next = block + 1;
  const cue = cues[next * WATCH_BATCH_SIZE];
  return cue && cue.start <= time + 30 && !completed.has(next) ? next : -1;
}

export function watchClientFailure(block: number, message: string, status = 0, code = 'UNKNOWN'): WatchClientFailure {
  const recovery = status === 401 || status === 410 || ['SESSION_EXPIRED', 'SESSION_PROVIDER_CHANGED', 'PROCESSING_MODE_CHANGED'].includes(code)
    ? 'reload' : status === 429 ? 'limit' : 'retry';
  return { block, code, message, recovery };
}

export function canPumpWatchWindow(input: {
  enabled: boolean; playing: boolean; stopped: boolean; pending: unknown;
  failure: WatchClientFailure | null; retryRequested: boolean;
}): boolean {
  return input.enabled && input.playing && !input.stopped && !input.pending
    && (!input.failure || (input.failure.recovery === 'retry' && input.retryRequested));
}

export function canRetryWatchWindow(input: {
  failure: WatchClientFailure | null; retryRequested: boolean; pending: unknown;
  consent: boolean; sourceReady: boolean; stopped: boolean;
}): boolean {
  return !!input.failure && input.failure.recovery === 'retry' && !input.retryRequested && !input.pending
    && input.consent && input.sourceReady && !input.stopped;
}

/** Native iframe controls have no seek event here. Compare media progression with
 * monotonic wall time, allowing 2x playback and delayed/background timer ticks.
 * Merely crossing an 8-cue boundary is NOT a seek. Explicit transcript seeks win. */
export function shouldCancelWatchWindow(input: {
  previousTime: number; nextTime: number; elapsedMs: number | null; playing: boolean;
  pendingBlock: number | null; destinationBlock: number; explicitSeek?: boolean;
}): boolean {
  if (input.pendingBlock === null || input.pendingBlock === input.destinationBlock) return false;
  if (input.explicitSeek) return true;
  const delta = input.nextTime - input.previousTime;
  if (delta < -0.75) return true;
  if (input.elapsedMs === null) return false;
  const elapsed = Math.max(0, input.elapsedMs) / 1000;
  return delta > (input.playing ? Math.max(2, elapsed * 2.25 + 1) : 1);
}

/** Results remain applicable when normal playback has moved beyond their batch. */
export function mayApplyWatchResult(input: {
  requestGeneration: number; generation: number;
  requestSessionId: string; sessionId: string | undefined; aborted: boolean;
}): boolean {
  return !input.aborted && input.requestGeneration === input.generation && input.requestSessionId === input.sessionId;
}

export function watchFailureCopy(failure: WatchClientFailure, input: {
  enabled: boolean; retryRequested: boolean; playing: boolean; pending: boolean;
}) {
  if (failure.recovery === 'reload') return {
    status: '本次工作無法繼續 · 請重新載入', button: '重新載入影片與原文',
    caption: '翻譯工作需重新載入，原文仍可觀看',
    description: '配對、工作或模型設定已變更。請重新載入影片與原文，再同意啟用；不會重送過期工作。',
  };
  if (failure.recovery === 'limit') return {
    status: '已達翻譯用量上限', button: '已達用量上限', caption: '已達翻譯用量上限，原文仍可觀看',
    description: '不會自動重試或繞過上限。已完成譯文與原文仍可觀看；請依上限提示稍後再試。',
  };
  if (input.retryRequested) return {
    status: input.pending ? '正在重試翻譯' : '已排定重試 · 等待播放',
    button: input.pending ? '正在重試…' : '重試已排定，請播放影片',
    caption: input.pending ? '正在重試本段翻譯…' : '已排定重試，播放後執行',
    description: input.pending ? '本次手動重試處理中；成功前保留下方原始錯誤，不會無限重試。' : '本次手動重試已排定。播放後才送出一次請求；下方原始錯誤會保留到重試成功。',
  };
  return {
    status: input.enabled ? '已啟用，但翻譯失敗 · 等待手動重試' : '翻譯失敗 · 已停用自動翻譯',
    button: '重試目前區段', caption: '翻譯失敗，原文仍可觀看；請手動重試',
    description: '已停止自動翻譯，不會因播放、暫停或換段落而反覆重送。修正問題後按「重試目前區段」；不必重新勾選同意。',
  };
}
