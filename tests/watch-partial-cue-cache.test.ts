import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WatchService } from '../lib/watch/service';
import { WatchStore, translationMatchesSource } from '../lib/watch/store';
import { WatchError } from '../lib/watch/errors';
import { TRANSLATION_VERSION } from '../lib/watch/translator';
import { withVideoTermbase } from '../lib/watch/termbase';
import type { Glossary } from '../lib/glossary-defaults';
import type { WatchCue, WatchSource, TranslatedCue, WatchProviderInfo } from '../lib/watch/types';

const source: WatchSource = {
  videoId: 'N-tmQ_Can_o', title: 'Public test source', language: 'en', sourceKind: 'manual', trackId: 'partial-test',
  cues: Array.from({ length: 18 }, (_, i) => ({ id: `cue-${i}`, start: i * 3, end: i * 3 + 2, text: `Keep OpenArt for step ${i}.` })),
};
const glossary: Glossary = { no_translate_terms: ['OpenArt'], term_map: [], style_rules: [] };
const local: WatchProviderInfo = { processingMode: 'local', unlimited: true, translationModel: 'qwen2.5:7b', translationConfigured: true, audioConfigured: false };
const cloud: WatchProviderInfo = { ...local, processingMode: 'cloud', unlimited: false, translationModel: 'cloud-test-model' };
const translated = (cue: WatchCue): TranslatedCue => ({ ...cue, originalText: cue.text, text: `保留 OpenArt，這是步驟 ${cue.id}。` });
const failQuality = () => new WatchError('LOCAL_TRANSLATION_QUALITY', 'PRIVATE MODEL PAYLOAD MUST NOT LEAK', 502);
type Translate = ConstructorParameters<typeof WatchService>[0]['translate'];
function setup(store: WatchStore, translate: Translate, options: {
  provider?: () => WatchProviderInfo; source?: WatchSource; glossary?: Glossary; sessionCalls?: number; dailyCalls?: number;
} = {}) {
  return new WatchService({ store, translate, provider: options.provider || (() => local),
    source: async () => structuredClone(options.source || source), glossary: () => options.glossary || glossary,
    enabled: () => true, limits: () => ({ sessionCalls: options.sessionCalls ?? 25, dailyCalls: options.dailyCalls ?? 100 }),
  });
}
const start = (service: WatchService) => service.start('https://youtu.be/N-tmQ_Can_o');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function prefix(inputSource = source, inputGlossary = glossary, provider = local, version = TRANSLATION_VERSION, schema: string | null = 'validated-source-cue-v1') {
  return hash({ video: inputSource.videoId, track: inputSource.trackId, source: inputSource.cues, target: 'zh-TW',
    glossaryVersion: hash(withVideoTermbase(structuredClone(inputGlossary))), provider: provider.processingMode,
    model: provider.translationModel, version, ...(schema === null ? {} : { cueCacheSchema: schema }) });
}

test('one quality failure preserves seven validated cues; manual retry only translates the missing cue', async t => {
  const store = new WatchStore(':memory:'); t.after(() => store.close());
  let recovered = false; const calls: string[] = [], signals: AbortSignal[] = [], writes: string[] = [];
  const put = store.put.bind(store); store.put = (key, cues) => { writes.push(key); put(key, cues); };
  const service = setup(store, async ({ targets, signal }) => {
    assert.equal(targets.length, 1); calls.push(targets[0].id); signals.push(signal!);
    if (!recovered && targets[0].id === 'cue-3') throw failQuality();
    return targets.map(translated);
  });
  const session = await start(service);
  assert.deepEqual(session.cachedCues, []); assert.equal(calls.length, 0);
  const result = await service.window(session.sessionId, 0, true);
  assert.equal(result.complete, false); assert.equal(result.cached, false);
  assert.equal(result.cues.length, 7); assert.equal(result.failedCues?.length, 1);
  assert.deepEqual(calls, source.cues.slice(0, 8).map(cue => cue.id));
  assert(signals.every(signal => signal === signals[0]), 'one shared deadline/cancellation signal for all eight calls');
  const failed = result.failedCues![0];
  assert.equal(failed.id, 'cue-3'); assert.equal(failed.start, 9); assert.equal(failed.end, 11);
  assert.equal(failed.code, 'LOCAL_TRANSLATION_QUALITY'); assert.doesNotMatch(failed.message, /PRIVATE|PAYLOAD|OpenArt/);
  assert.deepEqual(new Set([...result.cues, ...result.failedCues!].map(cue => cue.id)), new Set(calls));
  assert(!result.cues.some(cue => cue.id === failed.id));
  assert.equal(writes.length, 7); assert(writes.every(key => key.includes(':cue:')));
  assert.equal(store.get(`${prefix()}:0`), undefined, 'a partial window is never a successful window cache');
  assert.equal(result.callsUsed, 1); assert.equal(store.used('local'), 1); assert.equal(store.used('cloud'), 0);

  recovered = true;
  const retry = await service.window(session.sessionId, 0, true);
  assert.equal(retry.complete, true); assert.deepEqual(retry.failedCues, []);
  assert.deepEqual(retry.cues.map(cue => cue.id), source.cues.slice(0, 8).map(cue => cue.id));
  assert.deepEqual(calls.slice(8), ['cue-3']); assert.equal(retry.callsUsed, 2);
  assert.equal(writes.length, 9, 'seven earlier cues + recovered cue + only then complete window');
  const hit = await service.window(session.sessionId, 0, true);
  assert.equal(hit.cached, true); assert.equal(hit.complete, true); assert.equal(calls.length, 9);
  assert.equal(store.used('local'), 2, 'reading cache does not reserve another batch');
});

