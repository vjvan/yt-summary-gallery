/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node mocks for classic MV3 scripts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const audioCore = require('../audio-core.js');
const folder = path.join(__dirname, '..');
const settle = () => new Promise(resolve => setImmediate(resolve));
const sourceId = 'kfbWz9_bJoA';
const sessionId = 'aaaa1111-2222-3333-4444-555566667777';
const chunkId = 'bbbb1111-2222-3333-4444-555566667777';
function harness({ slowChunk = false, localMode = false } = {}) {
  const calls = []; const contentMessages = []; const offscreenMessages = []; const captures = []; const documents = [];
  const local = { watchSettings: { server: 'http://localhost:3000', token: 'pairing-token-123456789', enabled: false } }; const session = {};
  let receive, activated, focus, now = 100000, chunks = 0;
  const provider = { processingMode: localMode ? 'local' : 'cloud', unlimited: localMode, translationConfigured: true, audioConfigured: true, translationModel: 'mock' };
  const clock = { videoId: sourceId, time: 0, rate: 1, paused: false, ad: false, visible: true, seeking: false, ended: false };
  const tab = { id: 7, windowId: 1, url: `https://www.youtube.com/watch?v=${sourceId}`, title: 'English tutorial' };
  const area = store => ({ async get(keys) { if (keys === null) return { ...store }; return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]])); }, async set(value) { Object.assign(store, value); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; }, async setAccessLevel() {} });
  const chrome = {
    runtime: { id: 'ext', getURL: file => `chrome-extension://ext/${file}`, async getPlatformInfo() { return {}; }, async getContexts() { return documents.length ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []; }, onMessage: { addListener(fn) { receive = fn; } }, async sendMessage(message) { offscreenMessages.push(message); return { ok: true }; } },
    storage: { local: area(local), session: area(session) },
    tabs: { async get(id) { return { ...tab, id }; }, async query() { return [{ ...tab }]; }, async sendMessage(id, message) { contentMessages.push({ id, ...message }); return message.type === 'AUDIO_GET_CLOCK' ? { ...clock, observedAt: now } : { ok: true }; }, onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, onActivated: { addListener(fn) { activated = fn; } } },
    windows: { onFocusChanged: { addListener(fn) { focus = fn; } } },
    offscreen: { async createDocument(options) { documents.push(options); } },
    tabCapture: { async getMediaStreamId(options) { captures.push(options); return 'approved-tab-stream'; } },
  };
  let context;
  const sandbox = { chrome, console, URL, AbortController, Date: { now: () => now }, crypto: crypto.webcrypto, Blob, FormData, Uint8Array, atob, setTimeout, clearTimeout,
    importScripts(file) { vm.runInContext(fs.readFileSync(path.join(folder, file), 'utf8'), context); },
    async fetch(url, options) {
      calls.push({ url, options });
      let data = { stopped: true };
      if (url.endsWith('/status')) data = { version: 3, ...provider };
      if (url.endsWith('/audio/session')) data = { audioSessionId: sessionId, videoId: sourceId, ...provider, limits: { sessionChunks: localMode ? null : 2, dailyChunks: localMode ? null : 10, maxChunkSeconds: 15 }, sourceLanguage: 'en' };
      if (url.endsWith('/audio/chunk')) {
        const start = Number(options.body.get('start')), end = Number(options.body.get('end'));
        const cue = { id: `audio-${options.body.get('chunkId')}`, start, end, text: '專業術語測試', originalText: 'Technical term test' };
        data = { audioSessionId: sessionId, chunkId: options.body.get('chunkId'), cues: [cue], originalCues: [{ ...cue, text: cue.originalText }], usage: { sessionChunks: ++chunks, dailyChunks: chunks }, cached: false };
        if (slowChunk) return new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); });
      }
      return { ok: true, status: 200, async json() { return data; } };
    },
  };
  context = vm.createContext(sandbox); vm.runInContext(fs.readFileSync(path.join(folder, 'background.js'), 'utf8'), context);
  const popup = { id: 'ext', url: 'chrome-extension://ext/popup.html' };
  const sender = { id: 'ext', url: tab.url, tab, frameId: 0 };
  const offscreen = { id: 'ext', url: 'chrome-extension://ext/offscreen.html' };
  const send = (message, origin = sender) => new Promise(resolve => receive(message, origin, resolve));
  const runId = () => contentMessages.findLast(message => message.type === 'AUDIO_STARTED')?.runId;
  return { calls, contentMessages, offscreenMessages, captures, documents, local, clock, tab, send, popup, sender, offscreen, runId,
    async start(maxChunks = localMode ? 0 : 2, expectedProcessingMode = localMode ? 'local' : 'cloud') { return send({ type: 'POPUP_AUDIO_START', confirmAudio: true, maxChunks, expectedProcessingMode }, popup); },
    async clockTick() { return send({ type: 'AUDIO_CLOCK', runId: runId(), clock: { ...clock, observedAt: now } }); },
    advance(seconds) { now += seconds * 1000; clock.time += seconds; },
    async captured(id = chunkId) { const recording = offscreenMessages.findLast(message => message.type === 'OFFSCREEN_RECORD'); return send({ type: 'AUDIO_CAPTURED', runId: runId(), chunkId: id, start: recording.start, duration: 12, mimeType: 'audio/webm;codecs=opus', base64: 'GkXfow==' }, offscreen); },
    activate(id) { activated({ tabId: id }); }, blur() { focus(-1); },
  };
}

