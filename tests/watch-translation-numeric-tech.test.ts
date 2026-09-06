import test from 'node:test';
import assert from 'node:assert/strict';
import { localCueOutputTokens, requestLocalCue, untranslatedLocalWords } from '../lib/watch/local-cue-translator';
import { requestLocalTranslation } from '../lib/watch/local-translator';
import { translateWatchWindow } from '../lib/watch/translator';
import { watchProviderInfo } from '../lib/watch/provider';
import { WatchService } from '../lib/watch/service';
import { WatchStore } from '../lib/watch/store';
import type { Glossary } from '../lib/glossary-defaults';
import type { WatchCue, WatchSource } from '../lib/watch/types';

const glossary: Glossary = { no_translate_terms: [], term_map: [], style_rules: [] };
// Public source cue 228: its 3D was formerly excluded from the grammar while Drew
// remained allowed, producing the observed 3Drew loop until 6000 output tokens.
const cue: WatchCue = { id: 'cue_441399ce4e8e1642dcf6', start: 1183.675, end: 1191.654,
  text: "Drew Brucker (19:43) very I'm glancing over this, but there's a lot in here, right? In painting, out painting, background removal, aware fill, 3D," };
const source: WatchSource = { videoId: 'N-tmQ_Can_o', title: 'Public podcast fixture', language: 'en', sourceKind: 'manual', trackId: 'numeric-tech-fixture', cues: [cue] };
const input = { source, targets: [cue], before: [], after: [], glossary };
// The fixture keeps its speaker timestamp: since v14 a dropped source number is itself a repair trigger.
const envelope = (text = 'Drew Brucker（19:43）這裡有很多功能，包含 3D。', extra = {}) => Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ text }) }, ...extra });
async function mockFetch(fetcher: typeof fetch, run: () => Promise<void>, mode = 'local') {
  const oldFetch = globalThis.fetch;
  const values = { WATCH_PROCESSING_MODE: mode, WATCH_LOCAL_MODEL: 'qwen2.5:7b' };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
    globalThis.fetch = fetcher;
    await run();
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
async function inspectGrammar(text: string, check: (pattern: RegExp) => void) {
  await mockFetch(async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).has('authorization'), false);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.format.required, ['text']);
    assert.equal(body.options.num_predict, localCueOutputTokens({ text }));
    assert.equal(body.options.temperature, 0);
    check(new RegExp(body.format.properties.text.pattern));
    return envelope();
  }, async () => { await requestLocalCue({ cue: { ...cue, text }, glossary, model: 'qwen2.5:7b', signal: new AbortController().signal }); });
}

test('actual 19:43 failure fixture permits complete 3D without broadening bare letters or ordinary English', async () => {
  await inspectGrammar(cue.text, pattern => {
    assert(pattern.test('Drew Brucker：這裡有很多功能，包含 3D。'));
    assert(!pattern.test('這裡有 D。')); assert(!pattern.test('這裡有 4K。'));
    assert(!pattern.test('這裡有 COVER。')); assert(!pattern.test('這裡有 ADJUST。'));
    assert(!pattern.test('文字"跳出')); assert(!pattern.test('文字\\跳出')); assert(!pattern.test('文字\n跳出'));
  });
  assert.deepEqual(untranslatedLocalWords('Drew Brucker：這裡有 3D。', cue, glossary), []);
  assert.deepEqual(untranslatedLocalWords('這裡有 3Drew Brucker。', cue, glossary), ['drew']);
});

test('numeric technical literals are source-gated whole terms with narrow canonical casing', async () => {
  const text = 'we use 2d, 3d, 4D, 4k, 8K, 1080P and 2160p.';
  await inspectGrammar(text, pattern => {
    assert(pattern.test('使用 2D、3D、4D、4K、8K、1080p 和 2160p。'));
    assert(pattern.test('使用 2d 和 4k。'));
    assert(!pattern.test('使用 16K。')); assert(!pattern.test('使用 D 或 K。'));
    assert(!pattern.test('使用 3Dream。')); assert(!pattern.test('使用 anything。'));
  });
  assert.deepEqual(untranslatedLocalWords('使用 2D、3D、4D、4K、8K、1080p 和 2160p。', { ...cue, text }, glossary), []);
  await inspectGrammar('we show images, 13D, foo3D, 4Kapture, 3D_thing and x1080p.', pattern => {
    for (const term of ['2D', '3D', '4D', '4K', '8K', '1080p']) assert(!pattern.test(`使用 ${term}。`), term);
  });
});

test('subtitle output ceiling scales with source codepoints, stays bounded, and does not ask for a summary', () => {
  assert.equal(localCueOutputTokens({ text: 'Hi.' }), 512);
  assert.equal(localCueOutputTokens({ text: 'x'.repeat(300) }), 1156);
  assert.equal(localCueOutputTokens({ text: '😀'.repeat(300) }), 1156);
  assert.equal(localCueOutputTokens({ text: 'x'.repeat(4000) }), 4096);
  assert(localCueOutputTokens(cue) < 1000);
});

