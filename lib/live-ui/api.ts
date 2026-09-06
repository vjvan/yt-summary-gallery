import type { LiveReplyDraft, LiveReplyInput } from '../live/types';

export class LiveApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
export async function liveReadResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new LiveApiError(typeof data?.error === 'string' ? data.error : '本機服務回應失敗，請稍後重試。', response.status, data?.code || 'UNKNOWN');
  if (!data || typeof data !== 'object') throw new LiveApiError('本機服務回傳格式不正確。', 502, 'INVALID_RESPONSE');
  return data as T;
}
function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** Only prepares a local draft; this module has no Discord sending or clipboard operation. */
export async function requestLiveReplyDraft(input: LiveReplyInput, token: string, callerSignal: AbortSignal): Promise<LiveReplyDraft> {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(120_000)]);
  const headers = { Authorization: `Bearer ${token}` };
  let jobId = ''; let completed = false;
  try {
    signal.throwIfAborted();
    const response = await fetch('/api/live/reply-draft', { method: 'POST', cache: 'no-store', credentials: 'same-origin', signal,
      headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'respond-async' }, body: JSON.stringify(input) });
    if (response.status !== 202) {
      const result = await liveReadResponse<LiveReplyDraft>(response); signal.throwIfAborted(); completed = true; return result;
    }
    const accepted = await liveReadResponse<{ jobId: string }>(response);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(accepted.jobId)) throw new LiveApiError('本機草稿工作編號無效。', 502, 'INVALID_JOB');
    jobId = accepted.jobId;
    while (true) {
      signal.throwIfAborted();
      const poll = await fetch(`/api/watch/jobs/${jobId}`, { cache: 'no-store', credentials: 'same-origin', headers, signal });
      const status = await liveReadResponse<{ status: string; result?: LiveReplyDraft }>(poll);
      if (status.status === 'done' && status.result) { signal.throwIfAborted(); completed = true; return status.result; }
      if (status.status !== 'processing') throw new LiveApiError('本機草稿工作狀態無效。', 502, 'INVALID_JOB');
      await pause(1500, signal);
    }
  } finally {
    if (jobId && !completed) void fetch(`/api/watch/jobs/${jobId}`, { method: 'DELETE', headers, credentials: 'same-origin', keepalive: true, signal: AbortSignal.timeout(5000) }).catch(() => {});
  }
}
