/* eslint-disable @typescript-eslint/no-require-imports -- Standalone VM regressions for classic MV3 scripts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const folder = path.join(__dirname, '..');
const QUALITY_MESSAGE = '本機譯文未保留指定專有名詞；這一批未寫入成功快取。';
const QUALITY_CODE = 'LOCAL_TRANSLATION_QUALITY';
const clone = value => structuredClone(value);
const response = (status, data) => ({ ok: status < 400, status, async json() { return clone(data); } });
const qualityFailure = () => response(502, {
  error: QUALITY_MESSAGE, code: QUALITY_CODE,
  // A failed response must not accidentally become a successful English fallback.
  cues: [{ id: 'c0', start: 0, end: 1.5, text: 'Keep Figma Weave unchanged.' }], cached: true,
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function untilReleased(gate, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    gate.promise.then(() => { signal.removeEventListener('abort', aborted); resolve(); });
  });
}

// Every case executes the real service worker, including its imported scripts and
// chrome.runtime.onMessage listener. No real Chrome, backend, or model is used.
function harness(t, options = {}) {
  const local = options.local !== false;
  const locals = {}, sessions = {}, calls = [];
  let onMessage, context, windowCalls = 0, accepted = 0;
  const id = 'recovery-extension-id';
  const videoId = 'N-tmQ_Can_o';
  const tab = { id: 7, url: `https://www.youtube.com/watch?v=${videoId}` };
  const sessionId = 'd0f5f74c-22f4-426f-a42a-abcdef123456';
  const jobId = 'ab1292ad-1111-2222-3333-123456abcdef';
  const sessionKey = `watchSession:${sessionId}`;
  const source = Array.from({ length: 24 }, (_, index) => ({
    id: `c${index}`, start: index * 2, end: index * 2 + 1.5,
    text: `Keep Figma Weave unchanged, source cue ${index}.`,
  }));
  const view = {
    sessionId, videoId, cues: source, processingMode: local ? 'local' : 'cloud',
    translationModel: local ? 'qwen2.5:7b' : 'cloud-test-model',
    unlimited: local, translationEnabled: true,
    limits: { sessionCalls: local ? null : 10, dailyCalls: local ? null : 100 },
  };
  function area(store) {
    return {
      async get(keys) {
        if (keys === null) return clone(store);
        return clone(Object.fromEntries((Array.isArray(keys) ? keys : [keys])
          .filter(key => key in store).map(key => [key, store[key]])));
      },
      async set(values) { Object.assign(store, clone(values)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key]; },
      async setAccessLevel() {},
    };
  }
  const chrome = {
    runtime: {
      id, getURL: name => `chrome-extension://${id}/${name}`,
      async getPlatformInfo() { return { os: 'mac' }; },
      onMessage: { addListener(listener) { onMessage = listener; } },
    },
    storage: { local: area(locals), session: area(sessions) },
    tabs: {
      async get(tabId) { return { ...tab, id: tabId }; }, async query() { return [{ ...tab }]; },
      async sendMessage() { return { ok: true }; },
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
    },
  };
  function successfulWindow(request) {
    accepted++;
    const first = source.findIndex(cue => cue.end > request.time);
    const index = Math.floor(first / 8) * 8;
    return response(200, {
      sessionId, windowKey: String(index / 8),
      cues: source.slice(index, index + 8).map(cue => ({
        ...cue, originalText: cue.text, text: `保持 Figma Weave 不變，字幕 ${cue.id}。`,
      })),
      cached: false, callsUsed: accepted, dailyCallsUsed: accepted,
    });
  }
  const sandbox = {
    chrome, console, URL, AbortController, clearTimeout,
    setTimeout(callback, ms) { return setTimeout(callback, ms === 1500 ? 1 : ms); },
    importScripts(file) { vm.runInContext(fs.readFileSync(path.join(folder, file), 'utf8'), context); },
    async fetch(url, request) {
      calls.push({ url, request });
      assert.equal(new URL(url).origin, 'http://localhost:3000', 'all wire calls stay on the paired loopback server');
      assert.equal(request.headers.Authorization, 'Bearer pairing-token-123456789');
      assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error');
      if (url.endsWith('/api/watch/session')) return response(200, view);
      if (url.endsWith(`/api/watch/session/${sessionId}/stop`)) return response(200, { stopped: true });
      if (url.endsWith('/api/watch/window')) {
        const body = JSON.parse(request.body);
        assert.deepEqual(Object.keys(body).sort(), ['confirmTranslation', 'sessionId', 'time']);
        assert.equal(body.sessionId, sessionId); assert.equal(body.confirmTranslation, true);
        const count = ++windowCalls;
        if (options.window) return options.window({ count, body, signal: request.signal, successfulWindow, jobId });
        return count === 1 ? qualityFailure() : successfulWindow(body);
      }
      if (url.endsWith(`/api/watch/jobs/${jobId}`)) {
        if (request.method === 'DELETE') return response(200, { stopped: true });
        if (request.method === 'GET' && options.poll) return options.poll({ signal: request.signal, jobId });
      }
      throw new Error(`Unexpected mocked request: ${request.method} ${url}`);
    },
  };
  context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(folder, 'background.js'), 'utf8'), context);
  t.after(() => vm.runInContext('for (const controller of controllers.values()) controller.abort();', context));
  const popup = { id, url: `chrome-extension://${id}/popup.html` };
  const content = { id, url: tab.url, tab, frameId: 0 };
  function send(message, sender = content) {
    return new Promise(resolve => {
      assert.equal(onMessage(message, sender, resolve), true);
    });
  }
  async function start(maxBatches = 10) {
    const enabled = await send({
      type: 'POPUP_ENABLE', expectedProcessingMode: local ? 'local' : 'cloud',
      settings: { server: 'http://localhost:3000', token: 'pairing-token-123456789', enabled: true,
        consent: true, autoMode: false, maxBatches },
    }, popup);
    assert.equal(enabled.ok, true, enabled.error);
    const started = await send({ type: 'WATCH_SESSION', url: tab.url, requestId: 'recovery-source-0001' });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.data.translationModel, view.translationModel);
    assert.ok(sessions[sessionKey]);
    return started;
  }
  async function waitForWindow(count) {
    for (let turn = 0; turn < 30 && windowCalls < count; turn++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(windowCalls, count, 'pending real handler reached the mocked window endpoint');
  }
  return {
    start, send, calls, sessions, source, sessionId, jobId, content, sessionKey, waitForWindow,
    record: () => sessions[sessionKey], windowCalls: () => windowCalls,
    window: time => send({ type: 'WATCH_WINDOW', sessionId, time }),
  };
}

function assertQualityRejected(result) {
  assert.equal(result.ok, false);
  assert.equal(result.code, QUALITY_CODE);
  assert.equal(result.status, 502);
  assert.equal(result.error, QUALITY_MESSAGE);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'error', 'ok', 'status']);
  assert.equal(result.data, undefined, 'quality rejection contains no successful cache or English fallback');
}

test('local quality rejection is passed through without deleting the session; another window can succeed', async t => {
  const h = harness(t);
  await h.start(1);
  const original = clone(h.source);
  assertQualityRejected(await h.window(0));
  assert.equal(h.record().processingMode, 'local');
  assert.equal(h.record().callsUsed, 0, 'rejected output is not counted as accepted output');
  assert.equal(h.record().reservedCalls, 1, 'uncertain requests retain their reservations');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.windowCalls(), 1, 'the service worker never retries rejected text by itself');
  assert.equal(h.calls.some(call => call.url.endsWith('/stop')), false);

  const next = await h.window(16);
  assert.equal(next.ok, true);
  assert.equal(next.data.sessionId, h.sessionId);
  assert.equal(next.data.windowKey, '1');
  assert.equal(next.data.cues.length, 8);
  assert.equal(next.data.cues[0].id, 'c8');
  assert.equal(next.data.cues[0].start, original[8].start);
  assert.equal(next.data.cues[0].end, original[8].end);
  assert.equal(next.data.cues[0].originalText, original[8].text);
  assert.notEqual(next.data.cues[0].text, original[8].text);
  assert.equal(h.record().callsUsed, 1);
  assert.equal(h.record().reservedCalls, 2);
  assert.equal(h.calls.filter(call => call.url.endsWith('/api/watch/session')).length, 1);
  assert.deepEqual(h.source, original, 'the worker does not rewrite original cues');
});

test('async-job quality rejection remains an error and cleans only its job, not the active session', async t => {
  const h = harness(t, {
    window: ({ count, body, successfulWindow, jobId }) => count === 1
      ? response(202, { jobId, status: 'processing' }) : successfulWindow(body),
    poll: () => qualityFailure(),
  });
  await h.start();
  assertQualityRejected(await h.window(0));
  assert.ok(h.record()); assert.equal(h.record().callsUsed, 0);
  const cleanup = h.calls.filter(call => call.request.method === 'DELETE');
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0].url, `http://localhost:3000/api/watch/jobs/${h.jobId}`);
  assert.equal(h.calls.some(call => call.url.endsWith('/stop')), false);
  assert.equal((await h.window(32)).data.windowKey, '2');
  assert.equal(h.record().callsUsed, 1);
});

test('singleflight rejects concurrent requests without spending a reservation and unlocks after quality failure', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const h = harness(t, {
    async window({ count, body, signal, successfulWindow }) {
      if (count > 1) return successfulWindow(body);
      await untilReleased(gate, signal);
      return qualityFailure();
    },
  });
  await h.start();
  const pending = h.window(0);
  await h.waitForWindow(1);
  const concurrent = await h.window(16);
  assert.equal(concurrent.ok, false); assert.equal(concurrent.code, 'BUSY');
  assert.equal(h.windowCalls(), 1); assert.equal(h.record().reservedCalls, 1);
  gate.resolve(); assertQualityRejected(await pending);
  assert.equal((await h.window(16)).ok, true);
  assert.equal(h.windowCalls(), 2); assert.equal(h.record().reservedCalls, 2);
});

test('a quality-like backend error in cloud mode does not refund cost or bypass the agreed cap', async t => {
  const h = harness(t, { local: false });
  await h.start(1);
  assertQualityRejected(await h.window(0));
  assert.equal(h.record().processingMode, 'cloud');
  assert.equal(h.record().callsUsed, 0); assert.equal(h.record().reservedCalls, 1);
  for (const time of [0, 16, 32]) {
    const blocked = await h.window(time);
    assert.equal(blocked.ok, false); assert.equal(blocked.code, 'EXTENSION_LIMIT');
    assert.equal(blocked.status, 429);
  }
  assert.equal(h.windowCalls(), 1, 'neither a manual retry nor a new window evades cloud reservations');
  assert.ok(h.record());
});

test('window cancellation aborts pending work without a false success; local session can continue', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const h = harness(t, {
    async window({ count, body, signal, successfulWindow }) {
      if (count > 1) return successfulWindow(body);
      await untilReleased(gate, signal);
      return qualityFailure();
    },
  });
  await h.start();
  const pending = h.window(0); await h.waitForWindow(1);
  assert.equal((await h.send({ type: 'WATCH_CANCEL_WINDOW', sessionId: h.sessionId })).ok, true);
  const cancelled = await pending;
  assert.equal(cancelled.ok, false); assert.equal(cancelled.code, 'ABORTED');
  assert.equal(cancelled.status, 408); assert.equal(cancelled.data, undefined);
  assert.equal(h.record().callsUsed, 0); assert.equal(h.record().reservedCalls, 1);
  assert.equal((await h.window(16)).ok, true);
  assert.equal(h.record().callsUsed, 1); assert.equal(h.record().reservedCalls, 2);
});

test('cloud cancellation still consumes a reservation; stop removes the session and prevents further fetches', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const h = harness(t, {
    local: false,
    async window({ signal }) { await untilReleased(gate, signal); return qualityFailure(); },
  });
  await h.start(1);
  const pending = h.window(0); await h.waitForWindow(1);
  await h.send({ type: 'WATCH_CANCEL_WINDOW', sessionId: h.sessionId });
  assert.equal((await pending).code, 'ABORTED');
  assert.equal(h.record().reservedCalls, 1);
  assert.equal((await h.window(16)).code, 'EXTENSION_LIMIT');
  const stopped = await h.send({ type: 'WATCH_STOP', sessionId: h.sessionId });
  assert.equal(stopped.ok, true); assert.equal(h.record(), undefined);
  assert.equal(h.calls.filter(call => call.url.endsWith(`/session/${h.sessionId}/stop`)).length, 1);
  assert.equal((await h.window(16)).code, 'SESSION_EXPIRED');
  assert.equal(h.windowCalls(), 1);
});

test('stop during an active request aborts it and never recreates the removed session record', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const h = harness(t, {
    async window({ signal }) { await untilReleased(gate, signal); return qualityFailure(); },
  });
  await h.start();
  const pending = h.window(0); await h.waitForWindow(1);
  const stopped = await h.send({ type: 'WATCH_STOP', sessionId: h.sessionId });
  assert.equal(stopped.ok, true);
  assert.equal((await pending).code, 'ABORTED');
  assert.equal(h.record(), undefined);
  gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.record(), undefined, 'late completion cannot recreate a stopped record');
  assert.equal((await h.window(16)).code, 'SESSION_EXPIRED');
  assert.equal(h.windowCalls(), 1);
});
