import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProtectedCue, requiredProtectedTerms, missingProtectedTerms } from '../lib/watch/protected-terms';
import { translateWatchWindow, TRANSLATION_VERSION } from '../lib/watch/translator';
import type { Glossary } from '../lib/glossary-defaults';
import type { WatchCue, WatchSource } from '../lib/watch/types';

const cue: WatchCue = { id: 'brand-114', start: 503.84, end: 508.68, text: 'in open art or Higgs Field. And now let me show you very briefly what is' };
const source: WatchSource = { videoId: '7BAxEmrKnV0', title: 'Figma Weave AI platform review', language: 'en', sourceKind: 'automatic', trackId: 'fixture', cues: [{ ...cue, id: 'evidence', text: 'Higgsfield offers image generation models.' }, cue] };
const glossary: Glossary = { no_translate_terms: ['Compositor', 'My Exact UI'], term_map: [['OpenArt', '開放藝術'], ['Higgs Field', '希格斯場域'], ['custom word', '自訂用語']], style_rules: ['完整翻譯，不縮寫。'] };

async function mockLocal(fetcher: typeof fetch, run: () => Promise<void>) {
  const oldFetch = globalThis.fetch, oldMode = process.env.WATCH_PROCESSING_MODE;
  try { process.env.WATCH_PROCESSING_MODE = 'local'; globalThis.fetch = fetcher; await run(); }
  finally { globalThis.fetch = oldFetch; if (oldMode === undefined) delete process.env.WATCH_PROCESSING_MODE; else process.env.WATCH_PROCESSING_MODE = oldMode; }
}
const envelope = (text: string) => Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ text }) } });

test('platform ASR aliases are canonical only in model input and preserve custom glossary', () => {
  const before = structuredClone({ source, glossary });
  const result = prepareProtectedCue(source, cue, glossary);
  assert.equal(result.cue.text, 'in OpenArt or Higgsfield. And now let me show you very briefly what is');
  assert.deepEqual({ id: result.cue.id, start: result.cue.start, end: result.cue.end }, { id: cue.id, start: cue.start, end: cue.end });
  assert.deepEqual(result.glossary.no_translate_terms, ['OpenArt', 'Higgsfield', 'Compositor', 'My Exact UI']);
  assert.deepEqual(result.glossary.term_map, [['custom word', '自訂用語']]);
  assert.deepEqual({ source, glossary }, before, 'ASR source and saved glossary must not be mutated');
});

test('case and word-boundary variants work without matching larger ordinary words', () => {
  for (const spelling of ['open art', 'OPEN ART', 'open-art', 'openart', 'OpenArt']) assert.equal(prepareProtectedCue(source, { ...cue, text: `Use ${spelling}.` }, glossary).cue.text, 'Use OpenArt.');
  for (const spelling of ['Higgs Field', 'higgs field', 'HIGGSFIELD', 'Higgs-field', 'Hexfield', 'hexfield']) assert.equal(prepareProtectedCue(source, { ...cue, text: `Use ${spelling}.` }, glossary).cue.text, 'Use Higgsfield.');
  const ordinary = { ...cue, text: 'open artistic work in Hexfieldish examples' };
  assert.equal(prepareProtectedCue(source, ordinary, glossary).cue.text, ordinary.text);
});

test('physics and ordinary art remain untouched even when AI or proper-brand evidence exists elsewhere', () => {
  const physicsCue = { ...cue, text: 'The Higgs field gives particles mass.' };
  const physics = { ...source, title: 'AI explains quantum physics', cues: [physicsCue] };
  assert.equal(prepareProtectedCue(physics, physicsCue, glossary).cue.text, physicsCue.text);
  const short = { ...cue, text: 'the Higgs field.' };
  const nearby = { ...source, cues: [{ ...cue, id: 'prior', text: 'Now we discuss the quantum vacuum.' }, short] };
  assert.equal(prepareProtectedCue(nearby, short, glossary).cue.text, short.text);
  const generic = { ...source, title: 'Weekend arts', cues: [] };
  const art = { ...cue, text: 'visit the open art exhibition.' };
  assert.equal(prepareProtectedCue(generic, art, glossary).cue.text, art.text);
  assert.equal(prepareProtectedCue(source, art, glossary).cue.text, art.text);
  assert.equal(prepareProtectedCue(generic, { ...cue, text: 'the Higgs field.' }, glossary).cue.text, 'the Higgs field.');
  assert.equal(prepareProtectedCue({ ...generic, title: 'AI explains the Higgs field' }, { ...cue, text: 'the Higgs field.' }, glossary).cue.text, 'the Higgs field.');
});

test('an existing canonical brand in the same source can authorize the alias without AI keywords', () => {
  const branded = { ...source, title: 'Product review', cues: [{ ...cue, id: 'brand', text: 'Higgsfield' }, cue] };
  assert.equal(prepareProtectedCue(branded, cue, glossary).cue.text, 'in open art or Higgsfield. And now let me show you very briefly what is');
});

