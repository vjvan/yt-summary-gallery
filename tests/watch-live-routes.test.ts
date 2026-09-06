import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveService } from '../lib/live/service';
import { WatchJobs } from '../lib/watch/jobs';
import { pairingToken } from '../lib/watch/security';
import { GET as listRoute, POST as startRoute, OPTIONS } from '../app/api/live/session/route';
import { GET as detailRoute } from '../app/api/live/session/[id]/route';
import { POST as stopRoute } from '../app/api/live/session/[id]/stop/route';
import { POST as chunkRoute } from '../app/api/live/chunk/route';
import { POST as replyRoute } from '../app/api/live/reply-draft/route';
import { GET as jobRoute, DELETE as cancelRoute } from '../app/api/watch/jobs/[id]/route';

const url = 'https://discord.com/channels/123456789012345678/234567890123456789';
function wav(): Buffer {
  const bytes = Buffer.alloc(32044); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8); bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32000, 40); return bytes;
}
const provider = { processingMode: 'local' as const, unlimited: true, translationModel: 'qwen2.5:7b', translationConfigured: true, translationReady: true, audioConfigured: true };

test('paired live routes: strict source/consent, async chunks/drafts, readable stop and hostile-origin rejection', async () => {
  let transcribes = 0, replies = 0;
  const service = new LiveService({ provider: () => provider, readiness: async () => provider,
    probe: async () => ({ duration: 1 }), transcribe: async () => { transcribes++; return [{ id: 'fixture-cue', start: 0, end: 1, text: 'Use the mask.' }]; },
    translate: async ({ targets }) => targets.map(cue => ({ ...cue, originalText: cue.text, text: '使用遮罩。' })),
    reply: async () => { replies++; return 'Could you explain the mask?'; }, glossary: () => ({ no_translate_terms: [], term_map: [], style_rules: [] }),
  });
  const globals = globalThis as typeof globalThis & { __ytLiveService?: LiveService; __ytWatchJobs?: WatchJobs };
  const previousService = globals.__ytLiveService, previousJobs = globals.__ytWatchJobs;
  globals.__ytLiveService = service; globals.__ytWatchJobs = new WatchJobs();
  const token = pairingToken(), origin = `chrome-extension://${'d'.repeat(32)}`;
  const headers = { origin, authorization: `Bearer ${token}` };
  const req = (path: string, body?: unknown, extra: Record<string, string> = {}) => new Request(`http://127.0.0.1:3000/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const jobs: string[] = [];
  async function poll(id: string) {
    for (let attempt = 0; attempt < 15; attempt++) {
      const response = await jobRoute(req(`watch/jobs/${id}`), ctx(id));
      if (response.status !== 202) { assert.equal(response.status, 200); return response.json(); }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('mock job timed out');
  }
  try {
    const unauthorized = req('live/session', { url, confirmAudio: true }); unauthorized.headers.delete('authorization');
    assert.equal((await startRoute(unauthorized)).status, 401);
    assert.equal((await listRoute(req('live/session', undefined, { origin: 'https://discord.com' }))).status, 403, 'Discord page cannot bypass the trusted paired extension');
    assert.equal((await startRoute(req('live/session', { url: 'https://evil.test', confirmAudio: true }))).status, 400);
    assert.equal((await startRoute(req('live/session', { url }))).status, 403);
    assert.equal((await startRoute(req('live/session', { url, confirmAudio: true, processingMode: 'cloud' }))).status, 400);
    const preflight = await OPTIONS(new Request('http://127.0.0.1:3000/api/live/session', { method: 'OPTIONS', headers: { origin } }));
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
    const started = await startRoute(req('live/session', { url, title: 'Mock Discord stream', confirmAudio: true })); assert.equal(started.status, 200);
    const session = await started.json(); assert.equal(session.processingMode, 'local'); assert.equal(session.state, 'active'); assert.equal(session.unlimited, true);
    assert.equal((await (await listRoute(req('live/session'))).json()).sessions.length, 1);
    const audio = new FormData(); audio.set('sessionId', session.sessionId); audio.set('sequence', '0'); audio.set('start', '0'); audio.set('end', '1'); audio.set('audio', new Blob([new Uint8Array(wav())], { type: 'audio/wav' }), 'part.wav');
    const upload = () => new Request('http://127.0.0.1:3000/api/live/chunk', { method: 'POST', headers: { ...headers, Prefer: 'respond-async' }, body: audio });
    const accepted = await chunkRoute(upload()); assert.equal(accepted.status, 202); const chunkJob = await accepted.json(); jobs.push(chunkJob.jobId);
    const result = (await poll(chunkJob.jobId)).result; assert.equal(result.sessionId, session.sessionId); assert.equal(result.sequence, 0); assert.equal(result.cues[0].text, '使用遮罩。'); assert.equal(transcribes, 1);
    const duplicated = await chunkRoute(upload()); const duplicateJob = await duplicated.json(); jobs.push(duplicateJob.jobId); assert.equal((await poll(duplicateJob.jobId)).result.cached, true); assert.equal(transcribes, 1);
    assert.equal((await replyRoute(req('live/reply-draft', { sessionId: session.sessionId, text: 'english only' }))).status, 400);
    const draftAccepted = await replyRoute(req('live/reply-draft', { sessionId: session.sessionId, text: '可以再說明遮罩嗎？', tone: 'polite' }, { Prefer: 'respond-async' })); assert.equal(draftAccepted.status, 202); const draftJob = await draftAccepted.json(); jobs.push(draftJob.jobId);
    const draft = (await poll(draftJob.jobId)).result; assert.equal(draft.english, 'Could you explain the mask?'); assert.equal(replies, 1); assert.equal(draft.sourceText, '可以再說明遮罩嗎？');
    const stopped = await stopRoute(req(`live/session/${session.sessionId}/stop`, { reason: 'source-closed' }), ctx(session.sessionId)); assert.equal(stopped.status, 200);
    const detail = await (await detailRoute(req(`live/session/${session.sessionId}`), ctx(session.sessionId))).json(); assert.equal(detail.status, 'stopped'); assert.equal(detail.state, 'stopped'); assert.equal(detail.cues.length, 1); assert.equal(detail.drafts.length, 1);
    assert.equal((await (await listRoute(req('live/session'))).json()).sessions.length, 1, 'stop metadata remains available for extension polling');
  } finally {
    for (const id of jobs) await cancelRoute(new Request(`http://127.0.0.1:3000/api/watch/jobs/${id}`, { method: 'DELETE', headers }), ctx(id));
    globals.__ytLiveService = previousService; globals.__ytWatchJobs = previousJobs;
  }
});

test('cancelling an async live job reaches the local worker and never stores late subtitles', async () => {
  let aborted = false;
  const service = new LiveService({ provider: () => provider, readiness: async () => provider,
    probe: async () => ({ duration: 1 }), transcribe: async (_input, _fingerprint, signal) => {
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => { aborted = true; reject(new Error('cancel')); }, { once: true })); return [];
    }, translate: async () => [], reply: async () => 'Thank you.', glossary: () => ({ no_translate_terms: [], term_map: [], style_rules: [] }),
  });
  const session = await service.start({ url, confirmAudio: true }); const jobs = new WatchJobs();
  const accepted = jobs.start(signal => service.chunk({ sessionId: session.sessionId, sequence: 0, start: 0, end: 1, bytes: wav() }, signal));
  await new Promise<void>(resolve => setImmediate(resolve)); jobs.cancel(accepted.jobId);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(aborted, true);
  const state = service.get(session.sessionId); assert.equal(state.cues.length, 0); assert.equal(state.chunks[0].status, 'error'); assert.equal(state.gaps[0].reason, 'processing-failed');
});
