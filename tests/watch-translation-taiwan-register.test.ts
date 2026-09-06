import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWatchTranslationMessages, translateWatchWindow, validateWatchTranslation } from '../lib/watch/translator';
import { localCueMessages, missingSourceNumbers, requestLocalCue, untranslatedLocalWords } from '../lib/watch/local-cue-translator';
import { speakerNames, withSpeakerNames } from '../lib/watch/speaker-names';
import { normalizeTaiwanSubtitle } from '../lib/watch/taiwan-terminology';
import type { Glossary } from '../lib/glossary-defaults';
import type { WatchCue, WatchSource } from '../lib/watch/types';
// @ts-expect-error opencc-js does not ship TypeScript declarations.
import * as OpenCC from 'opencc-js';
const toTaiwanTraditional: (text: string) => string = OpenCC.Converter({ from: 'cn', to: 'tw' });

const glossary: Glossary = { no_translate_terms: ['Flux'], term_map: [['credits', '點數']], style_rules: [] };
// Public podcast cues (N-tmQ_Can_o): speaker labels, an interjection, a percentage and a discount.
const cues: WatchCue[] = [
  { id: 'a', start: 1633.4, end: 1635.2, text: 'Drew Brucker (27:13) Yeah.' },
  { id: 'b', start: 18.0, end: 22.5, text: 'because we\'ve been on this little run, you know, between Rory Flynn (00:18) It\'s a run.' },
  { id: 'c', start: 282.1, end: 289.9, text: 'even though you\'re probably not gonna understand 90% of it. And so what I end up doing is like pausing the movie every five minutes.' },
  { id: 'd', start: 5833.2, end: 5840.0, text: 'will give you, I think, 15% off, something like that, if you want to sign up through that. So' },
  { id: 'e', start: 3204.4, end: 3210.3, text: 'Drew Brucker (53:24) It\'s gonna tell you how many credits it\'s Rory Flynn (53:27) Bang.' },
  { id: 'f', start: 611.0, end: 615.0, text: 'Game Boy Camera (10:11) is not a person.' },
  { id: 'g', start: 194.9, end: 202.6, text: 'The short is Higgsfield gonna Higgsfield. So Rory Flynn (03:19) Yes. But other than that,' },
  { id: 'h', start: 300.0, end: 304.0, text: 'and then So Rory Flynn (05:00) said it again.' },
  { id: 'i', start: 100.0, end: 104.0, text: 'Click Open Settings (10:11) as shown in the chapter list.' },
  { id: 'j', start: 500.0, end: 504.0, text: 'Again, Open Settings (10:11) is a chapter, not a person.' },
];
const source: WatchSource = { videoId: 'N-tmQ_Can_o', title: 'Public podcast fixture', language: 'en', sourceKind: 'manual', trackId: 'taiwan-register-fixture', cues };
const envelope = (text: string) => Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ text }) } });
async function mockLocal(fetcher: typeof fetch, run: () => Promise<void>) {
  const oldFetch = globalThis.fetch, oldMode = process.env.WATCH_PROCESSING_MODE, oldModel = process.env.WATCH_LOCAL_MODEL;
  try {
    process.env.WATCH_PROCESSING_MODE = 'local'; process.env.WATCH_LOCAL_MODEL = 'qwen2.5:7b';
    globalThis.fetch = async (url, init) => { assert.equal(url, 'http://127.0.0.1:11434/api/chat'); return fetcher(url, init); };
    await run();
  } finally {
    globalThis.fetch = oldFetch;
    if (oldMode === undefined) delete process.env.WATCH_PROCESSING_MODE; else process.env.WATCH_PROCESSING_MODE = oldMode;
    if (oldModel === undefined) delete process.env.WATCH_LOCAL_MODEL; else process.env.WATCH_LOCAL_MODEL = oldModel;
  }
}

test('speaker labels observed at least twice become session keep terms without touching the user glossary', () => {
  assert.deepEqual(speakerNames(source), ['Rory Flynn', 'Drew Brucker'], 'a single Game Boy Camera label is not a speaker, and "So Rory Flynn" folds into Rory Flynn');
  assert.deepEqual(speakerNames({ cues: [cues[6], cues[7]] }), ['Rory Flynn'], 'a capitalized sentence opener is never part of the name');
  assert.deepEqual(speakerNames({ cues: [cues[8], cues[9]] }), [], 'a repeated label whose clock lies outside its cue is a chapter or UI label, not a speaker');
  assert.deepEqual(speakerNames({ cues: [{ ...cues[0], start: 900, end: 904 }, { ...cues[0], id: 'a2', start: 950, end: 954 }] }), [], 'the clock must fall inside the cue that carries the label');
  const withNames = withSpeakerNames(source, glossary);
  assert.deepEqual(withNames.no_translate_terms, ['Rory Flynn', 'Drew Brucker', 'Flux']);
  assert.deepEqual(glossary.no_translate_terms, ['Flux'], 'input glossary is not mutated');
  assert.deepEqual(withSpeakerNames(source, { ...glossary, no_translate_terms: ['rory flynn'] }).no_translate_terms, ['Drew Brucker', 'rory flynn'], 'explicit user spelling wins');
  const cloud = JSON.parse(buildWatchTranslationMessages({ source, targets: [cues[1]], before: [], after: [], glossary })[1].content);
  assert.deepEqual(cloud.glossary.no_translate_terms, ['Rory Flynn'], 'cloud prompt lists only names present in the window');
});