test('protected names are longest-match, exact-case and occurrence-count checked', () => {
  const terms = { ...glossary, no_translate_terms: ['Nano Banana', 'Banana', 'Compositor'] };
  assert.deepEqual(requiredProtectedTerms({ ...cue, text: 'nano banana then Nano Banana and compositor.' }, terms), ['Nano Banana', 'Nano Banana', 'Compositor']);
  assert.deepEqual(missingProtectedTerms('Nano Banana 和 Compositor', ['Nano Banana', 'Nano Banana', 'Compositor']), ['Nano Banana']);
  assert.deepEqual(missingProtectedTerms('openart、希格斯場域 Higgsfield', ['OpenArt', 'Higgsfield']), ['OpenArt', 'Higgsfield']);
  assert.deepEqual(missingProtectedTerms('OpenArt、Higgsfield', ['OpenArt', 'Higgsfield']), []);
  assert.deepEqual(missingProtectedTerms('OpenArt（開放藝術）、Higgsfield（希格斯場域）', ['OpenArt', 'Higgsfield']), ['OpenArt', 'Higgsfield']);
  assert.deepEqual(missingProtectedTerms('Higgsfield（希格斯菲爾德）', ['Higgsfield']), ['Higgsfield']);
});

test('JSON-safe grammar permits completion; exact platform-name postvalidation repairs each cue once and preserves source timing', async () => {
  let calls = 0;
  await mockLocal(async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat'); assert.equal(new Headers(init?.headers).has('authorization'), false);
    const body = JSON.parse(String(init?.body)), data = JSON.parse(body.messages[1].content);
    assert.match(data.text, /OpenArt or Higgsfield/); assert.doesNotMatch(data.text, /open art|Higgs Field/);
    const grammar = new RegExp(body.format.properties.text.pattern);
    assert(grammar.test('在 OpenArt 或 Higgsfield。'));
    assert(grammar.test('在開放藝術或希格斯場域。'), 'missing names must produce complete JSON so strict postvalidation can request its one repair');
    assert(grammar.test('在 OpenArt。'));
    assert(grammar.test('在 Higgsfield 或 OpenArt。'), 'grammar no longer forces a source-name ordering');
    calls++;
    if (calls === 2) assert.match(body.messages[0].content, /omitted or translated protected names/);
    return envelope(calls === 1 ? '在開放藝術或希格斯場域。' : '在 OpenArt 或 Higgsfield。現在讓我簡短地展示什麼是');
  }, async () => {
    const [result] = await translateWatchWindow({ source, targets: [cue], before: [], after: [], glossary });
    assert.equal(calls, 2); assert.equal(result.originalText, cue.text); assert.equal(result.start, cue.start); assert.equal(result.end, cue.end); assert.equal(result.id, cue.id);
    assert.equal(TRANSLATION_VERSION, 'watch-zh-TW-v13-contextual-protected-terms');
  });
});

test('still translated or missing names fail closed after one repair, never append names as a fake translation', async () => {
  let calls = 0;
  await mockLocal(async () => { calls++; return envelope('在開放藝術或希格斯場域。'); }, async () => {
    await assert.rejects(translateWatchWindow({ source, targets: [cue], before: [], after: [], glossary }), { code: 'LOCAL_TRANSLATION_QUALITY' }); assert.equal(calls, 2);
  });
  calls = 0;
  const second = { ...cue, id: 'second', start: 509, end: 512 };
  await mockLocal(async () => { calls++; return envelope(calls === 2 ? '在 OpenArt 或 Higgsfield。' : '在開放藝術或希格斯場域。'); }, async () => {
    await assert.rejects(translateWatchWindow({ source, targets: [cue, second], before: [], after: [], glossary }), { code: 'LOCAL_TRANSLATION_QUALITY' }); assert.equal(calls, 4, 'the second cue gets one repair, then fails closed');
  });
});


test('ChatGPT homework does not turn matter/mass or particles physics into a platform brand', () => {
  for (const text of ['The Higgs field gives matter its mass.', 'The Higgs field gives particles mass.', 'Particles interact with the Higgs field.', 'The mass of matter depends on the Higgs field.']) {
    const physicsCue = { ...cue, text };
    const homework = { ...source, title: 'Using ChatGPT for homework', cues: [physicsCue] };
    assert.equal(prepareProtectedCue(homework, physicsCue, glossary).cue.text, text);
  }
  const brand = { ...cue, text: 'Use Higgs Field. The platform choice does not matter.' };
  assert.equal(prepareProtectedCue({ ...source, cues: [brand] }, brand, glossary).cue.text, 'Use Higgsfield. The platform choice does not matter.');
});
