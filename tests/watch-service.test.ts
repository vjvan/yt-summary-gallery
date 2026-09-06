import test from 'node:test';
import assert from 'node:assert/strict';
import { WatchService } from '../lib/watch/service';
import { WatchStore } from '../lib/watch/store';
import type { WatchSource, WatchProviderInfo } from '../lib/watch/types';
import type { Glossary } from '../lib/glossary-defaults';

const source: WatchSource = { videoId: 'kfbWz9_bJoA', title: 'Weave fixture', language: 'en', sourceKind: 'manual', trackId: 'en-original', cues: Array.from({length: 20}, (_, i) => ({ id: `cue-${i}`, start: i*4, end: i*4+3, text: `The compositor node is ${i}.` })) };
const cloud: WatchProviderInfo = { processingMode: 'cloud', unlimited: false, translationModel: 'gpt-4o-mini', translationConfigured: true, audioConfigured: true };
const glossary: Glossary = { no_translate_terms: ['Weave'], term_map: [['compositor', '合成器']], style_rules: [] };
function setup(sessionCalls = 25, dailyCalls = 100) {
  const store = new WatchStore(':memory:');
  let calls = 0;
  let terms = structuredClone(glossary);
  const service = new WatchService({ provider: () => cloud, store, source: async () => source, translate: async ({ targets }) => { calls++; return targets.map(cue => ({...cue, text: `合成器 ${cue.id}`, originalText: cue.text})); }, glossary: () => terms, enabled: () => true, limits: () => ({sessionCalls, dailyCalls}) });
  return { store, service, calls: () => calls, changeTerms: () => { terms = {...terms, style_rules: ['自然台灣用語']}; } };
}
test('incremental windows preserve timing and cache across sessions without a second model call', async () => {
  const { service, store, calls } = setup();
  try {
    const session = await service.start('https://www.youtube.com/watch?v=kfbWz9_bJoA');
    await assert.rejects(service.window(session.sessionId, 0, false));
    assert.equal(calls(), 0);
    const first = await service.window(session.sessionId, 0, true);
    assert.equal(first.cues.length, 8);
    assert.equal(first.cues[0].start, 0);
    assert.equal(first.cached, false);
    const again = await service.window(session.sessionId, 10, true);
    assert.equal(again.cached, true);
    const next = await service.window(session.sessionId, 33, true);
    assert.equal(next.cues[0].id, 'cue-8');
    assert.equal(calls(), 2);
    const session2 = await service.start('https://youtu.be/kfbWz9_bJoA');
    assert.equal((await service.window(session2.sessionId, 0, true)).cached, true);
    assert.equal(calls(), 2);
    assert.deepEqual((await service.window(session2.sessionId, 500, true)).cues, []);
  } finally { store.close(); }
});
test('glossary snapshots are stable within session and invalidate new-session cache', async () => {
  const { service, store, calls, changeTerms } = setup();
  try {
    const a = await service.start('https://youtu.be/kfbWz9_bJoA');
    await service.window(a.sessionId, 0, true);
    changeTerms();
    assert.equal((await service.window(a.sessionId, 0, true)).cached, true);
    const b = await service.start('https://youtu.be/kfbWz9_bJoA');
    assert.notEqual(a.glossaryVersion, b.glossaryVersion);
    await service.window(b.sessionId, 0, true);
    assert.equal(calls(), 2);
  } finally { store.close(); }
});
test('session/day budgets prevent paid work but allow cache; stop is final', async () => {
  const { service, store, calls } = setup(1, 1);
  try {
    const a = await service.start('https://youtu.be/kfbWz9_bJoA');
    await service.window(a.sessionId, 0, true);
    await assert.rejects(service.window(a.sessionId, 33, true), { code: 'SESSION_LIMIT' });
    const b = await service.start('https://youtu.be/kfbWz9_bJoA');
    assert.equal((await service.window(b.sessionId, 0, true)).cached, true);
    await assert.rejects(service.window(b.sessionId, 33, true), { code: 'DAILY_LIMIT' });
    service.stop(a.sessionId);
    await assert.rejects(service.window(a.sessionId, 0, true), { code: 'SESSION_EXPIRED' });
    assert.equal(calls(), 1);
  } finally { store.close(); }
});
test('failed calls count toward budget and never poison cache', async () => {
  const store = new WatchStore(':memory:'); let calls = 0;
  const service = new WatchService({ provider: () => cloud,store, source: async () => source, translate: async () => { calls++; throw new Error('mock failure'); }, glossary: () => glossary, enabled: () => true, limits: () => ({sessionCalls: 1, dailyCalls: 2})});
  try {
    const a = await service.start('https://youtu.be/kfbWz9_bJoA');
    await assert.rejects(service.window(a.sessionId, 0, true));
    await assert.rejects(service.window(a.sessionId, 0, true), {code: 'SESSION_LIMIT'});
    assert.equal(calls, 1); assert.equal(store.used(), 1);
  } finally { store.close(); }
});