test('all quality failures produce explicit empty partial data, never original-text fallback or success cache', async t => {
  const store = new WatchStore(':memory:'); t.after(() => store.close()); let calls = 0, writes = 0;
  const put = store.put.bind(store); store.put = (key, cues) => { writes++; put(key, cues); };
  const service = setup(store, async () => { calls++; throw failQuality(); });
  const session = await start(service); const result = await service.window(session.sessionId, 0, true);
  assert.equal(result.complete, false); assert.equal(result.cached, false); assert.deepEqual(result.cues, []);
  assert.equal(result.failedCues?.length, 8); assert.equal(calls, 8); assert.equal(writes, 0);
  assert.deepEqual((await start(service)).cachedCues, []);
});

test('reload reads validated partial cue cache without inference and resumes only missing work', async t => {
  const store = new WatchStore(':memory:'); t.after(() => store.close()); let calls = 0;
  const firstService = setup(store, async ({ targets }) => { calls++; if (targets[0].id === 'cue-2') throw failQuality(); return targets.map(translated); });
  const first = await start(firstService); await firstService.window(first.sessionId, 0, true); firstService.stop(first.sessionId);
  const secondService = setup(store, async ({ targets }) => { calls++; return targets.map(translated); });
  const second = await start(secondService);
  assert.equal(second.cachedCues?.length, 7); assert.equal(calls, 8, 'start cache hydration is read-only');
  assert(second.cachedCues?.every(cue => translationMatchesSource(cue, source.cues.find(item => item.id === cue.id)!)));
  const result = await secondService.window(second.sessionId, 0, true);
  assert.equal(result.complete, true); assert.equal(calls, 9); assert.equal(result.cues.length, 8);
  const third = await start(secondService); assert.equal(third.cachedCues?.length, 8); assert.equal(calls, 9);
});

test('other windows and the short final batch continue after a partial batch without silently retrying its failure', async t => {
  const store = new WatchStore(':memory:'); t.after(() => store.close()); const calls: string[] = [];
  const service = setup(store, async ({ targets }) => { calls.push(targets[0].id); if (targets[0].id === 'cue-3') throw failQuality(); return targets.map(translated); });
  const session = await start(service);
  assert.equal((await service.window(session.sessionId, 0, true)).complete, false);
  assert.equal((await service.window(session.sessionId, 24, true)).complete, true);
  const final = await service.window(session.sessionId, 48, true);
  assert.equal(final.complete, true); assert.equal(final.cues.length, 2); assert.deepEqual(final.failedCues, []);
  assert.equal(calls.length, 18); assert.equal(calls.filter(id => id === 'cue-3').length, 1);
  assert.equal((await start(service)).cachedCues?.length, 17);
});

