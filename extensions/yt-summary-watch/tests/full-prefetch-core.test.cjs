/* eslint-disable @typescript-eslint/no-require-imports -- Pure classic-extension helpers; no browser/model calls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');
const cues = Array.from({ length: 19 }, (_, i) => ({ id: `cue${i}`, start: i * 4, end: i * 4 + 3.5, text: `Full source ${i}.` }));

test('full scheduling prioritizes the latest window then fills earlier holes through the short final window', () => {
  const ready = new Set(), failed = new Map();
  assert.deepEqual(core.fullRequest(cues, 65, ready, failed), { key: '2', time: 64 }); ready.add('2');
  assert.deepEqual(core.fullRequest(cues, 65, ready, failed), { key: '0', time: 0 }); ready.add('0');
  assert.deepEqual(core.fullRequest(cues, 65, ready, failed), { key: '1', time: 32 }); ready.add('1');
  assert.equal(core.fullRequest(cues, 65, ready, failed), null);
  for (let i = 0; i < 100; i++) assert.equal(core.fullRequest(cues, i, ready, failed), null);
});

test('a failed full window is never ready; only an explicit valid retry key can reselect it', () => {
  const ready = new Set(['1', '2']), failed = new Map([['0', 'quality']]);
  assert.equal(core.fullRequest(cues, 0, ready, failed), null);
  assert.deepEqual(core.fullRequest(cues, 0, ready, failed, '0'), { key: '0', time: 0 });
  for (const key of ['-1', '3', '000', 'NaN', '__proto__', 0]) assert.equal(core.fullRequest(cues, 0, ready, failed, key), null);
  assert.equal(ready.has('0'), false);
});

test('cue-ID progress counts cache and short batches precisely; failures are not completion', () => {
  const ready = new Map(cues.slice(0, 8).map(cue => [cue.id, cue]));
  ready.set(cues[18].id, cues[18]); ready.set('unrelated', {});
  const failed = new Map([[cues[16].id, 'quality'], ['unrelated-error', 'quality'], [cues[0].id, 'old error']]);
  assert.deepEqual(core.prefetchProgress(cues, ready, failed), { readyCues: 9, totalCues: 19, failedCues: 1, readyBatches: 1, totalBatches: 3, failedBatches: 1, complete: false, settled: false });
  for (const cue of cues) if (!ready.has(cue.id)) failed.set(cue.id, 'quality');
  const partial = core.prefetchProgress(cues, ready, failed); assert.equal(partial.complete, false); assert.equal(partial.settled, true); assert.equal(partial.failedCues, 10);
  for (const cue of cues) ready.set(cue.id, cue);
  const done = core.prefetchProgress(cues, ready, failed); assert.equal(done.readyCues, 19); assert.equal(done.failedCues, 0); assert.equal(done.readyBatches, 3); assert.equal(done.complete, true);
  assert.equal(core.prefetchProgress([], new Map(), new Map()).complete, false);
});

test('full preference defaults on but does not change disabled/consent/cloud authority', () => {
  const defaults = core.boundedSettings();
  assert.equal(defaults.localFullPrefetch, true); assert.equal(defaults.enabled, false); assert.equal(defaults.consent, false); assert.equal(defaults.consentMode, 'cloud');
  assert.equal(core.boundedSettings({ localFullPrefetch: false }).localFullPrefetch, false);
  assert.equal(core.translationLimit({ processingMode: 'cloud', unlimited: true }, 10), 10);
});

test('full bilingual SRT requires every cue, keeps real times and entire unpaged text', () => {
  const translated = new Map(cues.map(cue => [cue.id, { ...cue, text: `完整繁中 ${cue.id}。`.repeat(20), originalText: cue.text }]));
  const srt = core.bilingualSrt(cues, translated);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:03,500/);
  assert.match(srt, /19\n00:01:12,000 --> 00:01:15,500/);
  for (const cue of cues) { assert.ok(srt.includes(translated.get(cue.id).text)); assert.ok(srt.includes(cue.text)); }
  translated.delete(cues[18].id); assert.equal(core.bilingualSrt(cues, translated), null);
  assert.equal(core.bilingualSrt([], new Map()), null);
});