test('local sessions are unlimited, keep batches bounded and never consume cloud daily quota', async () => {
  const store = new WatchStore(':memory:'); let calls = 0;
  const local: WatchProviderInfo = { processingMode: 'local', unlimited: true, translationModel: 'qwen2.5:7b', translationConfigured: true, audioConfigured: false };
  const service = new WatchService({ store, provider: () => local, source: async () => source,
    translate: async ({ targets }) => { calls++; assert(targets.length <= 8); return targets.map(cue => ({ ...cue, originalText: cue.text, text: '本機譯文。' })); },
    glossary: () => glossary, enabled: () => true, limits: () => ({ sessionCalls: 1, dailyCalls: 1 }),
  });
  try {
    store.reserve(1); // Existing paid usage must neither block nor be charged for local work.
    const session = await service.start('https://youtu.be/kfbWz9_bJoA');
    assert.equal(session.processingMode, 'local'); assert.equal(session.unlimited, true);
    assert.deepEqual(session.limits, { sessionCalls: null, dailyCalls: null });
    for (const time of [0, 33, 65]) await service.window(session.sessionId, time, true);
    assert.equal(calls, 20, 'local translates each uncached cue, including the four-cue final window'); assert.equal(store.used(), 1); assert.equal(store.used('local'), 3);
    const cached = await service.window(session.sessionId, 0, true);
    assert.equal(cached.cached, true); assert.equal(cached.callsUsed, 3); assert.equal(cached.dailyCallsUsed, 3);
  } finally { store.close(); }
});

test('cache is isolated by provider/model and an existing session cannot silently change provider', async () => {
  const store = new WatchStore(':memory:'); let calls = 0; let provider = { ...cloud };
  const service = new WatchService({ store, provider: () => provider, source: async () => source,
    translate: async ({ targets }) => { calls++; return targets.map(cue => ({ ...cue, originalText: cue.text, text: '測試譯文。' })); },
    glossary: () => glossary, enabled: () => true, limits: () => ({ sessionCalls: 25, dailyCalls: 100 }),
  });
  try {
    const paid = await service.start('https://youtu.be/kfbWz9_bJoA');
    await service.window(paid.sessionId, 0, true); assert.equal(store.used(), 1);
    provider = { ...cloud, processingMode: 'local', unlimited: true, translationModel: 'qwen2.5:7b' };
    await assert.rejects(service.window(paid.sessionId, 0, true), { code: 'SESSION_PROVIDER_CHANGED' });
    const local = await service.start('https://youtu.be/kfbWz9_bJoA');
    assert.equal((await service.window(local.sessionId, 0, true)).cached, false);
    provider = { ...provider, translationModel: 'qwen2.5:14b' };
    const changed = await service.start('https://youtu.be/kfbWz9_bJoA');
    assert.equal((await service.window(changed.sessionId, 0, true)).cached, false);
    const same = await service.start('https://youtu.be/kfbWz9_bJoA');
    assert.equal((await service.window(same.sessionId, 0, true)).cached, true);
    assert.equal(calls, 17, 'one cloud batch plus eight local cues for each distinct local model'); assert.equal(store.used(), 1); assert.equal(store.used('local'), 2);
    assert.throws(() => store.reserve(null, 'cloud'), { code: 'INVALID_LIMIT' });
  } finally { store.close(); }
});

