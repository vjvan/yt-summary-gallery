import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProtectedCue, protectedNamesOnlyText, requiredProtectedTerms } from '../lib/watch/protected-terms';
import { translateWatchWindow, validateWatchTranslation } from '../lib/watch/translator';
import { localCueMessages } from '../lib/watch/local-cue-translator';
import type { Glossary } from '../lib/glossary-defaults';
import type { WatchCue, WatchSource } from '../lib/watch/types';

const glossary: Glossary = { no_translate_terms: ['Higgsfield', 'Nano Banana', 'My Custom Tool', 'Model 2'], term_map: [], style_rules: [] };
const cue = (text: string, start = 2404.54): WatchCue => ({ id: 'names-fixture', start, end: start + 1.86, text });
const source = (target: WatchCue): WatchSource => ({ videoId: 'abcdefghijk', title: 'Different public source', language: 'en', sourceKind: 'manual', trackId: 'pure-name-test', cues: [target] });
function classify(target: WatchCue, terms = glossary) {
  const prepared = prepareProtectedCue(source(target), target, terms);
  return protectedNamesOnlyText(prepared.cue, prepared.glossary);
}
async function local(run: (calls: () => number) => Promise<void>) {
  const oldFetch = globalThis.fetch, oldMode = process.env.WATCH_PROCESSING_MODE, oldModel = process.env.WATCH_LOCAL_MODEL;
  let calls = 0;
  try {
    process.env.WATCH_PROCESSING_MODE = 'local'; process.env.WATCH_LOCAL_MODEL = 'qwen2.5:7b';
    globalThis.fetch = async url => { calls++; assert.equal(url, 'http://127.0.0.1:11434/api/chat'); return Response.json({ done: true, done_reason: 'stop', message: { content: '{"text":"Game Boy Camera"}' } }); };
    await run(() => calls);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldMode === undefined) delete process.env.WATCH_PROCESSING_MODE; else process.env.WATCH_PROCESSING_MODE = oldMode;
    if (oldModel === undefined) delete process.env.WATCH_LOCAL_MODEL; else process.env.WATCH_LOCAL_MODEL = oldModel;
  }
}

test('known product-only source with observed speaker metadata is exact preservation, with no inference or fabricated Chinese', async () => {
  const target = cue('Drew Brucker (40:04) Game Boy Camera.');
  const original = structuredClone({ target, glossary });
  assert.equal(classify(target), target.text);
  await local(async calls => {
    const [result] = await translateWatchWindow({ source: source(target), targets: [target], before: [], after: [], glossary });
    assert.deepEqual(result, { ...target, text: target.text, originalText: target.text });
    assert.equal(calls(), 0); assert.deepEqual({ target, glossary }, original);
  });
});

test('multiple explicit names, repeated mentions and model numbers stay exact and ordered', async () => {
  const target = cue('Drew Brucker (40:04) Higgsfield, Model 2, Higgsfield, My Custom Tool.');
  assert.equal(classify(target), target.text);
  assert.deepEqual(requiredProtectedTerms(target, glossary), ['Higgsfield', 'Model 2', 'Higgsfield', 'My Custom Tool']);
  await local(async calls => {
    const [result] = await translateWatchWindow({ source: source(target), targets: [target], before: [], after: [], glossary });
    assert.equal(result.text, target.text); assert.equal(calls(), 0);
  });
  assert.equal(classify(cue('Model 2.')), 'Model 2.');
  assert.equal(classify(cue('model 2.')), 'Model 2.', 'only explicit keep-term casing may normalize');
  assert.equal(classify(cue('Model 3.')), null, 'unlisted model/version cannot pass');
  assert.equal(classify(cue('Model 2, 99%.')), null, 'unprotected numbers cannot disappear into metadata');
  assert.equal(classify(cue('My Custom Tool 3.')), null);
});

