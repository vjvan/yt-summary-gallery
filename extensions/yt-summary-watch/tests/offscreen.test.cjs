/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node mocks for classic MV3 scripts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const folder = path.join(__dirname, '..');
const runId = 'aaaa1111-2222-3333-4444-555566667777';
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let receiver, now = 0, stopped = 0, connected = 0, closed = 0;
  const messages = [], mediaRequests = [], recorders = [], timers = new Map(), intervals = new Map();
  const track = { stop() { stopped++; }, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
  class Output {
    constructor() { this.destination = {}; }
    createMediaStreamSource() { return { connect() { connected++; }, disconnect() {} }; }
    async resume() {} async close() { closed++; }
  }
  class Recorder {
    static isTypeSupported() { return true; }
    constructor(input, options) { this.input = input; this.options = options; this.state = 'inactive'; recorders.push(this); }
    start(...args) { this.args = args; this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob([new Uint8Array([26, 69, 223, 163])], { type: this.options.mimeType }) }); void this.onstop?.(); }
  }
  const chrome = { runtime: { id: 'ext', getURL: file => `chrome-extension://ext/${file}`, onMessage: { addListener(fn) { receiver = fn; } }, async sendMessage(message) { messages.push(message); return { ok: true }; } } };
  const sandbox = { chrome, console, crypto: crypto.webcrypto, Blob, Uint8Array, btoa, AudioContext: Output, MediaRecorder: Recorder,
    navigator: { mediaDevices: { async getUserMedia(options) { mediaRequests.push(options); return stream; } } },
    Date: { now: () => now }, performance: { now: () => now },
    setTimeout(fn, ms) { const id = Symbol(); timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms) { const id = Symbol(); intervals.set(id, { fn, ms }); return id; }, clearInterval(id) { intervals.delete(id); },
  };
  const context = vm.createContext(sandbox);
  for (const file of ['audio-core.js', 'offscreen.js']) vm.runInContext(fs.readFileSync(path.join(folder, file), 'utf8'), context);
  const send = (message, sender = { id: 'ext', url: 'chrome-extension://ext/background.js' }) => new Promise(resolve => {
    const pending = receiver({ target: 'offscreen', runId, ...message }, sender, resolve);
    if (!pending) resolve({ ignored: true });
  });
  return { send, messages, mediaRequests, recorders, timers, intervals, stopped: () => stopped, connected: () => connected, closed: () => closed,
    async fullClip() { now += 12000; const found = [...timers].find(([, timer]) => timer.ms === 12000); assert.ok(found); timers.delete(found[0]); found[1].fn(); await settle(); },
    async loseHeartbeat() { now += 3000; for (const { fn } of intervals.values()) fn(); await settle(); },
  };
}

test('offscreen obtains only selected tab audio and reconnects it to output', async () => {
  const h = harness(); assert.equal((await h.send({ type: 'OFFSCREEN_START', streamId: 'approved-stream' })).ok, true);
  const request = h.mediaRequests[0];
  assert.equal(request.video, false); assert.equal(request.audio.mandatory.chromeMediaSource, 'tab'); assert.equal(request.audio.mandatory.chromeMediaSourceId, 'approved-stream');
  assert.equal(h.connected(), 1); assert.equal(h.recorders.length, 0);
  await h.send({ type: 'OFFSCREEN_STOP' }); assert.equal(h.stopped(), 1); assert.equal(h.closed(), 1); assert.equal(h.intervals.size, 0);
});
test('every complete clip uses a new recorder without timeslice fragments', async () => {
  const h = harness(); await h.send({ type: 'OFFSCREEN_START', streamId: 'approved-stream' });
  await h.send({ type: 'OFFSCREEN_RECORD', start: 0 }); await h.fullClip();
  assert.equal(h.messages.filter(message => message.type === 'AUDIO_CAPTURED').length, 1);
  const payload = h.messages.find(message => message.type === 'AUDIO_CAPTURED');
  assert.equal(payload.duration, 12); assert.equal(payload.base64, 'GkXfow=='); assert.equal('token' in payload, false);
  assert.equal((await h.send({ type: 'OFFSCREEN_RECORD', start: 12 })).ok, false); // Await server release: no queue.
  await h.send({ type: 'OFFSCREEN_RELEASE' }); await h.send({ type: 'OFFSCREEN_RECORD', start: 12 }); await h.fullClip();
  assert.equal(h.recorders.length, 2); assert.equal(h.recorders[0].args.length, 0); assert.equal(h.recorders[1].args.length, 0);
  assert.equal(h.messages.filter(message => message.type === 'AUDIO_CAPTURED').length, 2);
  await h.send({ type: 'OFFSCREEN_STOP' });
});
test('interrupted recording discards incomplete clip and stops all tracks', async () => {
  const h = harness(); await h.send({ type: 'OFFSCREEN_START', streamId: 'approved-stream' }); await h.send({ type: 'OFFSCREEN_RECORD', start: 0 });
  await h.send({ type: 'OFFSCREEN_STOP' }); await settle();
  assert.equal(h.messages.some(message => message.type === 'AUDIO_CAPTURED'), false); assert.equal(h.stopped(), 1); assert.equal(h.timers.size, 0); assert.equal(h.intervals.size, 0);
});
test('lost controller heartbeat stops tracks and cannot submit partial audio', async () => {
  const h = harness(); await h.send({ type: 'OFFSCREEN_START', streamId: 'approved-stream' }); await h.send({ type: 'OFFSCREEN_RECORD', start: 0 });
  await h.loseHeartbeat();
  assert.equal(h.stopped(), 1); assert.equal(h.messages.some(message => message.type === 'AUDIO_CAPTURED'), false);
  assert.ok(h.messages.some(message => message.type === 'AUDIO_CAPTURE_ERROR'));
});
test('offscreen rejects content-script or popup attempts to start capture directly', async () => {
  const h = harness();
  await h.send({ type: 'OFFSCREEN_START', streamId: 'stolen' }, { id: 'ext', url: 'https://www.youtube.com/watch?v=kfbWz9_bJoA', tab: { id: 7 } });
  await h.send({ type: 'OFFSCREEN_START', streamId: 'stolen' }, { id: 'ext', url: 'chrome-extension://ext/popup.html' });
  assert.equal(h.mediaRequests.length, 0);
});
