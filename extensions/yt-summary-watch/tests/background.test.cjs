/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS tests for classic MV3 scripts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const folder = path.join(__dirname, '..');
function harness(options = {}) {
  const locals = {}; const sessions = {}; const calls = []; const protectedAreas = [];
  let onMessage, onUpdated;
  let apiTouches = 0, polls = 0, windowCalls = 0;
  const jobId = 'ab1292ad-1111-2222-3333-123456abcdef';
  const tab = { id: 7, url: 'https://www.youtube.com/watch?v=kfbWz9_bJoA' };
  const id = 'extension-id';
  function area(store, name) { return {
    async get(keys) { if (keys === null) return { ...store }; return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]])); },
    async set(values) { Object.assign(store, values); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; },
    async setAccessLevel(value) { protectedAreas.push([name, value.accessLevel]); },
  }; }
  const chrome = { runtime: { id, async getPlatformInfo() { apiTouches++; return { os: 'mac' }; }, getURL: name => `chrome-extension://${id}/${name}`, onMessage: { addListener(listener) { onMessage = listener; } } },
    storage: { local: area(locals, 'local'), session: area(sessions, 'session') },
    tabs: { async get(tabId) { return { ...tab, id: tabId }; }, async query() { return [{ ...tab }]; }, async sendMessage() { return { ok: true }; }, onRemoved: { addListener() {} }, onUpdated: { addListener(listener) { onUpdated = listener; } } } };
  const source = Array.from({ length: 9 }, (_, index) => ({ id: `c${index}`, start: index * 2, end: index * 2 + 1.5, text: 'Hello' }));
  const sessionId = 'd0f5f74c-22f4-426f-a42a-abcdef123456';
  const provider = { processingMode: options.local ? 'local' : 'cloud', unlimited: !!options.local, translationConfigured: true, audioConfigured: true, translationReady: true, translationModel: 'mock' };
  const sessionView = { sessionId, videoId: 'kfbWz9_bJoA', cues: source, ...provider, limits: { sessionCalls: options.local ? null : options.serverLimit || 10, dailyCalls: options.local ? null : 100 }, translationEnabled: true };
  let context;
  const sandbox = { chrome, console, URL, AbortController, clearTimeout,
    setTimeout(callback, ms) { return setTimeout(callback, ms === 1500 ? 1 : ms); },
    importScripts(file) { vm.runInContext(fs.readFileSync(path.join(folder, file), 'utf8'), context); },
    async fetch(url, request) {
      calls.push({ url, options: request });
      if (url.endsWith('/window')) windowCalls++;
      let data = url.endsWith('/status') ? { version: 3, ...provider } : url.endsWith('/session') ? sessionView
        : url.endsWith('/window') ? { sessionId, windowKey: '0', cues: source.slice(0, 8).map(cue => ({ ...cue, text: '你好', originalText: cue.text })), callsUsed: options.cacheHits ? 0 : windowCalls, dailyCallsUsed: 1, cached: Boolean(options.cacheHits) } : { stopped: true };
      let status = 200;
      if (options.asyncJobs && url.endsWith('/session')) { status = 202; data = { jobId: options.badJobId || jobId, status: 'processing' }; }
      if (url.includes('/jobs/') && request.method === 'GET') {
        polls++;
        status = options.jobNeverDone || polls < 2 ? 202 : 200;
        data = status === 202 ? { jobId, status: 'processing' } : { jobId, status: 'done', result: sessionView };
      }
      if (url.endsWith('/window') && options.windowFails) { status = 502; data = { error: '模型未完成', code: 'WATCH_FAILED' }; }
      return { ok: status < 400, status, async json() { return data; } };
    } };
  context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(folder, 'background.js'), 'utf8'), context);
  const popup = { id, url: `chrome-extension://${id}/popup.html` };
  const content = { id, url: tab.url, tab, frameId: 0 };
  const send = (message, sender = content) => new Promise(resolve => { onMessage(message.type === 'WATCH_SESSION' && !message.requestId ? { ...message, requestId: 'test-request-1234' } : message, sender, resolve); });
  const enable = (maxBatches = 10, expectedProcessingMode = 'cloud') => send({ type: 'POPUP_ENABLE', expectedProcessingMode, settings: { server: 'http://localhost:3000', token: 'pairing-token-123456789', enabled: true, consent: true, autoMode: false, maxBatches } }, popup);
  return { send, enable, popup, content, locals, sessions, calls, protectedAreas, sessionId, tab, jobId, apiTouches: () => apiTouches,
    navigate(url) { tab.url = url; onUpdated(tab.id, { url }, tab); } };
}