test('shared transport retains 6000 default and only explicit server cap changes num_predict', async () => {
  const seen: number[] = [];
  const request = { model: 'qwen2.5:7b', messages: [{ role: 'user' as const, content: 'test data' }], schema: { type: 'object' } };
  await mockFetch(async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(init?.body)); seen.push(body.options.num_predict);
    assert.equal(body.options.temperature, 0.2); assert.equal(body.options.num_ctx, 8192); assert.equal(body.keep_alive, '5m');
    return envelope();
  }, async () => {
    await requestLocalTranslation(request);
    await requestLocalTranslation({ ...request, maxOutputTokens: 777 });
    for (const limit of [0, -1, 1.5, 6001, NaN, Infinity]) await assert.rejects(requestLocalTranslation({ ...request, maxOutputTokens: limit }), { code: 'LOCAL_MODEL_INVALID_LIMIT' });
    assert.deepEqual(seen, [6000, 777]);
  });
});

test('provider-confirmed length never salvages valid-looking JSON or the reproduced repeated 3Drew prefix', async () => {
  const request = { model: 'qwen2.5:7b', messages: [], schema: { type: 'object' } };
  for (const content of [JSON.stringify({ text: '已完成的樣子。' }), '{"text":"' + '填充、3Drew Brucker'.repeat(500)]) {
    await mockFetch(async () => envelope('', { done_reason: 'length', message: { content } }), async () => {
      await assert.rejects(requestLocalTranslation(request), { code: 'LOCAL_TRANSLATION_TRUNCATED', status: 502 });
    });
  }
  // Incomplete streams or explicit provider errors are not mislabeled content failures.
  for (const extra of [{ done: false, done_reason: 'length' }, { error: 'private-provider-error', done_reason: 'length' }, { done_reason: 'unexpected' }]) {
    await mockFetch(async () => envelope('', extra), async () => {
      await assert.rejects(requestLocalTranslation(request), { code: 'LOCAL_MODEL_FAILED', status: 502 });
    });
  }
});

test('service reports a safe failed cue for truncated output, writes no successful cue, and manual retry can succeed', async () => {
  const store = new WatchStore(':memory:'); let recovered = false, writes = 0, calls = 0;
  const originalPut = store.put.bind(store);
  store.put = (key, cues) => { writes++; originalPut(key, cues); };
  await mockFetch(async () => { calls++; return recovered ? envelope() : envelope('填充、3Drew Brucker', { done_reason: 'length' }); }, async () => {
    const service = new WatchService({ store, provider: watchProviderInfo, source: async () => source, translate: translateWatchWindow, glossary: () => glossary, enabled: () => true, limits: () => ({ sessionCalls: null, dailyCalls: null }) });
    try {
      const session = await service.start('https://youtu.be/N-tmQ_Can_o');
      const partial = await service.window(session.sessionId, cue.start, true);
      assert.equal(partial.complete, false); assert.equal(partial.cached, false); assert.deepEqual(partial.cues, []);
      assert.equal(partial.failedCues?.length, 1);
      const failed = partial.failedCues![0];
      assert.equal(failed.id, cue.id); assert.equal(failed.start, cue.start); assert.equal(failed.end, cue.end);
      assert.equal(failed.code, 'LOCAL_TRANSLATION_QUALITY');
      assert.doesNotMatch(failed.message, /Drew|Brucker|填充|glancing|cue_441/);
      assert.equal(calls, 1); assert.equal(writes, 0);
      recovered = true;
      const result = await service.window(session.sessionId, cue.start, true);
      assert.equal(result.cached, false); assert.equal(result.complete, true); assert.deepEqual(result.failedCues, []);
      assert.equal(writes, 2, 'one validated cue cache and one complete window cache');
      assert.equal(result.cues[0].originalText, cue.text); assert.equal(result.cues[0].start, cue.start); assert.equal(result.cues[0].end, cue.end);
      assert.equal((await service.window(session.sessionId, cue.start, true)).cached, true); assert.equal(calls, 2);
      service.stop(session.sessionId);
    } finally { store.close(); }
  });
});

test('cancel takes precedence over length and no later cue starts', async () => {
  const controller = new AbortController(); let calls = 0;
  await mockFetch(async () => { calls++; controller.abort(); return envelope('', { done_reason: 'length' }); }, async () => {
    await assert.rejects(translateWatchWindow({ ...input, signal: controller.signal }), { code: 'CANCELLED', status: 499 });
    assert.equal(calls, 1);
  });
});

test('explicit cloud still uses one bulk call and 6000 tokens; cloud length remains MODEL_FAILED', async () => {
  const previous = process.env.OPENAI_API_KEY;
  try {
    process.env.OPENAI_API_KEY = 'unit-test-placeholder-not-a-real-key';
    let calls = 0, truncated = false;
    await mockFetch(async (url, init) => {
      calls++; assert.equal(url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer unit-test-placeholder-not-a-real-key');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'gpt-4o-mini'); assert.equal(body.max_tokens, 6000);
      assert.equal(body.temperature, 0.2); assert.equal(body.options, undefined);
      assert.deepEqual(body.response_format.json_schema.schema.required, ['cues']);
      return Response.json({ choices: [{ finish_reason: truncated ? 'length' : 'stop', message: { content: JSON.stringify({ cues: [{ id: cue.id, text: '這裡有很多功能，包含 3D。' }] }) } }] });
    }, async () => {
      const result = await translateWatchWindow(input);
      assert.equal(result[0].originalText, cue.text); assert.equal(calls, 1);
      truncated = true;
      await assert.rejects(translateWatchWindow(input), { code: 'MODEL_FAILED' }); assert.equal(calls, 2);
    }, 'cloud');
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; }
});
