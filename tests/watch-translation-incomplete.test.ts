import test from 'node:test';
import assert from 'node:assert/strict';
import { requestLocalTranslation } from '../lib/watch/local-translator';
import { translateWatchWindow, TRANSLATION_VERSION } from '../lib/watch/translator';
import { WatchService } from '../lib/watch/service';
import { WatchStore } from '../lib/watch/store';
import { watchProviderInfo } from '../lib/watch/provider';
import type { Glossary } from '../lib/glossary-defaults';
import type { WatchCue, WatchSource } from '../lib/watch/types';

const cue: WatchCue = { id: 'unfinished-public-fixture', start: 1052.666, end: 1057.425, text: 'Um, and more, maybe even more transparently than just sort of like taking gigs here and there, right?' };
const source: WatchSource = { videoId: '_Ldhm8qB_JU', title: 'Public interview fixture', language: 'en', sourceKind: 'manual', trackId: 'incomplete-fixture', cues: [cue] };
const glossary: Glossary = { no_translate_terms: ['Higgsfield'], term_map: [], style_rules: [] };
const input = { source, targets: [cue], before: [], after: [], glossary };
const unfinished = (extra = {}, status = 200) => Response.json({ done: false, message: { role: 'assistant', content: '{"text":"而且比接接接接接接' }, ...extra }, { status });
const complete = (text = '嗯，而且可能比東接西接零星案子更加透明，對吧？', extra = {}) => Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ text }) }, ...extra });
const transport = { model: 'qwen2.5:7b', messages: [], schema: { type: 'object' } };
async function withFetch(fetcher: typeof fetch, run: () => Promise<void>, mode = 'local') {
  const saved = { fetch: globalThis.fetch, mode: process.env.WATCH_PROCESSING_MODE, model: process.env.WATCH_LOCAL_MODEL };
  process.env.WATCH_PROCESSING_MODE = mode; process.env.WATCH_LOCAL_MODEL = 'qwen2.5:7b';
  globalThis.fetch = async (url, init) => {
    assert.equal(url, mode === 'local' ? 'http://127.0.0.1:11434/api/chat' : 'https://api.openai.com/v1/chat/completions');
    if (mode === 'local') { assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).has('authorization'), false); }
    return fetcher(url, init);
  };
  try { await run(); }
  finally { globalThis.fetch = saved.fetch; if (saved.mode === undefined) delete process.env.WATCH_PROCESSING_MODE; else process.env.WATCH_PROCESSING_MODE = saved.mode; if (saved.model === undefined) delete process.env.WATCH_LOCAL_MODEL; else process.env.WATCH_LOCAL_MODEL = saved.model; }
}

test('only observed unfinished HTTP 200 generation receives the incomplete-content classification', async () => {
  await withFetch(async () => unfinished(), async () => {
    await assert.rejects(requestLocalTranslation(transport), (error: unknown) => {
      assert(error instanceof Error); assert.equal((error as Error & { code: string }).code, 'LOCAL_TRANSLATION_INCOMPLETE');
      assert.doesNotMatch(error.message, /接接接|unfinished-public|Higgsfield/); return true;
    });
  });
  for (const response of [
    () => unfinished({ message: { content: '' } }), () => unfinished({ message: { content: '  ' } }),
    () => unfinished({ message: { content: null } }), () => unfinished({ done: undefined }),
    () => unfinished({ done_reason: 'length' }), () => unfinished({ done_reason: 'unexpected' }),
    () => unfinished({ error: 'private-provider-error' }), () => unfinished({}, 201),
    () => complete('', { message: { content: '' } }),
  ]) {
    await withFetch(async () => response(), async () => { await assert.rejects(requestLocalTranslation(transport), { code: 'LOCAL_MODEL_FAILED' }); });
  }
});

