import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chooseLiveSession, followLiveTranscript, liveSourceHost, liveTime, makeLiveReplyInput, mayApplyLiveDraft } from '../lib/live-ui/state';
import { LIVE_DEMO, DEMO_REPLY_EN, DEMO_REPLY_ZH } from '../lib/live-ui/demo';
import { liveReadResponse, requestLiveReplyDraft } from '../lib/live-ui/api';
import type { LiveReplyDraft, LiveSessionMetadata } from '../lib/live/types';

const request = makeLiveReplyInput('session-12345', '請再示範一次。', 'polite');
const draft: LiveReplyDraft = { sessionId: request.sessionId, draftId: 'draft-12345', sourceText: request.text, english: 'Could you demonstrate that once more?', tone: 'polite', createdAt: 1 };

test('live following moves only the transcript panel and respects manual browsing', () => {
  const moved: number[] = [];
  const panel = { scrollTop: 10, clientHeight: 200, scrollHeight: 600, scrollTo: ({ top }: { top: number; behavior: 'auto' }) => { moved.push(top); panel.scrollTop = top; } };
  assert.equal(followLiveTranscript(panel, false), false); assert.deepEqual(moved, []);
  assert.equal(followLiveTranscript(panel, true), true); assert.deepEqual(moved, [400]);
  assert.equal(followLiveTranscript(panel, true), false);
  assert.equal(followLiveTranscript({ ...panel, clientHeight: 0 }, true), false);
  assert.equal(followLiveTranscript({ ...panel, scrollHeight: NaN }, true), false);
  const code = fs.readFileSync(new URL('../components/LiveClient.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /scrollIntoView\(|window\.scroll(?:To|By)\(/);
  assert.match(code, /onWheelCapture/); assert.match(code, /onTouchMove/); assert.match(code, /onKeyDownCapture/);
});

test('source selection follows an explicit link then preserves the user-selected session', () => {
  const stopped: LiveSessionMetadata = { ...LIVE_DEMO, sessionId: 'stopped-1234', state: 'stopped', status: 'stopped' };
  const active: LiveSessionMetadata = { ...LIVE_DEMO, sessionId: 'active-12345' };
  assert.equal(chooseLiveSession([stopped, active], '', stopped.sessionId), stopped.sessionId);
  assert.equal(chooseLiveSession([stopped, active], stopped.sessionId, active.sessionId), stopped.sessionId);
  assert.equal(chooseLiveSession([stopped, active], ''), active.sessionId);
  assert.equal(chooseLiveSession([], '', active.sessionId), '');
  assert.equal(liveSourceHost('https://discord.com/channels/private/room'), 'discord.com');
  assert.equal(liveSourceHost('https://example.com/private'), 'Discord');
  assert.equal(liveTime(65.4), '1:05'); assert.equal(liveTime(NaN), '—');
});

test('reply input is bounded, explicit, source-scoped and cannot submit an arbitrary tone or path', () => {
  assert.deepEqual(makeLiveReplyInput('session-12345', '  請再示範一次。  ', 'polite'), request);
  for (const [id, text] of [['../evil', '你好'], ['session-12345', ' '], ['session-12345', '字'.repeat(1201)], ['session-12345', 'English only']]) assert.throws(() => makeLiveReplyInput(id, text, 'natural'));
  assert.equal(makeLiveReplyInput('session-12345', '字'.repeat(1200), 'natural').text.length, 1200);
  assert.throws(() => makeLiveReplyInput('session-12345', '你好', 'send' as 'natural'));
  assert.equal(mayApplyLiveDraft(draft, request, { sessionId: request.sessionId, text: request.text, generation: 5 }, 5), true);
  for (const current of [
    { sessionId: 'different-123', text: request.text, generation: 5 },
    { sessionId: request.sessionId, text: '中文已修改', generation: 5 },
    { sessionId: request.sessionId, text: request.text, generation: 6 },
  ]) assert.equal(mayApplyLiveDraft(draft, request, current, 5), false);
  assert.equal(mayApplyLiveDraft({ ...draft, sourceText: '錯誤來源' }, request, { sessionId: request.sessionId, text: request.text, generation: 5 }, 5), false);
});

test('draft async API calls only local routes and never sends a Discord message', async () => {
  const previousFetch = globalThis.fetch; const calls: { url: string; method: string }[] = [];
  const jobId = '00000000-0000-4000-8000-000000000001';
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method || 'GET' });
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer fixture-not-a-real-token');
    if (String(url) === '/api/live/reply-draft') {
      assert.equal(new Headers(options?.headers).get('Prefer'), 'respond-async');
      assert.deepEqual(JSON.parse(String(options?.body)), request);
      return Response.json({ jobId, status: 'processing' }, { status: 202 });
    }
    assert.equal(String(url), `/api/watch/jobs/${jobId}`);
    return Response.json({ jobId, status: 'done', result: draft });
  };
  try {
    assert.deepEqual(await requestLiveReplyDraft(request, 'fixture-not-a-real-token', new AbortController().signal), draft);
    assert.deepEqual(calls.map(call => call.method), ['POST', 'GET']);
    assert(calls.every(call => call.url.startsWith('/api/')));
  } finally { globalThis.fetch = previousFetch; }
});

