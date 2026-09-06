/* eslint-disable @typescript-eslint/no-require-imports -- Synthetic PCM only, no live audio. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../live-core.js');
function worklet(rate = 16000) {
  let Processor; const messages = [];
  class AudioWorkletProcessor { constructor() { this.port = { postMessage(message) { messages.push(message); } }; } }
  const context = vm.createContext({ URL, Float32Array, AudioWorkletProcessor, sampleRate: rate, registerProcessor(name, type) { assert.equal(name, 'live-pcm-segmenter'); Processor = type; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../live-core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../live-worklet.js'), 'utf8').replace("import './live-core.js';", ''), context);
  const node = new Processor();
  return { node, messages, feed(seconds, amplitude = 0.1, quantum = 128) {
    let left = Math.round(rate * seconds);
    while (left) { const count = Math.min(left, quantum); node.process([[new Float32Array(count).fill(amplitude), new Float32Array(count).fill(amplitude)]]); left -= count; }
  } };
}
test('Discord source allowlist never accepts chat API, embeds, tokens or other origins', () => {
  assert.equal(core.discordUrl('https://discord.com/channels/@me/123456789012345678'), 'https://discord.com/channels/@me/123456789012345678');
  for (const url of ['https://discord.com/api/channels/123', 'https://discord.com/channels/1', 'https://discord.com/channels/1/2?token=x', 'https://discord.com.evil/channels/1/2', 'https://user@discord.com/channels/1/2', 'https://discord.com/channels/1/2#x', 'http://discord.com/channels/1/2', 'https://canary.discord.com/channels/1/2']) assert.equal(core.discordUrl(url), null);
  assert.equal(core.ready({ processingMode: 'cloud', audioConfigured: true, translationReady: true }), false);
});
test('actual worklet synthetic PCM remains continuous through 8-second hard cuts and recognition-independent events', () => {
  const h = worklet(); h.feed(19); h.feed(1, 0);
  const segments = h.messages.filter(message => message.type === 'segment');
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map(segment => segment.sequence), [0, 1, 2]);
  assert.equal(segments[0].startSample, 0); assert.equal(segments[0].endSample, 128000);
  for (let i = 0; i < segments.length; i++) {
    assert.equal(segments[i].samples.length, segments[i].endSample - segments[i].startSample);
    assert.ok(segments[i].samples.length <= 128000);
    if (i) assert.equal(segments[i].startSample, segments[i - 1].endSample);
  }
  h.node.port.onmessage({ data: 'clock' });
  assert.equal(h.messages.at(-1).samples, 320000);
});
test('energy pause segmentation retains 0.3 seconds pre-roll and marks only skipped silence', () => {
  const h = worklet(); h.feed(2, 0, 160); h.feed(3, 0.1, 160); h.feed(1, 0, 160);
  const segment = h.messages.find(message => message.type === 'segment');
  assert.equal(segment.startSample, 1.7 * 16000); assert.equal(segment.endSample, 5.6 * 16000);
  assert.equal(segment.gapReason, 'silence'); assert.ok(segment.samples.slice(0, 4800).every(value => value === 0));
  const count = h.messages.length; h.feed(3, 0); assert.equal(h.messages.length, count);
  h.node.port.onmessage({ data: 'stop' }); assert.equal(h.node.process([[new Float32Array(128)]]), false);
});
test('complete WAV is mono PCM16 with its own header, exact rate and bounded byte length', () => {
  const pcm = new Float32Array([0, 1, -1, 0.5]); const bytes = core.wav(pcm, 48000); const view = new DataView(bytes.buffer);
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), 'RIFF'); assert.equal(Buffer.from(bytes.subarray(8, 12)).toString(), 'WAVE');
  assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint16(34, true), 16); assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getInt16(46, true), 32767); assert.equal(view.getInt16(48, true), -32768); assert.equal(bytes.length, 52);
  assert.throws(() => core.wav(new Float32Array(128001), 16000));
});