test('the reproduced incomplete generation gets exactly one JSON-only repair with the same output ceiling', async () => {
  let calls = 0; let firstTokens = 0;
  await withFetch(async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.format.required, ['text']); assert.equal(body.format.additionalProperties, false);
    if (calls === 1) { assert.equal(typeof body.format.properties.text.pattern, 'string'); firstTokens = body.options.num_predict; return unfinished(); }
    assert.equal(body.format.properties.text.pattern, undefined); assert.equal(body.options.num_predict, firstTokens);
    assert.equal(body.options.temperature, 0); assert.match(body.messages[0].content, /完整翻成自然台灣繁體中文/);
    assert.doesNotMatch(body.messages[0].content, /left ordinary English untranslated/);
    const data = JSON.parse(body.messages[1].content);
    assert.equal(data.text, cue.text); assert.deepEqual(Object.keys(data).sort(), ['required_names', 'source_numbers', 'text']);
    assert(body.messages[0].content.length < 500); assert.doesNotMatch(JSON.stringify(body.messages), /接接接|previous generation|style_rules|Fragment examples/);
    return complete();
  }, async () => {
    const [translated] = await translateWatchWindow(input);
    assert.equal(calls, 2); assert.equal(translated.originalText, cue.text);
    assert.equal(translated.start, cue.start); assert.equal(translated.end, cue.end);
    assert.equal(TRANSLATION_VERSION, 'watch-zh-TW-v14-taiwan-register-speaker-names');
  });
});

test('JSON-only recovery cannot spend a third call or bypass JSON, language, name or source-number checks', async () => {
  const named = { ...cue, text: 'Do not use Higgsfield 2.' };
  for (const response of [
    () => unfinished(), () => complete('沒有品牌 2。'), () => complete('不要用 Higgsfield。'),
    () => complete('不要用 Higgsfield 2，改用版本 3。'),
    () => complete('Do not use Higgsfield 2.'), () => complete('不要用 Higgsfield 2 maybe。'),
    () => complete('不要用 Higgsfield 2「maybe」。'), () => complete('不要用 Higgsfield 2 "maybe"。'),
    () => complete('', { message: { content: '{"text":"未完成' } }),
    () => complete('不要用 Higgsfield 2。', { done_reason: 'length' }),
  ]) {
    let calls = 0;
    await withFetch(async () => { calls++; return calls === 1 ? unfinished() : response(); }, async () => {
      await assert.rejects(translateWatchWindow({ ...input, source: { ...source, cues: [named] }, targets: [named] }), { code: 'LOCAL_TRANSLATION_QUALITY' }); assert.equal(calls, 2);
    });
  }
});

test('an incomplete repair cannot collapse repeated protected names, with no extra attempt', async () => {
  const repeated = { ...cue, text: 'Do not use Higgsfield; maybe Higgsfield.' }; let calls = 0;
  await withFetch(async () => { calls++; return calls === 1 ? unfinished() : complete('不要用 Higgsfield，也許吧。'); }, async () => {
    await assert.rejects(translateWatchWindow({ ...input, source: { ...source, cues: [repeated] }, targets: [repeated] }), { code: 'LOCAL_TRANSLATION_QUALITY' }); assert.equal(calls, 2);
  });
});

test('eight incomplete cues use at most sixteen sequential calls', async () => {
  const cues = Array.from({ length: 8 }, (_, i) => ({ ...cue, id: `incomplete-${i}`, start: i * 5, end: i * 5 + 4 }));
  let calls = 0, active = 0, peak = 0;
  await withFetch(async () => { active++; peak = Math.max(peak, active); calls++; await new Promise<void>(resolve => setImmediate(resolve)); active--; return calls % 2 ? unfinished() : complete(); }, async () => {
    assert.equal((await translateWatchWindow({ ...input, source: { ...source, cues }, targets: cues })).length, 8);
    assert.equal(calls, 16); assert.equal(peak, 1);
  });
});

