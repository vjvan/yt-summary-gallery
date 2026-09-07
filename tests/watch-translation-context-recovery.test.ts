import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProtectedCue, requiredProtectedTerms, canonicalProtectedText, hasOrdinaryReactVerb, canonicalizeProtectedPlatformTranslation, missingProtectedTerms } from '../lib/watch/protected-terms';
import { localCueMessages, requestLocalCue, untranslatedLocalWords } from '../lib/watch/local-cue-translator';
import { translateWatchWindow, TRANSLATION_VERSION } from '../lib/watch/translator';
import { WatchStore } from '../lib/watch/store';
import { WatchService } from '../lib/watch/service';
import { watchProviderInfo } from '../lib/watch/provider';
import type { Glossary } from '../lib/glossary-defaults';
import type { WatchCue, WatchSource } from '../lib/watch/types';

const glossary: Glossary = { no_translate_terms: ['React', 'Midjourney', 'Higgsfield'], term_map: [], style_rules: [] };
const cue = (text: string): WatchCue => ({ id: 'context-fixture', start: 5, end: 9, text });
const source = (target: WatchCue): WatchSource => ({ videoId: 'abcdefghijk', title: 'Unrelated public interview fixture', language: 'en', sourceKind: 'manual', trackId: 'context-fixture', cues: [target] });
const complete = (text: string) => Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ text }) } });
async function withLocal(fetcher: typeof fetch, run: () => Promise<void>) {
  const old = { fetch: globalThis.fetch, mode: process.env.WATCH_PROCESSING_MODE, model: process.env.WATCH_LOCAL_MODEL };
  process.env.WATCH_PROCESSING_MODE = 'local'; process.env.WATCH_LOCAL_MODEL = 'qwen2.5:7b';
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat'); assert.equal(new Headers(init?.headers).has('authorization'), false);
    return fetcher(url, init);
  };
  try { await run(); } finally {
    globalThis.fetch = old.fetch;
    if (old.mode === undefined) delete process.env.WATCH_PROCESSING_MODE; else process.env.WATCH_PROCESSING_MODE = old.mode;
    if (old.model === undefined) delete process.env.WATCH_LOCAL_MODEL; else process.env.WATCH_LOCAL_MODEL = old.model;
  }
}

test('only clear lowercase react verbs lose the framework requirement; exact custom terms/labels remain', () => {
  for (const text of ['We react to certain things.', 'People naturally react.', 'They would actually react to it.', 'I do not react to that.']) {
    const item = cue(text); assert.equal(hasOrdinaryReactVerb(item, glossary), true);
    assert.deepEqual(requiredProtectedTerms(item, glossary), []); assert.equal(canonicalProtectedText(item, glossary), text);
    assert.deepEqual(untranslatedLocalWords('我們會反應。', item, glossary), []);
    assert.deepEqual(untranslatedLocalWords('我們 React。', item, glossary), ['react']);
  }
  for (const text of ['Use React to build a component.', 'We use react to build the UI.', 'Open the react panel.', 'We React to events.', 'We "react" to it.', 'We `react` to it.']) {
    assert.equal(hasOrdinaryReactVerb(cue(text), glossary), false, text); assert.deepEqual(requiredProtectedTerms(cue(text), glossary), ['React']);
  }
  for (const [keeps, expected] of [[['react'], 'react'], [['React', 'react'], 'react'], [['react', 'React'], 'react'], [['React', 'react to'], 'react to']] as const) {
    const custom = { ...glossary, no_translate_terms: [...keeps] };
    assert.equal(hasOrdinaryReactVerb(cue('We react to it.'), custom), false);
    assert.deepEqual(requiredProtectedTerms(cue('We react to it.'), custom), [expected]);
  }
  for (const no_translate_terms of [['React', 'react'], ['react', 'React']]) assert.deepEqual(requiredProtectedTerms(cue('Use React.'), { ...glossary, no_translate_terms }), ['React']);
  const mixed = cue('We react to events in React.');
  assert.deepEqual(requiredProtectedTerms(mixed, glossary), ['React']);
  assert.equal(canonicalProtectedText(mixed, glossary), mixed.text);
});

