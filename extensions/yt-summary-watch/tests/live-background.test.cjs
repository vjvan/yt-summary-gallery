/* eslint-disable @typescript-eslint/no-require-imports -- Mock Discord capture controller; no user audio or network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const core = require('../live-core.js');
const settle = () => new Promise(resolve => setImmediate(resolve));
const folder = path.join(__dirname, '..');
const sessionId = 'aaaa1111-2222-3333-4444-555566667777';
function harness({ cloud = false, hold = false, ready = true } = {}) {
  const calls = [], captureCalls = [], offscreen = [], events = [], opened = [], badges = [];
  const local = { watchSettings: { server: 'http://localhost:3000', token: 'pairing-token-123456789', enabled: false } }, memory = {};
  const source = { id: 7, active: true, url: 'https://discord.com/channels/123456789012345678/234567890123456789', title: 'Synthetic Discord' };
  let foreground = source, receive, updated, removed, now = 100000, backendState = 'active';
  const storage = store => ({ async get(keys) { return keys === null ? { ...store } : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in store).map(key => [key, store[key]])); }, async set(value) { Object.assign(store, value); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; }, async setAccessLevel() {} });
  const provider = { processingMode: cloud ? 'cloud' : 'local', unlimited: true, audioConfigured: true, translationConfigured: true, translationReady: ready };
  const chrome = { runtime: { id: 'ext', getURL: file => `chrome-extension://ext/${file}`, async getPlatformInfo() {}, async getContexts() { return [{}]; }, onMessage: { addListener(fn) { receive = fn; } }, async sendMessage(message) { offscreen.push(message); events.push(message.type); return { ok: true, partialSeconds: 0 }; } },
    storage: { local: storage(local), session: storage(memory) },
    tabs: { async query() { return [foreground]; }, async get(id) { events.push('tabs.get'); if (id !== 7) throw new Error('missing tab'); return { ...source }; }, async create(options) { opened.push(options); }, async sendMessage() { return { ok: true }; }, onRemoved: { addListener(fn) { removed = fn; } }, onUpdated: { addListener(fn) { updated = fn; } }, onActivated: { addListener() {} } },
    tabCapture: { getMediaStreamId(options) { events.push('getMediaStreamId'); captureCalls.push(options); return Promise.resolve('one-time-id'); } },
    action: { async setBadgeText({ text }) { badges.push(text); }, async setBadgeBackgroundColor() {} },
    windows: { onFocusChanged: { addListener() {} } }, offscreen: { async createDocument() {} } };
  let context;
  const sandbox = { chrome, console, URL, crypto: crypto.webcrypto, AbortController, Blob, FormData, Uint8Array, atob, Date: { now: () => now }, setTimeout, clearTimeout,
    importScripts(file) { vm.runInContext(fs.readFileSync(path.join(folder, file), 'utf8'), context); },
    async fetch(url, options) {
      calls.push({ url, options }); events.push(`fetch:${new URL(url).pathname}`);
      let data = { stopped: true };
      if (url.endsWith('/status')) data = provider;
      else if (url.endsWith('/live/session')) data = { sessionId, ...provider, status: backendState, state: backendState };
      else if (url.endsWith(`/live/session/${sessionId}`)) data = { sessionId, ...provider, status: backendState, state: backendState };
      else if (url.endsWith('/live/chunk')) {
        data = { sessionId, sequence: Number(options.body.get('sequence')), cues: [], originalCues: [] };
        if (hold) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
      }
      return { ok: true, status: 200, async json() { return data; } };
    } };
  context = vm.createContext(sandbox); vm.runInContext(fs.readFileSync(path.join(folder, 'background.js'), 'utf8'), context);
  const popup = { id: 'ext', url: 'chrome-extension://ext/popup.html' }, audioSender = { id: 'ext', url: 'chrome-extension://ext/offscreen.html' };
  const send = (message, sender = popup) => new Promise(resolve => receive(message, sender, resolve));
  const runId = () => offscreen.findLast(message => message.type === 'LIVE_OFFSCREEN_START')?.runId;
  const wav = Buffer.from(core.wav(new Float32Array(16000 * 8).fill(0.1), 16000)).toString('base64');
  return { calls, captureCalls, offscreen, events, opened, badges, provider, memory, source, send, audioSender, runId,
    prepare: () => send({ type: 'POPUP_LIVE_PREPARE' }),
    start: (consent = true) => send({ type: 'POPUP_LIVE_START', confirmAudio: consent, sourceTabId: 7, sourceUrl: source.url }),
    chunk: (sequence, gapReason) => send({ type: 'LIVE_CAPTURED', runId: runId(), sequence, start: sequence * 8, end: sequence * 8 + 8, base64: wav, gapReason }, audioSender),
    heartbeat: () => send({ type: 'LIVE_HEARTBEAT', runId: runId(), partialSeconds: 0 }, audioSender),
    advance(ms) { now += ms; }, backendStop() { backendState = 'stopped'; },
    navigate(url) { source.url = url; updated(7, { url }); }, close() { removed(7); },
    background() { source.active = false; foreground = { id: 9, url: 'http://localhost:3000/live' }; },
  };
}
test('Discord is manual/local only: prepare never captures, cloud/readiness/unconfirmed starts refuse', async () => {
  for (const options of [{ cloud: true }, { ready: false }]) {
    const h = harness(options); assert.equal((await h.prepare()).data.ready, false);
    assert.equal((await h.start()).code, 'LIVE_PREPARE_REQUIRED'); assert.equal(h.captureCalls.length, 0);
  }
  const h = harness(); await h.prepare(); assert.equal(h.captureCalls.length, 0);
  assert.equal((await h.start(false)).code, 'LIVE_CONSENT_REQUIRED'); assert.equal(h.captureCalls.length, 0);
});
test('user gesture gets stream ID before slow APIs; only authenticated fixed local WAV routes are used', async () => {
  const h = harness(); await h.prepare(); h.events.length = 0;
  const response = await h.start(); assert.equal(response.ok, true, response.error); assert.equal(response.data.active, true);
  assert.equal(h.events[0], 'getMediaStreamId'); assert.equal(h.captureCalls[0].targetTabId, 7);
  const create = h.events.indexOf('fetch:/api/live/session'), capture = h.events.indexOf('LIVE_OFFSCREEN_START'); assert.ok(create > 0 && capture > create);
  await h.chunk(0); await settle();
  const call = h.calls.find(call => call.url.endsWith('/live/chunk'));
  assert.equal(call.options.headers.Prefer, 'respond-async'); assert.equal(call.options.headers['Content-Type'], undefined);
  assert.deepEqual([...call.options.body.keys()], ['sessionId', 'sequence', 'start', 'end', 'audio']);
  assert.equal(call.options.body.get('audio').type, 'audio/wav');
  for (const request of h.calls) { assert.equal(new URL(request.url).origin, 'http://localhost:3000'); assert.equal(request.options.headers.Authorization, 'Bearer pairing-token-123456789'); }
  assert.equal(h.offscreen.some(message => 'token' in message || 'config' in message), false);
  await h.send({ type: 'POPUP_LIVE_STOP' });
});
test('continuous capture keeps accepting while recognition is pending; queue over 30 seconds stops visibly', async () => {
  const h = harness({ hold: true }); await h.prepare(); await h.start();
  for (let i = 0; i < 3; i++) assert.equal((await h.chunk(i)).data.accepted, true);
  const state = await h.send({ type: 'POPUP_LIVE_STATE' }); assert.equal(state.data.active, true); assert.equal(state.data.queueSeconds, 24); assert.match(state.data.message, /處理落後/);
  assert.equal(h.calls.filter(call => call.url.endsWith('/live/chunk')).length, 1);
  assert.equal((await h.chunk(3)).data.stopped, true);
  const stopped = (await h.send({ type: 'POPUP_LIVE_STATE' })).data;
  assert.equal(stopped.active, false); assert.match(stopped.message, /超過 30 秒/); assert.equal(stopped.unprocessedSeconds, 32);
  const stopCall = h.calls.find(call => call.url.endsWith(`/live/session/${sessionId}/stop`)); assert.equal(JSON.parse(stopCall.options.body).reason, 'queue-overflow');
  assert.ok(h.offscreen.some(message => message.type === 'LIVE_OFFSCREEN_STOP'));
});
test('background translation panel does not stop original Discord audio; UI stop polling does', async () => {
  const h = harness(); await h.prepare(); await h.start(); h.background();
  assert.equal((await h.heartbeat()).data.active, true); await settle();
  await h.send({ type: 'POPUP_LIVE_OPEN' }); assert.equal(h.opened[0].url, `http://localhost:3000/live?session=${sessionId}`);
  h.backendStop(); h.advance(2500); await h.heartbeat(); await settle(); await settle();
  assert.equal((await h.send({ type: 'POPUP_LIVE_STATE' })).data.active, false);
  assert.ok(h.offscreen.some(message => message.type === 'LIVE_OFFSCREEN_STOP'));
});
test('source navigation/close and forged messages cannot leak audio to another channel', async () => {
  const h = harness(); await h.prepare(); await h.start();
  const forged = await h.send({ type: 'LIVE_CAPTURED', runId: h.runId() }, { id: 'ext', url: h.source.url, tab: h.source }); assert.equal(forged.code, 'FORBIDDEN');
  h.navigate('https://discord.com/channels/123456789012345678/345678901234567890'); await settle(); await settle();
  assert.equal((await h.send({ type: 'POPUP_LIVE_STATE' })).data.active, false);
  assert.equal(h.calls.some(call => call.url.endsWith('/live/chunk')), false);
  const closed = harness(); await closed.prepare(); await closed.start(); closed.close(); await settle(); await settle();
  assert.equal((await closed.send({ type: 'POPUP_LIVE_STATE' })).data.active, false);
});
test('stale sequence, mode changes and repeated starts never silently auto-resume', async () => {
  const h = harness(); await h.prepare(); await h.start();
  assert.equal((await h.chunk(2)).code, 'LIVE_INVALID_CHUNK'); assert.equal((await h.start()).code, 'LIVE_PREPARE_REQUIRED');
  const changed = harness(); await changed.prepare(); changed.provider.processingMode = 'cloud';
  assert.equal((await changed.start()).code, 'LIVE_MODE_REQUIRED');
  assert.equal(changed.offscreen.some(message => message.type === 'LIVE_OFFSCREEN_START'), false);
});
