/* eslint-disable @typescript-eslint/no-require-imports -- Shared offscreen mocks, no microphone/Discord access. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const runId = 'aaaa1111-2222-3333-4444-555566667777';
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const listeners = [], messages = [], media = [], streams = [], worklets = [], contexts = [], intervals = new Map();
  let now = 0, active = true;
  class Output {
    constructor() { this.destination = {}; this.connections = []; this.closed = false; this.audioWorklet = { addModule: async url => { assert.equal(url, 'chrome-extension://ext/live-worklet.js'); } }; contexts.push(this); }
    createMediaStreamSource() { return { connect: target => this.connections.push(target), disconnect() {} }; }
    async close() { this.closed = true; } async resume() {}
  }
  class Worklet {
    constructor(context, name, options) { assert.equal(name, 'live-pcm-segmenter'); assert.equal(options.numberOfOutputs, 0); this.messages = []; this.port = { postMessage: value => this.messages.push(value) }; worklets.push(this); }
    disconnect() {}
  }
  const chrome = { runtime: { id: 'ext', getURL: file => `chrome-extension://ext/${file}`, onMessage: { addListener(fn) { listeners.push(fn); } }, async sendMessage(message) { messages.push(message); return { ok: true, data: { active } }; } } };
  const context = vm.createContext({ chrome, URL, console, Float32Array, Uint8Array, DataView, crypto: crypto.webcrypto, btoa, Blob, AudioContext: Output, AudioWorkletNode: Worklet, Date: { now: () => now }, performance: { now: () => now }, setTimeout, clearTimeout,
    setInterval(fn) { const key = Symbol(); intervals.set(key, fn); return key; }, clearInterval(key) { intervals.delete(key); },
    navigator: { mediaDevices: { async getUserMedia(options) {
      media.push(options); const track = { stopped: false, stop() { this.stopped = true; }, addEventListener(name, fn) { this[name] = fn; } }; streams.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
    } } } });
  for (const file of ['audio-core.js', 'offscreen.js', 'live-core.js', 'live-offscreen.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const send = (message, sender = { id: 'ext', url: 'chrome-extension://ext/background.js' }) => new Promise(resolve => {
    let pending = false;
    for (const listener of listeners) pending = listener({ target: 'offscreen', runId, ...message }, sender, resolve) || pending;
    if (!pending) resolve({ ignored: true });
  });
  return { send, messages, media, streams, worklets, contexts, intervals,
    async heartbeat(advance = 1000) { now += advance; for (const callback of [...intervals.values()]) callback(); await settle(); },
    serverStops() { active = false; }, emitSegment(sequence = 0) { worklets.at(-1).port.onmessage({ data: { type: 'segment', samples: new Float32Array(48000).fill(0.1), sampleRate: 16000, sequence, startSample: sequence * 48000, endSample: (sequence + 1) * 48000 } }); },
  };
}
test('shared offscreen is mutually exclusive for old YouTube and new continuous PCM capture', async () => {
  const h = harness(); await h.send({ type: 'OFFSCREEN_START', streamId: 'youtube' });
  assert.equal(h.streams[0].stopped, false);
  assert.equal((await h.send({ type: 'LIVE_OFFSCREEN_START', streamId: 'discord' })).ok, true);
  assert.equal(h.streams[0].stopped, true); assert.equal(h.streams[1].stopped, false); assert.equal(h.contexts[0].closed, true);
  assert.equal(h.contexts[1].connections[0], h.contexts[1].destination);
  await h.send({ type: 'OFFSCREEN_START', streamId: 'youtube-again' }); assert.equal(h.streams[1].stopped, true); assert.equal(h.streams[2].stopped, false);
  await h.send({ type: 'OFFSCREEN_STOP' });
});
test('PCM capture sends complete independent WAVs without waiting for server recognition', async () => {
  const h = harness(); await h.send({ type: 'LIVE_OFFSCREEN_START', streamId: 'discord' });
  for (let i = 0; i < 3; i++) h.emitSegment(i); await settle();
  const clips = h.messages.filter(message => message.type === 'LIVE_CAPTURED'); assert.equal(clips.length, 3);
  for (const clip of clips) { assert.equal(Buffer.from(clip.base64, 'base64').subarray(0, 4).toString(), 'RIFF'); assert.equal('token' in clip, false); assert.equal(clip.end - clip.start, 3); }
  for (const request of h.media) { assert.equal(request.video, false); assert.equal(request.audio.mandatory.chromeMediaSource, 'tab'); }
  await h.send({ type: 'LIVE_OFFSCREEN_STOP' }); assert.equal(h.streams[0].stopped, true); assert.equal(h.intervals.size, 0);
});
test('watchdog, server stop and track-ended all close continuous capture and cannot auto-resume', async () => {
  for (const mode of ['watchdog', 'server', 'ended']) {
    const h = harness(); await h.send({ type: 'LIVE_OFFSCREEN_START', streamId: 'discord' });
    if (mode === 'watchdog') await h.heartbeat(7000);
    if (mode === 'server') { h.serverStops(); await h.heartbeat(); }
    if (mode === 'ended') { h.streams[0].ended(); await settle(); }
    assert.equal(h.streams[0].stopped, true, mode); assert.equal(h.intervals.size, 0); assert.equal(h.contexts[0].closed, true);
    h.emitSegment(); await settle(); assert.equal(h.messages.some(message => message.type === 'LIVE_CAPTURED'), false);
  }
});
test('offscreen ignores popup/site injection attempts and unknown message namespaces', async () => {
  const h = harness();
  for (const sender of [{ id: 'ext', url: 'https://discord.com/channels/123456789012345678/234567890123456789', tab: { id: 7 } }, { id: 'ext', url: 'chrome-extension://ext/popup.html' }, { id: 'other' }]) await h.send({ type: 'LIVE_OFFSCREEN_START', streamId: 'stolen' }, sender);
  assert.equal(h.media.length, 0); assert.equal((await h.send({ type: 'RANDOM' })).ignored, true);
});