test('sref/srefs preservation requires same-cue Midjourney context and respects custom term mappings', () => {
  for (const text of ['Use Midjourney srefs.', 'Midjourney --sref 123 works.', 'Try SREFS in Midjourney.']) {
    const item = cue(text), prepared = prepareProtectedCue(source(item), item, glossary);
    assert(requiredProtectedTerms(prepared.cue, prepared.glossary).some(term => /^srefs?$/i.test(term)));
    assert.equal(prepared.cue.text, item.text); assert.deepEqual(untranslatedLocalWords(text.includes('SREFS') ? '使用 Midjourney 的 SREFS。' : text.includes('srefs') ? '使用 Midjourney 的 srefs。' : '使用 Midjourney 的 sref 123。', prepared.cue, prepared.glossary), []);
    assert.deepEqual(untranslatedLocalWords('使用 Midjourney srefs actually。', prepared.cue, prepared.glossary), text.includes('srefs') ? ['actually'] : ['srefs', 'actually']);
  }
  const item = cue('Try srefs.'), elsewhere = { ...source(item), title: 'Midjourney tutorial' };
  assert.deepEqual(prepareProtectedCue(elsewhere, item, glossary).glossary, glossary);
  const custom: Glossary = { ...glossary, term_map: [['sref', '風格參考']] };
  assert(!prepareProtectedCue(source(item), cue('Midjourney uses srefs.'), custom).glossary.no_translate_terms.includes('srefs'));
  assert.deepEqual(glossary.no_translate_terms, ['React', 'Midjourney', 'Higgsfield']);
});

test('spelled H D licenses HD only when the source observes it, not arbitrary letters or English', async () => {
  const item = cue('In H D it looks worse.');
  assert.deepEqual(untranslatedLocalWords('HD 看起來更差。', item, glossary), []);
  assert.deepEqual(untranslatedLocalWords('HD actually 更差。', item, glossary), ['actually']);
  for (const text of ['It looks worse.', 'H is followed by D.', 'Choose this H and D.']) assert(untranslatedLocalWords('HD 看起來更差。', cue(text), glossary).length > 0);
  await withLocal(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const pattern = new RegExp(body.format.properties.text.pattern);
    assert(pattern.test('HD 看起來更差。')); assert(!pattern.test('HD actually 更差。'));
    return complete('HD 看起來更差。');
  }, async () => { await requestLocalCue({ cue: item, glossary, model: 'qwen2.5:7b', signal: new AbortController().signal }); });
});

test('standalone pew sound uses an onomatopoeia hint, never a name-only English fallback', async () => {
  const item = cue('Pew.'); const message = localCueMessages(item, glossary);
  assert.match(message[0].content, /vocal sound imitation/); assert.deepEqual(JSON.parse(message[1].content).glossary.preferred, [['pew', '咻']]);
  assert.deepEqual(untranslatedLocalWords('Pew.', item, glossary), ['pew']);
  for (const text of ['Pew Research Center reports results.', 'A wooden pew.']) assert.doesNotMatch(localCueMessages(cue(text), glossary)[0].content, /vocal sound imitation/);
  assert.doesNotMatch(localCueMessages(item, { ...glossary, no_translate_terms: ['Pew'] })[0].content, /vocal sound imitation/);
  let calls = 0;
  await withLocal(async (_url, init) => {
    calls++; const pattern = new RegExp(JSON.parse(String(init?.body)).format.properties.text.pattern);
    assert(pattern.test('咻。')); assert(!pattern.test('Pew.')); return complete('咻。');
  }, async () => {
    const [result] = await translateWatchWindow({ source: source(item), targets: [item], before: [], after: [], glossary });
    assert.equal(calls, 1); assert.equal(result.originalText, 'Pew.'); assert.equal(result.start, item.start); assert.equal(result.end, item.end); assert.equal(result.text, '咻。');
  });
});

test('recognized sref incomplete generation uses its single compact constrained repair with all guards', async () => {
  const item = cue('Explain Midjourney and the nerdy srefs details.');
  for (const output of ['說明 Midjourney 和那些鑽研 srefs 的細節。', '說明 Midjourney actually srefs。', '說明 Midjourney 的細節。']) {
    let calls = 0;
    await withLocal(async (_url, init) => {
      calls++; const body = JSON.parse(String(init?.body));
      assert.equal(typeof body.format.properties.text.pattern, 'string');
      if (calls === 1) return Response.json({ done: false, message: { content: '{"text":"未完' } });
      assert.equal(calls, 2); assert(body.messages[0].content.length < 500); assert.match(body.messages[0].content, /完整翻成自然台灣繁體中文/);
      assert(new RegExp(body.format.properties.text.pattern).test('說明 Midjourney 與 srefs。'));
      assert(!new RegExp(body.format.properties.text.pattern).test('說明 Midjourney actually srefs。'));
      return complete(output);
    }, async () => {
      const task = translateWatchWindow({ source: source(item), targets: [item], before: [], after: [], glossary });
      if (output.includes('鑽研')) assert.equal((await task)[0].originalText, item.text);
      else await assert.rejects(task, { code: 'LOCAL_TRANSLATION_QUALITY' });
      assert.equal(calls, 2);
    });
  }
  assert.equal(TRANSLATION_VERSION, 'watch-zh-TW-v14-taiwan-register-speaker-names');
});