test('transport, model, provider and generic errors remain fatal rather than being mislabeled cue-quality failures', async t => {
  for (const error of [new WatchError('LOCAL_MODEL_NOT_FOUND', 'unavailable', 503), new WatchError('LOCAL_MODEL_FAILED', 'transport', 502),
    new WatchError('SESSION_PROVIDER_CHANGED', 'changed', 409), new WatchError('MODEL_FAILED', 'unclassified', 502), new Error('unknown')]) {
    const store = new WatchStore(':memory:'); t.after(() => store.close()); let calls = 0;
    const service = setup(store, async ({ targets }) => { calls++; if (calls === 2) throw error; return targets.map(translated); });
    const session = await start(service);
    await assert.rejects(service.window(session.sessionId, 0, true), failure => failure === error);
    assert.equal(calls, 2); assert.equal((await start(service)).cachedCues?.length, 1);
    assert.equal(store.get(`${prefix()}:0`), undefined);
  }
});

test('abort keeps only cues validated before cancellation and rejects late results even if an adapter ignores its signal', async t => {
  const store = new WatchStore(':memory:'); t.after(() => store.close()); const gate = deferred(); let calls = 0;
  const service = setup(store, async ({ targets }) => { calls++; if (calls === 2) await gate.promise; return targets.map(translated); });
  const session = await start(service); const controller = new AbortController();
  const work = service.window(session.sessionId, 0, true, controller.signal); const checked = assert.rejects(work, { code: 'CANCELLED' });
  await tick(); assert.equal(calls, 2); controller.abort(); gate.resolve(); await checked;
  const reload = await start(service);
  assert.deepEqual(reload.cachedCues?.map(cue => cue.id), ['cue-0']); assert.equal(calls, 2);
  assert.equal(store.get(`${prefix()}:0`), undefined);
});

test('stop is final and provider changes during inference cannot commit late cue data', async t => {
  for (const change of ['stop', 'provider'] as const) {
    const store = new WatchStore(':memory:'); t.after(() => store.close()); const gate = deferred(); let provider = { ...local }, calls = 0;
    const service = setup(store, async ({ targets }) => { calls++; await gate.promise; return targets.map(translated); }, { provider: () => provider });
    const session = await start(service); const work = service.window(session.sessionId, 0, true);
    const checked = assert.rejects(work, { code: change === 'stop' ? 'CANCELLED' : 'SESSION_PROVIDER_CHANGED' });
    if (change === 'stop') service.stop(session.sessionId); else provider = { ...provider, translationModel: 'qwen2.5:14b' };
    gate.resolve(); await checked; assert.equal(calls, 1);
    assert.equal(store.getCue(`${prefix()}:cue:cue-0`, source.cues[0]), undefined);
    if (change === 'stop') await assert.rejects(service.window(session.sessionId, 0, true), { code: 'SESSION_EXPIRED' });
  }
});

test('one 90-second batch deadline is shared across cue calls and timeout is not converted to partial success', async t => {
  const store = new WatchStore(':memory:'); t.after(() => store.close());
  const savedTimeout = AbortSignal.timeout, deadline = new AbortController(); let calls = 0, deadlines = 0;
  AbortSignal.timeout = (ms: number) => { assert.equal(ms, 90_000); deadlines++; return deadline.signal; };
  try {
    const service = setup(store, async ({ targets }) => { calls++; if (calls === 2) deadline.abort(); return targets.map(translated); });
    const session = await start(service);
    await assert.rejects(service.window(session.sessionId, 0, true), { code: 'LOCAL_MODEL_TIMEOUT', status: 504 });
    assert.equal(deadlines, 1); assert.equal(calls, 2);
    assert.deepEqual((await start(service)).cachedCues?.map(cue => cue.id), ['cue-0']);
  } finally { AbortSignal.timeout = savedTimeout; }
});

test('same-window singleflight shares work; cancelled superseded work cannot populate a cue cache later', async t => {
  const store = new WatchStore(':memory:'); t.after(() => store.close()); const gate = deferred(); const calls: string[] = [];
  const service = setup(store, async ({ targets }) => { calls.push(targets[0].id); if (targets[0].id === 'cue-0') await gate.promise; return targets.map(translated); });
  const session = await start(service);
  const a = service.window(session.sessionId, 0, true), b = service.window(session.sessionId, 1, true);
  const checks = [assert.rejects(a, { code: 'CANCELLED' }), assert.rejects(b, { code: 'CANCELLED' })];
  assert.deepEqual(calls, ['cue-0']);
  const other = await service.window(session.sessionId, 24, true);
  assert.equal(other.complete, true); gate.resolve(); await Promise.all(checks);
  assert.equal(calls.filter(id => id === 'cue-0').length, 1);
  const reload = await start(service); assert.equal(reload.cachedCues?.length, 8);
  assert(reload.cachedCues?.every(cue => Number(cue.id.split('-')[1]) >= 8));
});

