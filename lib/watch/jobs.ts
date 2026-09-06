import { randomUUID } from 'node:crypto';
import { WatchError } from './errors';

interface Job {
  controller: AbortController; createdAt: number;
  status: 'processing' | 'done' | 'error'; result?: unknown; error?: unknown;
  discard?: (result: unknown) => void;
}
/** Local server only: short HTTP requests keep Chrome MV3 from waiting on a long fetch.
 * Results are retained briefly for reconnects. A restart invalidates jobs, not cue caches.
 */
export class WatchJobs {
  private jobs = new Map<string, Job>();
  start(operation: (signal: AbortSignal) => Promise<unknown>, discard?: (result: unknown) => void) {
    this.sweep();
    if ([...this.jobs.values()].filter(job => job.status === 'processing').length >= 4) throw new WatchError('BUSY', '字幕工作忙碌，請稍後重試。', 503);
    if (this.jobs.size >= 32) {
      for (const [id, job] of this.jobs) if (job.status !== 'processing') { this.jobs.delete(id); break; }
    }
    const jobId = randomUUID();
    const job: Job = { controller: new AbortController(), createdAt: Date.now(), status: 'processing', discard };
    this.jobs.set(jobId, job);
    // Independent of the POST request signal: POST ends as soon as the job is acknowledged.
    const timeout = setTimeout(() => job.controller.abort(), 110_000);
    void Promise.resolve().then(() => operation(job.controller.signal)).then(result => {
      if (job.controller.signal.aborted) job.discard?.(result);
      job.controller.signal.throwIfAborted();
      job.result = result; job.status = 'done';
    }).catch(error => { job.error = error; job.status = 'error'; }).finally(() => clearTimeout(timeout));
    return { jobId, status: 'processing' as const };
  }
  get(id: string) {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job) throw new WatchError('JOB_EXPIRED', '字幕工作已逾時或伺服器已重啟，請重新開啟影片。', 410);
    if (job.status === 'error') throw job.error;
    return job.status === 'done' ? { jobId: id, status: 'done' as const, result: job.result } : { jobId: id, status: 'processing' as const };
  }
  cancel(id: string) {
    const job = this.jobs.get(id);
    job?.controller.abort();
    if (job?.status === 'done') job.discard?.(job.result);
    this.jobs.delete(id);
  }
  private sweep() {
    for (const [id, job] of this.jobs) if (Date.now() - job.createdAt > 5 * 60_000) {
      if (job.status === 'processing') this.cancel(id);
      else this.jobs.delete(id); // Expiring delivered results must not stop an active session.
    }
  }
}
const runtime = globalThis as typeof globalThis & { __ytWatchJobs?: WatchJobs };
export function watchJobs() { return runtime.__ytWatchJobs ??= new WatchJobs(); }