test('only affected local react cue/window cache keys change; all other cached cues remain reusable', async () => {
  const cues = Array.from({ length: 16 }, (_, i) => ({ id: `cache-${i}`, start: i * 5, end: i * 5 + 4, text: i === 3 ? 'We react to certain things.' : `Use the layer for step ${i}.` }));
  const store = new WatchStore(':memory:'); const readKeys: string[] = [], translated: string[] = [];
  const getCue = store.getCue.bind(store); store.getCue = (key, item) => { readKeys.push(key); return getCue(key, item); };
  await withLocal(async () => { throw new Error('No real model'); }, async () => {
    const service = new WatchService({ store, source: async () => ({ ...source(cues[0]), cues }), provider: watchProviderInfo, glossary: () => glossary, enabled: () => true, limits: () => ({ sessionCalls: null, dailyCalls: null }),
      translate: async input => input.targets.map(item => { translated.push(item.id); return { ...item, originalText: item.text, text: item.id === cues[3].id ? '我們對某些事情有反應。' : `字幕 ${item.id}` }; }) });
    try {
      const first = await service.start('https://youtu.be/abcdefghijk'); service.stop(first.sessionId);
      const keys = readKeys.slice(); assert.equal(keys.length, 16); assert.equal(keys.filter(key => key.endsWith(':react-verb-v1')).length, 1);
      const prefix = keys[0].split(':cue:')[0];
      const old = cues.map(item => ({ ...item, originalText: item.text, text: item.id === cues[3].id ? '我們 React 對某些事情。' : `舊成功字幕 ${item.id}` }));
      cues.forEach((item, i) => store.putCue(keys[i].replace(/:react-verb-v1$/, ''), item, old[i]));
      store.put(`${prefix}:0`, old.slice(0, 8)); store.put(`${prefix}:1`, old.slice(8));
      const hydrated = await service.start('https://youtu.be/abcdefghijk');
      assert.equal(hydrated.cachedCues?.length, 15); assert(!hydrated.cachedCues?.some(item => item.id === cues[3].id));
      const recovered = await service.window(hydrated.sessionId, 0, true);
      assert.equal(recovered.complete, true); assert.deepEqual(translated, [cues[3].id]); assert.equal(recovered.cues[3].text, '我們對某些事情有反應。');
      assert.equal(store.get(`${prefix}:0`)?.[3].text, old[3].text, 'legacy row is not deleted or globally invalidated');
      assert.equal(store.get(`${prefix}:0:react-verb-v1`)?.[3].text, '我們對某些事情有反應。');
      assert.equal((await service.window(hydrated.sessionId, 40, true)).cached, true); assert.equal(translated.length, 1);
      const final = await service.start('https://youtu.be/abcdefghijk'); assert.equal(final.cachedCues?.length, 16);
      service.stop(hydrated.sessionId); service.stop(final.sessionId);
    } finally { store.close(); }
  });
});

test('cloud window keys never gain the local react revision', async () => {
  const store = new WatchStore(':memory:'); let seenKey = '', calls = 0;
  const get = store.get.bind(store); store.get = key => { seenKey = key; return get(key); };
  const item = cue('We react to certain things.');
  const provider = () => ({ ...watchProviderInfo(), processingMode: 'cloud' as const, translationModel: 'mock-cloud', translationConfigured: true });
  const service = new WatchService({ store, source: async () => source(item), provider, glossary: () => glossary, enabled: () => true, limits: () => ({ sessionCalls: 25, dailyCalls: 100 }),
    translate: async () => { calls++; return [{ ...item, originalText: item.text, text: '我們對某些事情有反應。' }]; } });
  try {
    const session = await service.start('https://youtu.be/abcdefghijk'); await service.window(session.sessionId, 0, true);
    assert.match(seenKey, /^[a-f0-9]{64}:0$/); assert.equal((await service.window(session.sessionId, 0, true)).cached, true); assert.equal(calls, 1); service.stop(session.sessionId);
  } finally { store.close(); }
});