test('service retains six successes, isolates the seventh unfinished cue, finishes the eighth and accepts later batches', async () => {
  const cues = Array.from({ length: 16 }, (_, i) => ({ ...cue, id: `service-${i}`, start: i * 5, end: i * 5 + 4, text: `Use the layer for step ${i}.` }));
  const store = new WatchStore(':memory:'); const inferred: string[] = []; let recovered = false;
  await withFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), text = JSON.parse(body.messages[1].content).text;
    inferred.push(text); return text === cues[6].text && !recovered ? unfinished() : complete(`使用圖層執行第 ${text.match(/\d+/)[0]} 步。`);
  }, async () => {
    const service = new WatchService({ store, provider: watchProviderInfo, source: async () => ({ ...source, cues }), translate: translateWatchWindow, glossary: () => glossary, enabled: () => true, limits: () => ({ sessionCalls: null, dailyCalls: null }) });
    try {
      const session = await service.start('https://youtu.be/_Ldhm8qB_JU');
      const partial = await service.window(session.sessionId, 0, true);
      assert.equal(partial.complete, false); assert.equal(partial.cues.length, 7); assert.equal(partial.cached, false);
      assert.deepEqual(partial.failedCues?.map(value => value.id), [cues[6].id]); assert.equal(partial.failedCues?.[0].code, 'LOCAL_TRANSLATION_QUALITY');
      assert(!partial.cues.some(value => value.id === cues[6].id)); assert.equal(inferred.length, 9);
      assert.equal((await service.window(session.sessionId, 40, true)).complete, true); assert.equal(inferred.length, 17);
      const hydrated = await service.start('https://youtu.be/_Ldhm8qB_JU'); assert.equal(hydrated.cachedCues?.length, 15); assert(!hydrated.cachedCues?.some(value => value.id === cues[6].id));
      recovered = true; const restored = await service.window(session.sessionId, 0, true);
      assert.equal(restored.complete, true); assert.equal(inferred.length, 18); assert.equal(inferred.at(-1), cues[6].text);
      service.stop(session.sessionId); service.stop(hydrated.sessionId);
    } finally { store.close(); }
  });
});

test('repair cancellation, deadline and true provider failure stay distinct without additional calls', async () => {
  for (const code of ['CANCELLED', 'LOCAL_MODEL_NOT_FOUND']) {
    let calls = 0; const controller = new AbortController();
    await withFetch(async () => { calls++; if (calls === 1) return unfinished(); if (code === 'CANCELLED') { controller.abort(); return complete(); } return new Response('private-model-payload', { status: 404 }); }, async () => {
      await assert.rejects(translateWatchWindow({ ...input, signal: controller.signal }), { code }); assert.equal(calls, 2);
    });
  }
  const savedTimeout = AbortSignal.timeout, deadline = new AbortController(); let timers = 0, calls = 0;
  try {
    AbortSignal.timeout = (ms: number) => { assert.equal(ms, 90000); return ++timers === 1 ? deadline.signal : new AbortController().signal; };
    await withFetch(async () => { calls++; if (calls === 1) return unfinished(); deadline.abort(); return complete(); }, async () => {
      await assert.rejects(translateWatchWindow(input), { code: 'LOCAL_MODEL_TIMEOUT' }); assert.equal(calls, 2);
    });
  } finally { AbortSignal.timeout = savedTimeout; }
});

test('cloud transport and its single structured request are unchanged', async () => {
  const savedKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'mock-test-not-a-real-key'; let calls = 0;
  try {
    await withFetch(async (_url, init) => { calls++; const body = JSON.parse(String(init?.body)); assert.equal(body.max_tokens, 6000); assert.equal(body.response_format.type, 'json_schema'); assert.equal(body.format, undefined); return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ cues: [{ id: cue.id, text: '而且可能更透明。' }] }) } }] }); }, async () => {
      assert.equal((await translateWatchWindow(input)).length, 1); assert.equal(calls, 1);
    }, 'cloud');
  } finally { if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey; }
});