test('V2 only starts from trusted popup and fresh explicit audio consent', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'POPUP_AUDIO_START', confirmAudio: true, maxChunks: 2 })).code, 'FORBIDDEN');
  assert.equal((await h.send({ type: 'POPUP_AUDIO_START', confirmAudio: false, maxChunks: 2 }, h.popup)).code, 'AUDIO_CONSENT_REQUIRED');
  assert.equal(h.captures.length, 0); assert.equal(h.calls.length, 0);
  assert.equal((await h.start()).ok, true);
  assert.equal(h.captures[0].targetTabId, 7);
  assert.deepEqual(Array.from(h.documents[0].reasons), ['USER_MEDIA']);
  assert.equal(h.local.watchSettings.enabled, false);
  assert.ok(h.offscreenMessages.every(message => !('token' in message) && !('config' in message)));
});
test('pairing test uses authenticated GET status without enabling or capturing', async () => {
  const h = harness();
  const result = await h.send({ type: 'POPUP_PAIR', server: 'http://localhost:3000', token: 'pairing-token-123456789' }, h.popup);
  assert.equal(result.ok, true); assert.equal(result.data.version, 3);
  assert.equal(h.calls[0].options.method, 'GET'); assert.equal(h.calls[0].url, 'http://localhost:3000/api/watch/status');
  assert.equal(h.captures.length, 0); assert.equal(h.local.watchSettings.enabled, false);
});
test('paused/ad/background/seeking/non-1x clocks refuse capture before API calls', async () => {
  for (const patch of [{ paused: true }, { ad: true }, { visible: false }, { seeking: true }, { rate: 1.5 }]) {
    const h = harness(); Object.assign(h.clock, patch);
    assert.equal((await h.start()).ok, false); assert.equal(h.captures.length, 0); assert.equal(h.calls.length, 0);
  }
});
test('complete clips use multipart, exact loopback, six-decimal clock and no JSON content type', async () => {
  const h = harness(); h.clock.time = 0.123456789;
  await h.start(); await h.clockTick(); h.advance(12);
  assert.equal((await h.captured()).ok, true);
  const request = h.calls.find(call => call.url.endsWith('/audio/chunk'));
  assert.equal(request.options.method, 'POST'); assert.equal(request.options.headers.Prefer, 'respond-async');
  assert.equal(request.options.headers['Content-Type'], undefined);
  assert.equal(request.options.body.get('start'), '0.123457'); assert.equal(request.options.body.get('end'), '12.123457');
  assert.equal(request.options.body.get('confirmAudio'), 'true'); assert.equal(request.options.body.get('file').type, 'audio/webm;codecs=opus');
  assert.ok(h.contentMessages.some(message => message.type === 'AUDIO_RESULT' && message.start < message.end));
});
test('one pending STT clip creates backpressure and pause aborts without late result', async () => {
  const h = harness({ slowChunk: true }); await h.start(); await h.clockTick(); h.advance(12);
  const pending = h.captured(); await settle();
  const recordings = h.offscreenMessages.filter(message => message.type === 'OFFSCREEN_RECORD').length;
  await h.clockTick(); assert.equal(h.offscreenMessages.filter(message => message.type === 'OFFSCREEN_RECORD').length, recordings);
  h.clock.paused = true; await h.clockTick();
  assert.equal((await pending).ok, false);
  assert.ok(h.offscreenMessages.some(message => message.type === 'OFFSCREEN_STOP'));
  assert.equal(h.contentMessages.some(message => message.type === 'AUDIO_RESULT'), false);
});
test('forged content audio and wrong-tab stop cannot upload or stop the owning capture', async () => {
  const h = harness(); await h.start(); await h.clockTick();
  assert.equal((await h.send({ type: 'AUDIO_CAPTURED', runId: h.runId() })).code, 'FORBIDDEN');
  await h.send({ type: 'AUDIO_STOP', runId: h.runId() }, { ...h.sender, tab: { ...h.tab, id: 9 } });
  assert.equal(h.offscreenMessages.some(message => message.type === 'OFFSCREEN_STOP'), false);
  assert.equal(h.calls.some(call => call.url.endsWith('/audio/chunk')), false);
});
test('raw clock validation and boundaries reject discontinuities and oversized base64', () => {
  assert.equal(audioCore.roundTime(12.123456789), 12.123457);
  assert.equal(audioCore.validBoundary(0, 12), true); assert.equal(audioCore.validBoundary(0, 2), false);
  assert.equal(audioCore.validBoundary(0, 20), false);
  assert.equal(audioCore.validBase64('GkXfow=='), true); assert.equal(audioCore.validBase64('<script>'), false);
  assert.equal(audioCore.validBase64('A'.repeat(3 * 1024 * 1024)), false);
  assert.equal(audioCore.maxChunks(100), 20); assert.equal(audioCore.maxChunks(0), 2);
});