test('cancelled drafting deletes the local pending job; pre-cancelled work makes zero requests', async () => {
  const previousFetch = globalThis.fetch; const methods: string[] = [];
  const controller = new AbortController();
  const jobId = '00000000-0000-4000-8000-000000000002';
  globalThis.fetch = async (_url, options) => {
    methods.push(options?.method || 'GET');
    if (options?.method === 'POST') return Response.json({ jobId }, { status: 202 });
    if (options?.method === 'DELETE') return Response.json({ stopped: true });
    controller.abort(); return Response.json({ status: 'processing' }, { status: 202 });
  };
  try {
    await assert.rejects(requestLiveReplyDraft(request, 'fixture-not-a-real-token', controller.signal));
    assert.deepEqual(methods, ['POST', 'GET', 'DELETE']);
    methods.length = 0;
    await assert.rejects(requestLiveReplyDraft(request, 'fixture-not-a-real-token', controller.signal));
    assert.deepEqual(methods, []);
  } finally { globalThis.fetch = previousFetch; }
});

test('malformed job IDs and server errors are surfaced without following external URLs', async () => {
  const previousFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ jobId: 'https://discord.com/send' }, { status: 202 }); };
  try { await assert.rejects(requestLiveReplyDraft(request, 'fixture-not-a-real-token', new AbortController().signal), { code: 'INVALID_JOB' }); assert.equal(calls, 1); }
  finally { globalThis.fetch = previousFetch; }
  await assert.rejects(liveReadResponse(Response.json({ error: '模型尚未就緒。', code: 'LOCAL_UNAVAILABLE' }, { status: 503 })), { message: '模型尚未就緒。', code: 'LOCAL_UNAVAILABLE' });
});

test('demo and mobile preview are explicit, fixed data; clipboard only exists behind user action', () => {
  assert(LIVE_DEMO.cues.length > 2); assert(DEMO_REPLY_ZH.length); assert(DEMO_REPLY_EN.length);
  const client = fs.readFileSync(new URL('../components/LiveClient.tsx', import.meta.url), 'utf8');
  const api = fs.readFileSync(new URL('../lib/live-ui/api.ts', import.meta.url), 'utf8');
  const mobile = fs.readFileSync(new URL('../app/live/mobile-preview/page.tsx', import.meta.url), 'utf8');
  assert.match(client, /互動示範，不是真實直播/);
  assert.match(client, /if \(demo\) return;/);
  assert.match(client, /if \(demo\) \{ setEnglish\(DEMO_REPLY_EN\)/);
  assert.match(client, /onClick=\{\(\) => \{ void copyEnglish\(\)/);
  assert.doesNotMatch(api, /navigator\.clipboard|discord\.com|navigator\.mediaDevices/);
  assert.doesNotMatch(client, /getUserMedia\(|getDisplayMedia\(|chrome\.tabs|dangerouslySetInnerHTML/);
  assert.match(mobile, /data-live-mobile-screen style=\{\{ width: 440, height: 956/);
  assert.match(mobile, /width="440" height="812"/);
  assert.match(mobile, /Dynamic Island/); assert.match(mobile, /Home Indicator/); assert.match(mobile, /Safari/);
  assert.match(mobile, /src="\/live\?demo=1"/);
  assert.match(mobile, /不代表手機可安裝或收音/);
});
