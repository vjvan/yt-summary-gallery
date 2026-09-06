import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioWatchService } from '../lib/watch/audio-service';
import { AudioUsageStore } from '../lib/watch/audio-store';
import { pairingToken } from '../lib/watch/security';
import { POST as sessionRoute, OPTIONS } from '../app/api/watch/audio/session/route';
import { POST as chunkRoute } from '../app/api/watch/audio/chunk/route';
import { POST as stopRoute } from '../app/api/watch/audio/session/[id]/stop/route';
import { GET as jobRoute, DELETE as deleteJobRoute } from '../app/api/watch/jobs/[id]/route';

const url = 'https://www.youtube.com/watch?v=kfbWz9_bJoA';
function bytes() {
  const data = Buffer.alloc(44); data.write('RIFF', 0); data.write('WAVE', 8); return data;
}

test('audio route auth, consent, multipart and async jobs contract use mock models only', async () => {
  const store = new AudioUsageStore(':memory:'); let transcriptions = 0, translations = 0;
  const service = new AudioWatchService({ store, probe: async () => ({ duration: 1 }),
    transcribe: async () => { transcriptions++; return [{ id: 'audio-fixture', start: 30, end: 31, text: 'Use the mask.' }]; },
    translate: async ({ targets }) => { translations++; return targets.map(cue => ({ ...cue, originalText: cue.text, text: '使用遮罩。' })); },
    glossary: () => ({ no_translate_terms: [], term_map: [], style_rules: [] }), enabled: () => true, limits: () => ({ sessionChunks: 10, dailyChunks: 40 }),
  });
  const global = globalThis as typeof globalThis & { __ytAudioWatchService?: AudioWatchService };
  const previous = global.__ytAudioWatchService; global.__ytAudioWatchService = service;
  const token = pairingToken(); const origin = `chrome-extension://${'c'.repeat(32)}`;
  const headers = { origin, authorization: `Bearer ${token}` };
  const json = (body: unknown, auth = true) => new Request('http://127.0.0.1:3000/api/watch/audio/session', { method: 'POST', headers: { ...(auth ? headers : { origin }), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const multipart = (id: string, consent = 'true') => {
    const body = new FormData(); body.set('audioSessionId', id); body.set('chunkId', 'chunk-fixture'); body.set('start', '30'); body.set('end', '31'); body.set('confirmAudio', consent);
    body.set('file', new Blob([bytes()], { type: 'audio/wav' }), 'part.wav');
    return new Request('http://127.0.0.1:3000/api/watch/audio/chunk', { method: 'POST', headers: { ...headers, Prefer: 'respond-async' }, body });
  };
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  const jobRequest = (id: string, method = 'GET') => new Request(`http://127.0.0.1:3000/api/watch/jobs/${id}`, { method, headers });
  try {
    assert.equal((await sessionRoute(json({ url, confirmAudio: true, maxChunks: 2 }, false))).status, 401);
    assert.equal((await sessionRoute(json({ url, maxChunks: 2 }))).status, 403);
    assert.equal((await sessionRoute(json({ url, confirmAudio: true, maxChunks: 100 }))).status, 400);
    const preflight = await OPTIONS(new Request('http://127.0.0.1:3000/api/watch/audio/session', { method: 'OPTIONS', headers: { origin } }));
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
    const response = await sessionRoute(json({ url, title: 'Fixture', confirmAudio: true, maxChunks: 2 }));
    assert.equal(response.status, 200); const session = await response.json();
    assert.deepEqual(session.limits, { sessionChunks: 2, dailyChunks: 40, maxChunkSeconds: 15 });
    assert.equal(session.sourceLanguage, 'en'); assert.equal(transcriptions, 0);
    assert.equal((await chunkRoute(multipart(session.audioSessionId, 'false'))).status, 403);
    const accepted = await chunkRoute(multipart(session.audioSessionId)); assert.equal(accepted.status, 202);
    const { jobId } = await accepted.json(); let done;
    for (let i = 0; i < 10; i++) {
      const poll = await jobRoute(jobRequest(jobId), ctx(jobId));
      if (poll.status !== 202) { assert.equal(poll.status, 200); done = await poll.json(); break; }
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(done.status, 'done'); assert.equal(done.result.audioSessionId, session.audioSessionId);
    assert.equal(done.result.chunkId, 'chunk-fixture'); assert.equal(done.result.cues[0].text, '使用遮罩。');
    assert.deepEqual(done.result.usage, { sessionChunks: 1, dailyChunks: 1 });
    assert.equal(transcriptions, 1); assert.equal(translations, 1);
    await deleteJobRoute(jobRequest(jobId, 'DELETE'), ctx(jobId));
    const stop = await stopRoute(new Request(`http://127.0.0.1:3000/api/watch/audio/session/${session.audioSessionId}/stop`, { method: 'POST', headers }), ctx(session.audioSessionId));
    assert.equal(stop.status, 200);
    const stoppedRequest = multipart(session.audioSessionId); stoppedRequest.headers.delete('Prefer');
    assert.equal((await chunkRoute(stoppedRequest)).status, 410);
    assert.equal(transcriptions, 1);
  } finally { global.__ytAudioWatchService = previous; store.close(); }
});