test('local audio accepts server-confirmed unlimited and continues beyond cloud 20-chunk cap', async () => {
  const h = harness({ localMode: true }); assert.equal((await h.start()).ok, true);
  const startRequest = h.calls.find(call => call.url.endsWith('/audio/session'));
  assert.equal(JSON.parse(startRequest.options.body).maxChunks, 0);
  assert.equal(h.contentMessages.find(message => message.type === 'AUDIO_STARTED').maxChunks, null);
  for (let chunk = 0; chunk < 51; chunk++) {
    await h.clockTick(); h.advance(12);
    assert.equal((await h.captured(crypto.randomUUID())).ok, true, `chunk ${chunk + 1}`);
  }
  assert.equal(h.calls.filter(call => call.url.endsWith('/audio/chunk')).length, 51);
  assert.equal(h.contentMessages.some(message => message.type === 'AUDIO_STOPPED' && /上限/.test(message.reason)), false);
  assert.equal(h.offscreenMessages.filter(message => message.type === 'OFFSCREEN_RECORD').length, 51);
  await h.send({ type: 'POPUP_AUDIO_STOP' }, h.popup);
  assert.ok(h.offscreenMessages.some(message => message.type === 'OFFSCREEN_STOP'));
});
test('cloud audio cannot accept unlimited or reuse local-only consent, and finite chunks still stop', async () => {
  const denied = harness(); assert.equal((await denied.start(0)).code, 'AUDIO_LIMIT_REQUIRED'); assert.equal(denied.captures.length, 0);
  assert.equal((await denied.start(2, 'local')).code, 'PROCESSING_MODE_CHANGED'); assert.equal(denied.captures.length, 0);
  const cloud = harness(); await cloud.start();
  for (let i = 0; i < 2; i++) { await cloud.clockTick(); cloud.advance(12); await cloud.captured(crypto.randomUUID()); }
  assert.ok(cloud.contentMessages.some(message => message.type === 'AUDIO_STOPPED' && /上限/.test(message.reason)));
  assert.equal(cloud.calls.filter(call => call.url.endsWith('/audio/chunk')).length, 2);
});