test('known Chinese Higgsfield spellings are corrected in place only for an explicit AI-platform source mention', () => {
  const item = cue('Do not use Higgsfield 2.'), ai = { ...source(item), title: 'AI video tools interview' };
  for (const alias of ['希格斯場', '希格斯場域', '希格斯菲爾德', '希格斯场', '希格斯菲尔德']) {
    assert.equal(canonicalizeProtectedPlatformTranslation(`不要用 ${alias} 2。`, ai, item, glossary), '不要用 Higgsfield 2。');
  }
  assert.equal(canonicalizeProtectedPlatformTranslation('不要用那個 2。', ai, item, glossary), '不要用那個 2。', 'never append a missing name');
  assert.equal(canonicalizeProtectedPlatformTranslation('不要用希格斯場 2。', ai, cue('Do not use that tool 2.'), glossary), '不要用希格斯場 2。');
  assert.equal(canonicalizeProtectedPlatformTranslation('不要用希格斯場 2。', ai, item, { ...glossary, no_translate_terms: [] }), '不要用希格斯場 2。');
  assert.equal(canonicalizeProtectedPlatformTranslation('不要用希格斯場 2。', { ...ai, title: 'An unrelated conversation' }, item, glossary), '不要用希格斯場 2。');
  const physical = { ...ai, title: 'ChatGPT explains particle physics' };
  assert.equal(canonicalizeProtectedPlatformTranslation('希格斯場賦予粒子質量。', physical, item, glossary), '希格斯場賦予粒子質量。');
  const neighbor = { ...ai, cues: [item, { ...item, id: 'physical-neighbor', text: 'The Higgs field gives matter its mass.' }] };
  assert.equal(canonicalizeProtectedPlatformTranslation('希格斯場賦予粒子質量。', neighbor, item, glossary), '希格斯場賦予粒子質量。');
  for (const text of ['Higgsfield gives everything mass.', 'Higgsfield provides everything with mass.', 'Higgsfield is responsible for mass.']) {
    const joined = cue(text), physicalAsr = { ...source(joined), title: 'ChatGPT explains it' };
    assert.equal(canonicalizeProtectedPlatformTranslation('希格斯場賦予萬物質量。', physicalAsr, joined, glossary), '希格斯場賦予萬物質量。', text);
  }
  for (const text of ['Higgsfield provides tools for mass production.', 'Higgsfield provides mass-produced images.']) {
    const production = cue(text);
    assert.equal(canonicalizeProtectedPlatformTranslation('希格斯場提供量產工具。', { ...ai, cues: [production] }, production, glossary), 'Higgsfield提供量產工具。');
  }
  const repeated = cue('Higgsfield is still Higgsfield.');
  assert.deepEqual(missingProtectedTerms(canonicalizeProtectedPlatformTranslation('希格斯場仍然如此。', ai, repeated, glossary), ['Higgsfield', 'Higgsfield']), ['Higgsfield']);
});

test('platform spelling correction retains original text/timing and cannot satisfy lost/extra mentions', async () => {
  const item = cue('Do not use Higgsfield 2.'), ai = { ...source(item), title: 'AI video tools interview' };
  let calls = 0;
  await withLocal(async () => { calls++; return complete('不要用希格斯場 2。'); }, async () => {
    const [result] = await translateWatchWindow({ source: ai, targets: [item], before: [], after: [], glossary });
    assert.equal(calls, 1); assert.equal(result.text, '不要用Higgsfield 2。');
    assert.equal(result.originalText, item.text); assert.equal(result.start, item.start); assert.equal(result.end, item.end);
  });
  for (const text of ['不要用那個 2。', '不要用 Higgsfield 或希格斯場 2。', '不要用希格斯場 2 actually。']) {
    calls = 0;
    await withLocal(async () => { calls++; return complete(text); }, async () => {
      await assert.rejects(translateWatchWindow({ source: ai, targets: [item], before: [], after: [], glossary }), { code: 'LOCAL_TRANSLATION_QUALITY' }); assert.equal(calls, 2);
    });
  }
  const repeated = cue('Do not use Higgsfield; maybe use Higgsfield.'); calls = 0;
  await withLocal(async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    return body.format.required[0] === 'p0' ? Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ p0: '不要用 Higgsfield，', p1: '也許吧。' }) } }) : complete('不要用希格斯場，也許吧。');
  }, async () => {
    await assert.rejects(translateWatchWindow({ source: { ...ai, cues: [repeated] }, targets: [repeated], before: [], after: [], glossary }), { code: 'LOCAL_TRANSLATION_QUALITY' }); assert.equal(calls, 2);
  });
});