test('interjections are never grammar-allowed English and count as untranslated', async () => {
  await mockLocal(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const pattern = new RegExp(body.format.properties.text.pattern);
    assert(pattern.test('Drew Brucker（27:13）對。'));
    assert(!pattern.test('Drew Brucker（27:13）Yeah。'), 'Yeah cannot be generated');
    assert(!pattern.test('Dude，對。'));
    assert.match(body.messages[0].content, /never Mainland China wording/);
    assert.match(body.messages[0].content, /Keep every Arabic number/);
    return envelope('Drew Brucker（27:13）對。');
  }, async () => { await requestLocalCue({ cue: cues[0], glossary: withSpeakerNames(source, glossary), model: 'qwen2.5:7b', signal: new AbortController().signal }); });
  assert.deepEqual(untranslatedLocalWords('Drew Brucker（27:13）Yeah。', cues[0], withSpeakerNames(source, glossary)), ['yeah']);
  assert.deepEqual(untranslatedLocalWords('Drew Brucker（27:13）對。', cues[0], withSpeakerNames(source, glossary)), []);
});

test('missing source numbers are detected digit-for-digit, including percent signs and timestamps', () => {
  assert.deepEqual(missingSourceNumbers('即使你可能只會理解其中的10%。', cues[2]), ['90%']);
  assert.deepEqual(missingSourceNumbers('即使你可能只會理解其中的 90%。', cues[2]), []);
  assert.deepEqual(missingSourceNumbers('會給你打九五折，大約就是這樣', cues[3]), ['15%']);
  assert.deepEqual(missingSourceNumbers('會便宜 15%，大約就是這樣', cues[3]), []);
  assert.deepEqual(missingSourceNumbers('Drew Brucker（27:13）對。', cues[0]), []);
  assert.deepEqual(missingSourceNumbers('Drew Brucker 對。', cues[0]), ['27:13']);
  assert.deepEqual(missingSourceNumbers('理解其中的 ９０％', cues[2]), [], 'full-width digits are normalized before comparison');
  assert.deepEqual(missingSourceNumbers('理解其中的 190%', cues[2]), ['90%'], 'a longer number does not satisfy a shorter one');
  assert.deepEqual(missingSourceNumbers('2023 年的電影', { text: '2023, 2023 movie.' }), ['2023'], 'a number said twice must appear twice');
  assert.deepEqual(missingSourceNumbers('2023 年，2023 年的電影', { text: '2023, 2023 movie.' }), []);
});

test('a user keep term that also labels speech stays mandatory, and a label-only cue is kept without inference', async () => {
  const userGlossary: Glossary = { ...glossary, no_translate_terms: ['Rory Flynn', 'Flux'] };
  let calls = 0;
  await mockLocal(async () => { calls++; return envelope('因為我們剛好在這段小連勝中，羅瑞．Flynn（00:18）這是連勝。'); }, async () => {
    await assert.rejects(translateWatchWindow({ source, targets: [cues[1]], before: [], after: [], glossary: userGlossary }), { code: 'LOCAL_TRANSLATION_QUALITY' });
    assert.equal(calls, 2, 'the user-listed name is repaired once and then rejected like any keep term');
  });
  calls = 0;
  const label: WatchCue = { id: 'label', start: 18.0, end: 19.2, text: 'Rory Flynn (00:18)' };
  await mockLocal(async () => { calls++; return envelope('Rory Flynn（00:18）'); }, async () => {
    const result = await translateWatchWindow({ source, targets: [label], before: [], after: [], glossary });
    assert.equal(calls, 0, 'nothing to translate: no model call');
    assert.equal(result[0].text, 'Rory Flynn (00:18)');
    assert.equal(result[0].originalText, label.text);
  });
});

