import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchJobs } from '../lib/watch/jobs';
import { WatchError } from '../lib/watch/errors';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('long work is acknowledged before completion and retrieved with short polls', async () => {
  const jobs = new WatchJobs();
  let finish!: (result: unknown) => void;
  const started = jobs.start(() => new Promise(resolve => { finish = resolve; }));
  assert.equal(started.status, 'processing');
  assert.equal(jobs.get(started.jobId).status, 'processing');
  await tick(); finish({ cues: ['fixture'] }); await tick();
  assert.deepEqual(jobs.get(started.jobId), {jobId:started.jobId,status:'done',result:{cues:['fixture']}});
});
test('cancellation reaches the worker, and cancelled results are never delivered', async () => {
  const jobs = new WatchJobs(); let workerSignal: AbortSignal | undefined;
  const started = jobs.start(signal => {workerSignal=signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError'))));});
  await tick(); jobs.cancel(started.jobId); await tick();
  assert.equal(workerSignal?.aborted,true);
  assert.throws(()=>jobs.get(started.jobId),{code:'JOB_EXPIRED'});
});
test('worker error is preserved for safe route serialization', async () => {
  const jobs = new WatchJobs();
  const started = jobs.start(async()=>{throw new WatchError('NO_CAPTIONS','沒有原文字幕。');});
  await tick();
  assert.throws(()=>jobs.get(started.jobId),{code:'NO_CAPTIONS'});
});

test('a cancelled completed source job releases its undisplayed session', async () => {
  const jobs = new WatchJobs(); let discarded = '';
  const started = jobs.start(async()=>({sessionId:'not-delivered'}), result=>{discarded=(result as {sessionId:string}).sessionId;});
  await tick(); jobs.cancel(started.jobId);
  assert.equal(discarded,'not-delivered');
});