test('cache keys isolate source, track, glossary, model, provider, translation version and local cue schema', async t => {
  const store = new WatchStore(':memory:'); t.after(() => store.close()); let calls = 0;
  const translate: Translate = async ({ targets }) => { calls++; return targets.map(translated); };
  const initial = setup(store, translate), initialSession = await start(initial); await initial.window(initialSession.sessionId, 0, true);
  const cached = await start(setup(store, translate)); assert.equal(cached.cachedCues?.length, 8); assert.equal(calls, 8);
  for (const options of [
    { source: { ...source, trackId: 'other-track' } },
    { source: { ...source, cues: source.cues.map((cue, i) => i ? cue : { ...cue, text: 'A different source statement.' }) } },
    { glossary: { ...glossary, style_rules: ['new style'] } },
    { provider: () => ({ ...local, translationModel: 'qwen2.5:14b' }) },
  ]) assert.deepEqual((await start(setup(store, translate, options))).cachedCues, []);
  const cloudSession = await start(setup(store, translate, { provider: () => cloud }));
  assert.equal('cachedCues' in cloudSession, false); assert.equal(calls, 8);

  const cleanStore = new WatchStore(':memory:'); t.after(() => cleanStore.close());
  for (const oldPrefix of [prefix(source, glossary, local, 'older-translation-version'), prefix(source, glossary, local, TRANSLATION_VERSION, 'older-schema'), prefix(source, glossary, local, TRANSLATION_VERSION, null)]) {
    cleanStore.put(`${oldPrefix}:cue:cue-0`, [translated(source.cues[0])]);
    cleanStore.put(`${oldPrefix}:0`, source.cues.slice(0, 8).map(translated));
  }
  assert.deepEqual((await start(setup(cleanStore, translate))).cachedCues, []);
});

test('malformed cached metadata and malformed translator payloads cannot be consumed as valid local cues', async t => {
  const good = translated(source.cues[0]);
  for (const bad of [{ ...good, id: 'forged' }, { ...good, start: 100 }, { ...good, end: 200 }, { ...good, originalText: 'wrong source' },
    { ...good, text: '' }, { ...good, text: '第一行\n第二行' }, { ...good, extra: true }]) {
    const store = new WatchStore(':memory:'); t.after(() => store.close());
    store.put(`${prefix()}:cue:cue-0`, [bad]);
    assert.equal(store.getCue(`${prefix()}:cue:cue-0`, source.cues[0]), undefined);
    assert.deepEqual((await start(setup(store, async () => { throw new Error('no inference'); }))).cachedCues, []);
    const service = setup(store, async () => [bad]), session = await start(service);
    await assert.rejects(service.window(session.sessionId, 0, true), { code: 'INVALID_TRANSLATION' });
    assert.equal(store.get(`${prefix()}:0`), undefined);
  }
});

test('cloud remains all-or-nothing: one eight-cue call, unchanged response fields and failed attempts retain quota', async t => {
  const store = new WatchStore(':memory:'); t.after(() => store.close()); let calls = 0;
  const service = setup(store, async ({ targets }) => { calls++; assert.equal(targets.length, 8); if (calls === 1) throw failQuality(); return targets.map(translated); },
    { provider: () => cloud, sessionCalls: 2, dailyCalls: 2 });
  const session = await start(service); assert.equal('cachedCues' in session, false);
  await assert.rejects(service.window(session.sessionId, 0, true), { code: 'LOCAL_TRANSLATION_QUALITY' });
  assert.equal(store.used('cloud'), 1); assert.equal(store.used('local'), 0);
  const success = await service.window(session.sessionId, 0, true);
  assert.equal(success.cues.length, 8); assert.equal(success.callsUsed, 2); assert.equal(calls, 2);
  assert.equal('complete' in success, false); assert.equal('failedCues' in success, false);
  assert.equal((await service.window(session.sessionId, 0, true)).cached, true);
  await assert.rejects(service.window(session.sessionId, 24, true), { code: 'SESSION_LIMIT' });
  assert.equal(calls, 2); assert.equal(store.used('cloud'), 2);
  assert.ok(store.get(`${prefix(source, glossary, cloud, TRANSLATION_VERSION, null)}:0`), 'the cloud cache key layout stays unchanged');
});
