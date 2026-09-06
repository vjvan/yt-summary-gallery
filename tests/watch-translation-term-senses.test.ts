import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalProtectedText, protectedTermOccurrences, requiredProtectedTerms, missingProtectedTerms } from '../lib/watch/protected-terms';
import { localCueMessages, requestLocalCue, untranslatedLocalWords } from '../lib/watch/local-cue-translator';
import { translateWatchWindow } from '../lib/watch/translator';
import type { Glossary } from '../lib/glossary-defaults';
import type { WatchCue, WatchSource } from '../lib/watch/types';

const glossary: Glossary = { no_translate_terms: ['Hero', 'Higgsfield', 'My Custom Tool'], term_map: [['hero angle', '主視角']], style_rules: [] };
const cue = (text: string): WatchCue => ({ id: 'unrelated-fixture', start: 12.3, end: 15.6, text });
const source = (target: WatchCue): WatchSource => ({ videoId: 'abcdefghijk', title: 'Unrelated test title', language: 'en', sourceKind: 'manual', trackId: 'sense-fixture', cues: [target] });
const response = (text: string) => Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ text }) } });
async function withMock(fetcher: typeof fetch, run: () => Promise<void>) {
  const savedFetch = globalThis.fetch, savedMode = process.env.WATCH_PROCESSING_MODE, savedModel = process.env.WATCH_LOCAL_MODEL;
  try { globalThis.fetch = fetcher; process.env.WATCH_PROCESSING_MODE = 'local'; process.env.WATCH_LOCAL_MODEL = 'qwen2.5:7b'; await run(); }
  finally { globalThis.fetch = savedFetch; if (savedMode === undefined) delete process.env.WATCH_PROCESSING_MODE; else process.env.WATCH_PROCESSING_MODE = savedMode; if (savedModel === undefined) delete process.env.WATCH_LOCAL_MODEL; else process.env.WATCH_LOCAL_MODEL = savedModel; }
}

test('ordinary lowercase cinematography compounds are not falsely required as the generic Hero keep label', () => {
  for (const text of ['change this hero angle.', 'film two hero shots.', 'use a hero-shot.', 'a low angle hero.', 'a high-angle hero.']) {
    const target = cue(text);
    assert.deepEqual(requiredProtectedTerms(target, glossary), [], text);
    assert.equal(canonicalProtectedText(target, glossary), text);
    const messages = localCueMessages(target, glossary);
    const data = JSON.parse(messages[1].content);
    assert.deepEqual(data.glossary.keep, []); assert.equal(data.text, text);
  }
});

test('capitalized labels, ordinary UI usage, quoted strings and longer explicit custom terms remain protected', () => {
  for (const text of ['change the Hero angle.', 'open the hero section.', 'use the Hero component.', 'select "hero angle".', 'select `hero shot`.', "select 'hero angle'.", '選擇「hero angle」。', 'select “hero shot”.']) {
    assert.deepEqual(requiredProtectedTerms(cue(text), glossary), ['Hero'], text);
  }
  for (const term of ['hero', 'hero angle', 'hero shot']) {
    const custom = { ...glossary, no_translate_terms: [term] };
    const target = cue(term === 'hero' ? 'this hero angle' : `this ${term}`);
    assert.deepEqual(requiredProtectedTerms(target, custom), [term]);
  }
  assert.deepEqual(requiredProtectedTerms(cue('this hero angle.'), { ...glossary, no_translate_terms: ['Hero', 'hero angle'] }), ['hero angle'], 'explicit longest phrase overrides the homonym rule');
  assert.deepEqual(requiredProtectedTerms(cue('Open My Custom Tool and Hero.'), glossary), ['My Custom Tool', 'Hero']);
});

test('word-sense classification is occurrence-specific in mixed UI and cinematography content', () => {
  const target = cue('Use the hero section for this hero angle; Hero is selected.');
  const occurrences = protectedTermOccurrences(target, glossary);
  assert.deepEqual(occurrences.map(item => target.text.slice(item.start, item.end)), ['hero', 'Hero']);
  assert.deepEqual(requiredProtectedTerms(target, glossary), ['Hero', 'Hero']);
  assert.equal(canonicalProtectedText(target, glossary), 'Use the Hero section for this hero angle; Hero is selected.');
  const data = JSON.parse(localCueMessages(target, glossary)[1].content);
  assert.deepEqual(data.glossary.keep, ['Hero']);
  assert.match(data.text, /this hero angle/);
  assert.deepEqual(missingProtectedTerms('使用 Hero 區塊呈現此主視角；已選取 Hero。', ['Hero', 'Hero']), []);
  assert.deepEqual(missingProtectedTerms('使用 Hero 區塊。', ['Hero', 'Hero']), ['Hero']);
  assert.deepEqual(missingProtectedTerms('Hero、Hero、Hero。', ['Hero', 'Hero']), ['Hero']);
});

test('grammar and ordinary-English postvalidation consume the same classified keep terms', async () => {
  const target = cue('change this hero angle with Higgsfield.');
  await withMock(async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(init?.body));
    const pattern = new RegExp(body.format.properties.text.pattern);
    assert(pattern.test('使用 Higgsfield 改變此主視角。'));
    assert(!pattern.test('使用 Hero 角度。'));
    assert(!pattern.test('change 這個角度。'));
    const data = JSON.parse(body.messages[1].content);
    assert.deepEqual(data.glossary.keep, ['Higgsfield']);
    assert.deepEqual(data.glossary.preferred, [['hero angle', '主視角']]);
    return response('使用 Higgsfield 改變此主視角。');
  }, async () => {
    await requestLocalCue({ cue: target, glossary, model: 'qwen2.5:7b', signal: new AbortController().signal });
  });
  assert.deepEqual(untranslatedLocalWords('使用 Higgsfield 改變主視角。', target, glossary), []);
  assert.deepEqual(untranslatedLocalWords('使用 Hero 角度。', target, glossary), ['hero']);
});

test('successful ordinary-term translation preserves original text/timing without an unnecessary name repair', async () => {
  const target = cue('first change the hero angle, then move the camera closer.');
  const before = structuredClone({ target, glossary }); let calls = 0;
  await withMock(async () => { calls++; return response('先改變主視角，再把攝影機移近。'); }, async () => {
    const [result] = await translateWatchWindow({ source: source(target), targets: [target], before: [], after: [], glossary });
    assert.equal(calls, 1); assert.equal(result.originalText, target.text);
    assert.equal(result.id, target.id); assert.equal(result.start, target.start); assert.equal(result.end, target.end);
    assert.deepEqual({ target, glossary }, before);
  });
});

test('genuine names still have strict counts and bounded repair; the sense fix is not an English fallback', async () => {
  const target = cue('Higgsfield does what Higgsfield does, in a hero angle.'); let calls = 0;
  await withMock(async () => { calls++; return response('Higgsfield 依舊如此，採用主視角。'); }, async () => {
    await assert.rejects(translateWatchWindow({ source: source(target), targets: [target], before: [], after: [], glossary }), { code: 'LOCAL_TRANSLATION_QUALITY' });
    assert.equal(calls, 2);
  });
  const ordinary = cue('change this hero angle.'); calls = 0;
  await withMock(async () => { calls++; return response('change this hero angle.'); }, async () => {
    await assert.rejects(translateWatchWindow({ source: source(ordinary), targets: [ordinary], before: [], after: [], glossary }), { code: 'LOCAL_TRANSLATION_QUALITY' });
    assert.equal(calls, 2);
  });
});