test('arbitrary Title Case, ordinary words, negation and added choices never become name-only', async () => {
  for (const text of ['Open The Window.', 'Drew Brucker (40:04) Open The Window.', 'Game Boy Camera is nice.', 'No, Game Boy Camera.', 'maybe Higgsfield.', 'Higgsfield gonna Higgsfield.', 'Game Boy Camera and Higgsfield.', 'the Game Boy Camera.', 'Game Boy Camera Camera.', '普通中文 Game Boy Camera。']) assert.equal(classify(cue(text)), null, text);
  await local(async calls => {
    const target = cue('No, Game Boy Camera.');
    await assert.rejects(translateWatchWindow({ source: source(target), targets: [target], before: [], after: [], glossary }), { code: 'LOCAL_TRANSLATION_QUALITY' });
    assert.equal(calls(), 2, 'ordinary source still requires Chinese and has only one repair');
  });
});

test('metadata is anchored to the source clock and is retained, not inferred from arbitrary numeric text', () => {
  assert.equal(classify(cue('Drew Brucker (40:04) Game Boy Camera.')), 'Drew Brucker (40:04) Game Boy Camera.');
  assert.equal(classify(cue('Rory Flynn (1:40:04) Game Boy Camera.', 6004.54)), 'Rory Flynn (1:40:04) Game Boy Camera.');
  for (const text of ['Drew Brucker (40:64) Game Boy Camera.', 'Drew Brucker (39:00) Game Boy Camera.', 'Drew Brucker (1998) Game Boy Camera.', 'Drew Brucker (40:04) 1998 Game Boy Camera.', 'Drew Brucker Game Boy Camera.', 'Drew Brucker (40:04) Game Boy Camera. Next', 'Drew Brucker (40:04)\nGame Boy Camera.']) assert.equal(classify(cue(text)), null, text);
});

test('product recognition is source-specific and does not replace user mappings or generic camera words', () => {
  assert.equal(classify(cue('Game Boy Camera.')), 'Game Boy Camera.');
  assert.equal(classify(cue('game boy camera.')), null);
  assert.equal(classify(cue('Game Boy Cameraish.')), null);
  assert.equal(classify(cue('Camera.')), null);
  const ordinary = cue('I used Game Boy Camera today.');
  assert.deepEqual(prepareProtectedCue(source(ordinary), ordinary, glossary).glossary, glossary, 'ordinary-sentence prompts and cacheable mandatory names stay unchanged');
  const custom = { ...glossary, term_map: [['Game Boy Camera', '使用者自訂譯法']] as [string, string][] };
  const target = cue('Game Boy Camera.');
  const prepared = prepareProtectedCue(source(target), target, custom);
  assert.deepEqual(prepared.glossary, custom); assert.equal(classify(target, custom), null);
  assert.equal(classify(cue('my custom tool.')), 'My Custom Tool.');
});

test('cloud validator does not inherit the local source-preservation exception and pre-cancel makes no inference', async () => {
  const target = cue('Drew Brucker (40:04) Game Boy Camera.');
  assert.throws(() => validateWatchTranslation(JSON.stringify({ cues: [{ id: target.id, text: target.text }] }), [target], glossary), { code: 'MODEL_FAILED' });
  await local(async calls => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(translateWatchWindow({ source: source(target), targets: [target], before: [], after: [], glossary, signal: controller.signal }), { code: 'CANCELLED' });
    assert.equal(calls(), 0);
  });
});

test('only repeated protected-name repairs get the generic mention/uncertainty/order rule', () => {
  const target = cue('Higgsfield, maybe Higgsfield, finally Higgsfield 2.');
  const initial = localCueMessages(target, glossary)[0].content;
  const repair = localCueMessages(target, glossary, true, ['Higgsfield'])[0].content;
  assert.doesNotMatch(initial, /Repeated protected names in hesitation|SampleTool/);
  assert.match(repair, /"name":"Higgsfield","occurrences":3/);
  assert.match(repair, /Repeated protected names in hesitation/);
  assert.match(repair, /never move uncertainty onto a later final choice/);
  assert.match(repair, /never append disconnected names/);
  assert.match(repair, /Try SampleTool, maybe SampleTool, let us use SampleTool/);
  assert.match(repair, /試試 SampleTool，也許用 SampleTool，來用 SampleTool/);
  assert.match(repair, /illustration only, never content to copy/);
  assert.doesNotMatch(localCueMessages(cue('Use Higgsfield.'), glossary, true, ['Higgsfield'])[0].content, /Repeated protected names in hesitation|SampleTool/);
  assert.doesNotMatch(localCueMessages(target, glossary, ['maybe'])[0].content, /Repeated protected names in hesitation|SampleTool/);
});