test('default-off content cannot start a session or read the token', async () => {
  const h = harness();
  const config = await h.send({ type: 'WATCH_CONFIG' });
  assert.equal(config.ok, true); assert.equal(config.data.enabled, false); assert.equal('token' in config.data, false);
  const response = await h.send({ type: 'WATCH_SESSION', url: h.tab.url });
  assert.equal(response.ok, false); assert.equal(response.code, 'NOT_ENABLED'); assert.equal(h.calls.length, 0);
  assert.deepEqual(h.protectedAreas, [['local', 'TRUSTED_CONTEXTS'], ['session', 'TRUSTED_CONTEXTS']]);
});
test('rejects untrusted websites, subframes, remote servers and forged popup commands', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'POPUP_SETTINGS' }, { ...h.content, id: 'another-extension' })).ok, false);
  assert.equal((await h.send({ type: 'POPUP_SETTINGS' }, h.content)).ok, false);
  assert.equal((await h.send({ type: 'WATCH_CONFIG' }, { ...h.content, frameId: 1 })).ok, false);
  assert.equal((await h.send({ type: 'WATCH_CONFIG' }, { ...h.content, url: 'https://example.com/' })).ok, false);
  assert.equal((await h.send({ type: 'POPUP_ENABLE', settings: { server: 'https://evil.test', token: 'token-12345678901234', enabled: true, consent: true } }, h.popup)).ok, false);
  assert.equal(h.calls.length, 0);
});
test('manual activation uses only fixed authenticated loopback routes and matching video', async () => {
  const h = harness();
  assert.equal((await h.enable()).ok, true);
  assert.equal((await h.send({ type: 'WATCH_SESSION', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' })).ok, false);
  assert.equal(h.calls.length, 0);
  const session = await h.send({ type: 'WATCH_SESSION', url: h.tab.url });
  assert.equal(session.ok, true);
  const result = await h.send({ type: 'WATCH_WINDOW', sessionId: h.sessionId, time: 0 });
  assert.equal(result.ok, true); assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    assert.equal(new URL(call.url).origin, 'http://localhost:3000');
    assert.equal(call.options.headers.Authorization, 'Bearer pairing-token-123456789');
    assert.equal(call.options.redirect, 'error'); assert.equal(call.options.credentials, 'omit');
  }
  assert.deepEqual(JSON.parse(h.calls[1].options.body), { sessionId: h.sessionId, time: 0, confirmTranslation: true });
  assert.equal((await h.send({ type: 'FETCH', url: 'https://evil.test' })).ok, false);
  assert.equal(h.calls.length, 2);
});
test('session ownership and current video guard prevent stale or cross-tab translation', async () => {
  const h = harness(); await h.enable(); await h.send({ type: 'WATCH_SESSION', url: h.tab.url });
  assert.equal((await h.send({ type: 'WATCH_WINDOW', sessionId: h.sessionId, time: 0 }, { ...h.content, tab: { ...h.tab, id: 9 } })).ok, false);
  h.tab.url = 'https://www.youtube.com/watch?v=aaaaaaaaaaa';
  assert.equal((await h.send({ type: 'WATCH_WINDOW', sessionId: h.sessionId, time: 0 })).ok, false);
  assert.equal(h.calls.length, 1);
});
test('disable revokes permission and stops owned session', async () => {
  const h = harness(); await h.enable(); await h.send({ type: 'WATCH_SESSION', url: h.tab.url });
  assert.equal((await h.send({ type: 'POPUP_DISABLE' }, h.popup)).ok, true);
  assert.equal((await h.send({ type: 'WATCH_CONFIG' })).data.enabled, false);
  assert.equal(h.calls[h.calls.length - 1].url, `http://localhost:3000/api/watch/session/${h.sessionId}/stop`);
  assert.equal((await h.send({ type: 'WATCH_WINDOW', sessionId: h.sessionId, time: 0 })).ok, false);
});
test('no HTML injection sinks or forbidden capture permissions', () => {
  for (const file of ['content.js', 'popup.js']) assert.doesNotMatch(fs.readFileSync(path.join(folder, file), 'utf8'), /\.innerHTML\s*=|insertAdjacentHTML|eval\(/);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'tabCapture', 'offscreen']);
  assert.doesNotMatch(manifest.permissions.join(','), /debugger|desktopCapture|audioCapture|videoCapture/);
  const capture = fs.readFileSync(path.join(folder, 'offscreen.js'), 'utf8');
  assert.match(capture, /chromeMediaSource: 'tab'/); assert.match(capture, /video: false/);
  assert.doesNotMatch(capture, /getDisplayMedia|audio: true/);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.content_scripts[0].all_frames, false);
});

test('async 202 jobs are polled with fixed GET routes and unwrapped only when done', async () => {
  const h = harness({ asyncJobs: true }); await h.enable();
  const result = await h.send({ type: 'WATCH_SESSION', url: h.tab.url });
  assert.equal(result.ok, true); assert.equal(result.data.sessionId, h.sessionId);
  assert.equal(h.calls[0].options.headers.Prefer, 'respond-async');
  const polls = h.calls.filter(call => call.options.method === 'GET');
  assert.equal(polls.length, 2); assert.ok(h.apiTouches() >= 2);
  for (const call of polls) { assert.equal(call.url, `http://localhost:3000/api/watch/jobs/${h.jobId}`); assert.equal(call.options.headers.Authorization, 'Bearer pairing-token-123456789'); }
});
test('source cancellation is request-scoped and deletes only its own pending job', async () => {
  const h = harness({ asyncJobs: true, jobNeverDone: true }); await h.enable();
  const pending = h.send({ type: 'WATCH_SESSION', url: h.tab.url, requestId: 'source-request-0001' });
  await new Promise(resolve => setImmediate(resolve));
  await h.send({ type: 'WATCH_CANCEL_CREATE', requestId: 'older-request-9999' });
  assert.equal(h.calls.some(call => call.options.method === 'DELETE'), false);
  await h.send({ type: 'WATCH_CANCEL_CREATE', requestId: 'source-request-0001' });
  const result = await pending;
  assert.equal(result.ok, false); assert.equal(result.code, 'ABORTED');
  assert.equal(h.calls.filter(call => call.options.method === 'DELETE').length, 1);
  assert.equal(h.calls.at(-1).url, `http://localhost:3000/api/watch/jobs/${h.jobId}`);
});
test('hard navigation cancels pending source work even without content-script stop', async () => {
  const h = harness({ asyncJobs: true, jobNeverDone: true }); await h.enable();
  const pending = h.send({ type: 'WATCH_SESSION', url: h.tab.url });
  await new Promise(resolve => setImmediate(resolve));
  h.navigate('https://example.com/');
  const result = await pending; assert.equal(result.code, 'ABORTED');
  assert.ok(h.calls.some(call => call.options.method === 'DELETE'));
});
test('malicious async job IDs cannot alter loopback routes or produce arbitrary fetch', async () => {
  const h = harness({ asyncJobs: true, badJobId: '../../https://evil.test' }); await h.enable();
  const result = await h.send({ type: 'WATCH_SESSION', url: h.tab.url });
  assert.equal(result.code, 'INVALID_RESPONSE'); assert.equal(h.calls.length, 1);
});
test('failed calls reserve the agreed limit; successful cache hits do not consume it', async () => {
  const failed = harness({ windowFails: true }); await failed.enable(1); await failed.send({ type: 'WATCH_SESSION', url: failed.tab.url });
  assert.equal((await failed.send({ type: 'WATCH_WINDOW', sessionId: failed.sessionId, time: 0 })).ok, false);
  assert.equal((await failed.send({ type: 'WATCH_WINDOW', sessionId: failed.sessionId, time: 2 })).code, 'EXTENSION_LIMIT');
  assert.equal(failed.calls.length, 2);
  const cached = harness({ cacheHits: true }); await cached.enable(1); await cached.send({ type: 'WATCH_SESSION', url: cached.tab.url });
  assert.equal((await cached.send({ type: 'WATCH_WINDOW', sessionId: cached.sessionId, time: 0 })).ok, true);
  assert.equal((await cached.send({ type: 'WATCH_WINDOW', sessionId: cached.sessionId, time: 2 })).ok, true);
});


test('local sessions continue past batch 11 and 51 with old saved caps; cloud stops at cap', async () => {
  for (const preference of [10, 50]) {
    const local = harness({ local: true }); await local.enable(preference); await local.send({ type: 'WATCH_SESSION', url: local.tab.url });
    for (let i = 1; i <= 52; i++) {
      const result = await local.send({ type: 'WATCH_WINDOW', sessionId: local.sessionId, time: 0 });
      assert.equal(result.ok, true, `local cap=${preference}, batch=${i}`);
      assert.equal(result.data.callsUsed, i);
    }
    const cloud = harness({ serverLimit: 100 }); await cloud.enable(preference); await cloud.send({ type: 'WATCH_SESSION', url: cloud.tab.url });
    for (let i = 0; i < preference; i++) assert.equal((await cloud.send({ type: 'WATCH_WINDOW', sessionId: cloud.sessionId, time: 0 })).ok, true);
    assert.equal((await cloud.send({ type: 'WATCH_WINDOW', sessionId: cloud.sessionId, time: 0 })).code, 'EXTENSION_LIMIT');
    assert.equal(cloud.calls.filter(call => call.url.endsWith('/window')).length, preference);
  }
});
test('local consent cannot authorize a cloud session; status refresh needs no re-pair or translation', async () => {
  const changed = harness(); await changed.enable(10, 'local');
  assert.equal((await changed.send({ type: 'WATCH_SESSION', url: changed.tab.url })).code, 'PROCESSING_MODE_CHANGED');
  assert.equal(changed.calls.some(call => call.url.endsWith('/window')), false);
  assert.ok(changed.calls.some(call => call.url.endsWith('/stop')));
  const local = harness({ local: true }); await local.enable(10);
  const token = local.locals.watchSettings.token;
  const result = await local.send({ type: 'POPUP_STATUS' }, local.popup);
  assert.equal(result.data.processingMode, 'local'); assert.equal(local.locals.watchSettings.token, token);
  assert.equal(local.locals.watchSettings.enabled, true); assert.equal(local.calls.length, 1);
});

test('full-prefetch preference is exposed only with saved local consent; API and cloud limits are unchanged', async () => {
  const h = harness({ local: true });
  let result = await h.send({ type: 'WATCH_CONFIG' });
  assert.equal(result.data.localFullPrefetch, false); assert.equal(result.data.enabled, false);
  await h.enable(10, 'cloud'); result = await h.send({ type: 'WATCH_CONFIG' });
  assert.equal(result.data.localFullPrefetch, false); // settings default=true is not local authorization
  await h.enable(10, 'local'); result = await h.send({ type: 'WATCH_CONFIG' });
  assert.equal(result.data.localFullPrefetch, true); assert.equal(result.data.enabled, true);
  assert.equal('token' in result.data, false); assert.equal(h.calls.length, 0);
  h.locals.watchSettings.localFullPrefetch = false;
  assert.equal((await h.send({ type: 'WATCH_CONFIG' })).data.localFullPrefetch, false);
  h.locals.watchSettings.localFullPrefetch = true; h.locals.watchSettings.consent = false;
  assert.equal((await h.send({ type: 'WATCH_CONFIG' })).data.enabled, false); // no work even if preference remains true
});