test('local failure remains uncached; local singleflight, global concurrency and stop cancellation stay enforced', async () => {
  const store = new WatchStore(':memory:'); let calls = 0;
  const local: WatchProviderInfo = { processingMode: 'local', unlimited: true, translationModel: 'qwen2.5:7b', translationConfigured: true, audioConfigured: false };
  const service = new WatchService({ store, provider: () => local, source: async () => source,
    translate: async ({ signal }) => { calls++; await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled fixture')), { once: true })); return []; },
    glossary: () => glossary, enabled: () => true, limits: () => ({ sessionCalls: null, dailyCalls: null }),
  });
  try {
    const a = await service.start('https://youtu.be/kfbWz9_bJoA'); const b = await service.start('https://youtu.be/kfbWz9_bJoA'); const c = await service.start('https://youtu.be/kfbWz9_bJoA');
    const first = service.window(a.sessionId, 0, true); const firstCheck = assert.rejects(first);
    const duplicate = service.window(a.sessionId, 0, true); const duplicateCheck = assert.rejects(duplicate);
    const second = service.window(b.sessionId, 33, true); const secondCheck = assert.rejects(second);
    await assert.rejects(service.window(c.sessionId, 65, true), { code: 'BUSY' }); assert.equal(calls, 2);
    service.stop(a.sessionId); service.stop(b.sessionId);
    await Promise.all([firstCheck, duplicateCheck, secondCheck]);
    assert.equal(store.used(), 0); assert.equal(store.used('local'), 2);
    await assert.rejects(service.window(a.sessionId, 0, true), { code: 'SESSION_EXPIRED' });
    const retry = service.window(c.sessionId, 0, true); const retryCheck = assert.rejects(retry);
    assert.equal(calls, 3, 'cancelled work must not have written a successful cache entry');
    service.stop(c.sessionId); await retryCheck;
  } finally { store.close(); }
});

test('local mode translates more than 100 total batches without either cloud budget gate', async () => {
  const store = new WatchStore(':memory:'); let calls = 0;
  const longSource = { ...source, cues: Array.from({ length: 8 * 105 }, (_, index) => ({ id: `long-${index}`, start: index * 2, end: index * 2 + 1, text: `Sentence ${index}.` })) };
  const local: WatchProviderInfo = { processingMode: 'local', unlimited: true, translationModel: 'qwen2.5:7b', translationConfigured: true, audioConfigured: false };
  const service = new WatchService({ store, provider: () => local, source: async () => longSource,
    translate: async ({ targets }) => { calls++; assert.equal(targets.length, 1); return targets.map(cue => ({ ...cue, originalText: cue.text, text: '測試譯文。' })); },
    glossary: () => glossary, enabled: () => true, limits: () => ({ sessionCalls: 1, dailyCalls: 1 }),
  });
  try {
    store.reserve(1, 'cloud');
    const session = await service.start('https://youtu.be/kfbWz9_bJoA');
    for (let batch = 0; batch < 105; batch++) await service.window(session.sessionId, batch * 16, true);
    assert.equal(calls, 105 * 8); assert.equal(store.used('local'), 105); assert.equal(store.used('cloud'), 1);
    assert.equal((await service.window(session.sessionId, 0, true)).cached, true);
  } finally { store.close(); }
});

test('session reports an unavailable local model and disables translation before consent', async () => {
  const store = new WatchStore(':memory:'); let calls = 0;
  const local: WatchProviderInfo = { processingMode: 'local', unlimited: true, translationModel: 'qwen2.5:7b', translationConfigured: true, audioConfigured: false };
  const service = new WatchService({ store, provider: () => local, status: async () => ({ ...local, translationReady: false, translationStatusMessage: '尚未啟動本機模型。' }), source: async () => source,
    translate: async () => { calls++; return []; }, glossary: () => glossary, enabled: () => true, limits: () => ({ sessionCalls: null, dailyCalls: null }),
  });
  try {
    const session = await service.start('https://youtu.be/kfbWz9_bJoA');
    assert.equal(session.translationConfigured, true); assert.equal(session.translationReady, false); assert.equal(session.translationEnabled, false);
    assert.equal(session.translationStatusMessage, '尚未啟動本機模型。'); assert.equal(calls, 0);
    await assert.rejects(service.window(session.sessionId, 0, true), { code: 'LOCAL_MODEL_UNAVAILABLE' }); assert.equal(calls, 0);
  } finally { store.close(); }
});