test('a lost number uses the single repair with a number-specific instruction, and a second miss does not stall the batch', async () => {
  const prompts: string[] = []; const outputs = ['即使你可能只會理解其中的10%。', '即使你可能只會理解其中的 90%。'];
  await mockLocal(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); prompts.push(body.messages[0].content);
    return envelope(outputs[prompts.length - 1]);
  }, async () => {
    const result = await translateWatchWindow({ source, targets: [cues[2]], before: [], after: [], glossary });
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[0], /dropped or changed these source numbers/);
    assert.match(prompts[1], /dropped or changed these source numbers \(data\): \["90%"\]/);
    assert.doesNotMatch(prompts[1], /left ordinary English untranslated/, 'a number-only repair must not claim English was left untranslated');
    assert.equal(result[0].text, '即使你可能只會理解其中的 90%。');
    assert.equal(result[0].originalText, cues[2].text);
  });
  let calls = 0;
  await mockLocal(async () => { calls++; return envelope('會給你打九五折，大約就是這樣'); }, async () => {
    const result = await translateWatchWindow({ source, targets: [cues[3]], before: [], after: [], glossary });
    assert.equal(calls, 2, 'exactly one repair, then the batch continues');
    assert.equal(result[0].text, '會給你打九五折，大約就是這樣');
  });
});

test('speaker names get one explicit repair but a transliterated speaker is still accepted; user names stay mandatory', async () => {
  const prompts: string[] = []; const outputs = ['羅瑞·Flynn（00:18）說這是連勝。', '因為我們剛好在這段小連勝中，你知道的，Rory Flynn（00:18）這是連勝。'];
  await mockLocal(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); prompts.push(body.messages[0].content);
    return envelope(outputs[prompts.length - 1]);
  }, async () => {
    const result = await translateWatchWindow({ source, targets: [cues[1]], before: [], after: [], glossary });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /"name":"Rory Flynn","occurrences":1/);
    assert.doesNotMatch(prompts[1], /left ordinary English untranslated/);
    assert.equal(result[0].text, outputs[1]);
  });
  let calls = 0;
  await mockLocal(async () => { calls++; return envelope('因為我們剛好在這段小連勝中，羅瑞．Flynn（00:18）這是連勝。'); }, async () => {
    const result = await translateWatchWindow({ source, targets: [cues[1]], before: [], after: [], glossary });
    assert.equal(calls, 2, 'one repair, then the speaker label is accepted as translated');
    assert.match(result[0].text, /羅瑞．Flynn/);
  });
  calls = 0;
  await mockLocal(async () => { calls++; return envelope('Rory Flynn（03:19）對。那短片就是希格斯場會希格斯場。'); }, async () => {
    await assert.rejects(translateWatchWindow({ source, targets: [cues[6]], before: [], after: [], glossary: { ...glossary, no_translate_terms: ['Higgsfield'] } }), { code: 'LOCAL_TRANSLATION_QUALITY' });
    assert.equal(calls, 2, 'a user keep term missing twice still fails after its single structured repair');
  });
  const message = localCueMessages(cues[4], withSpeakerNames(source, glossary))[1].content;
  assert.deepEqual(JSON.parse(message).glossary.keep, ['Drew Brucker', 'Rory Flynn']);
  assert.deepEqual(JSON.parse(message).glossary.preferred, [['credits', '點數']]);
});

test('curated Taiwan vocabulary rewrites Mainland wording but never protected names, quotes, preferred terms or ambiguous words', () => {
  const custom: Glossary = { no_translate_terms: ['信息 Studio'], term_map: [['data', '數據'], ['user', '用戶']], style_rules: [] };
  assert.equal(normalizeTaiwanSubtitle('这个软件的用户数据和默认程序质量很好，伙计，看视频吧', custom, toTaiwanTraditional), '這個軟體的用戶數據和預設程序品質很好，老兄，看影片吧', 'preferred 用戶 and ambiguous 數據/程序 stay');
  assert.equal(normalizeTaiwanSubtitle('信息 Studio 「信息」 你發信息給我，這集播客的人工智能，連接到節點', custom, toTaiwanTraditional), '信息 Studio 「信息」 你發訊息給我，這集Podcast的人工智慧，連接到節點', 'no phrase-table side effects such as 連接→連線');
  assert.equal(normalizeTaiwanSubtitle('視頻通話的分辨率、服務器的內存、數據庫的字段', { no_translate_terms: [], term_map: [], style_rules: [] }), '視訊通話的解析度、伺服器的記憶體、資料庫的欄位', 'longest key wins so 視頻通話 is not 影片通話');
  const cue = cues[1];
  const content = JSON.stringify({ cues: [{ id: cue.id, text: '你发信息给我说这个服务器的内存不够，伙计' }] });
  assert.equal(validateWatchTranslation(content, [cue], custom, { localTaiwan: true })[0].text, '你發訊息給我說這個伺服器的記憶體不夠，老兄');
  assert.equal(validateWatchTranslation(content, [cue], custom)[0].text, '你發信息給我說這個服務器的內存不夠，夥計', 'cloud validation keeps character-only conversion (伙 becomes the 夥 variant, vocabulary untouched)');
});
