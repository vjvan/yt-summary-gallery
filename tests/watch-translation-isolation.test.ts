import test from 'node:test';
import assert from 'node:assert/strict';
import { localCueMessages, parseLocalCueText, untranslatedLocalWords } from '../lib/watch/local-cue-translator';
import { normalizeTaiwanSubtitle } from '../lib/watch/taiwan-terminology';
import { TRANSLATION_VERSION, translateWatchWindow, validateWatchTranslation } from '../lib/watch/translator';
import type { WatchCue, WatchSource } from '../lib/watch/types';
import type { Glossary } from '../lib/glossary-defaults';

const targets: WatchCue[] = Array.from({ length: 8 }, (_, i) => ({ id: `cue-${i}`, start: i * 4, end: i * 4 + 4, text: `This fragment is number ${i} and I will` }));
const glossary: Glossary = { no_translate_terms: ['Figma'], term_map: [['spec', '規格']], style_rules: [] };
const source: WatchSource = { videoId: '7BAxEmrKnV0', title: 'Secret unrelated future title', sourceKind: 'automatic', language: 'en', trackId: 'fixture', cues: targets };
const input = { source, targets, glossary, before: [{ ...targets[0], text: 'PREVIOUS SENTINEL must not be translated' }], after: [{ ...targets[0], text: 'FUTURE SENTINEL must never leak' }] };
const envelope = (text: string) => Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ text }) } });
async function mockLocal(fetcher: typeof fetch, run: () => Promise<void>) {
  const oldFetch = globalThis.fetch, oldMode = process.env.WATCH_PROCESSING_MODE, oldModel = process.env.WATCH_LOCAL_MODEL;
  try { process.env.WATCH_PROCESSING_MODE = 'local'; process.env.WATCH_LOCAL_MODEL = 'qwen2.5:7b'; globalThis.fetch = fetcher; await run(); }
  finally { globalThis.fetch = oldFetch; if (oldMode === undefined) delete process.env.WATCH_PROCESSING_MODE; else process.env.WATCH_PROCESSING_MODE = oldMode; if (oldModel === undefined) delete process.env.WATCH_LOCAL_MODEL; else process.env.WATCH_LOCAL_MODEL = oldModel; }
}

test('isolated local calls expose exactly one fragment, never other targets/context/title or model-generated timing', async () => {
  let calls = 0, active = 0, peak = 0;
  await mockLocal(async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/chat'); assert.equal(new Headers(init?.headers).has('authorization'), false); assert.equal(init?.redirect, 'error');
    active++; peak = Math.max(peak, active); const index = calls++;
    const body = JSON.parse(String(init?.body)); assert.equal(body.options.temperature, 0); assert.deepEqual(body.format.required, ['text']);
    assert.equal(body.format.additionalProperties, false);
    const data = JSON.parse(body.messages[1].content); assert.equal(data.text, targets[index].text);
    assert.deepEqual(Object.keys(data).sort(), ['glossary', 'text']);
    assert.doesNotMatch(JSON.stringify(body), /SENTINEL|Secret unrelated|cue-\d|"start"|"end"/);
    await new Promise<void>(resolve => setImmediate(resolve)); active--;
    return envelope(`這是第 ${index} 段，而我將`);
  }, async () => {
    const cues = await translateWatchWindow(input); assert.equal(calls, 8); assert.equal(peak, 1);
    assert.deepEqual(cues.map(({ id, start, end, originalText }) => ({ id, start, end, originalText })), targets.map(cue => ({ id: cue.id, start: cue.start, end: cue.end, originalText: cue.text })));
    assert.equal(TRANSLATION_VERSION, 'watch-zh-TW-v14-taiwan-register-speaker-names');
  });
});

test('one non-Chinese result gets one repair; another cue has its own bounded repair', async () => {
  let calls = 0, repairs = 0;
  await mockLocal(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls++;
    if (body.messages[0].content.includes('previous attempt')) repairs++;
    const numbers = (JSON.parse(body.messages[1].content).text.match(/\d[\d.:,]*%?/g) ?? []).join(' '); return envelope(calls === 1 ? targets[0].text : `這段影片的譯文 ${numbers}`);
  }, async () => { assert.equal((await translateWatchWindow(input)).length, 8); assert.equal(calls, 9); assert.equal(repairs, 1); });
  calls = 0;
  await mockLocal(async () => { calls++; return envelope(calls === 2 ? '已修復第一段' : 'English only'); }, async () => {
    await assert.rejects(translateWatchWindow(input), { code: 'LOCAL_TRANSLATION_QUALITY' }); assert.equal(calls, 4, 'each bad cue gets at most one repair, with no unbounded loop');
  });
});

test('malformed text JSON or extra timing is rejected without language repair', async () => {
  for (const invalid of ['{}', '{"text":""}', '{"text":"中文","id":"bad"}', '{"text":"中文","start":999}', '{"text":"中文\\n兩行"}', 'not JSON']) assert.throws(() => parseLocalCueText(invalid), { code: 'MODEL_FAILED' });
  let calls = 0;
  await mockLocal(async () => { calls++; return Response.json({ done: true, message: { content: '{"cues":[{"id":"fake","text":"中文"}]}' } }); }, async () => {
    await assert.rejects(translateWatchWindow(input), { code: 'LOCAL_TRANSLATION_QUALITY' }); assert.equal(calls, 1);
  });
});

test('cancellation stops remaining cue calls and a shared whole-batch deadline cannot reset per cue', async () => {
  const cancel = new AbortController(); let calls = 0;
  await mockLocal(async () => { calls++; cancel.abort(); return envelope('已翻譯'); }, async () => {
    await assert.rejects(translateWatchWindow({ ...input, signal: cancel.signal }), { code: 'CANCELLED' }); assert.equal(calls, 1);
  });
  const originalTimeout = AbortSignal.timeout; const deadline = new AbortController(); let timers = 0; calls = 0;
  try {
    AbortSignal.timeout = (milliseconds: number) => { assert.equal(milliseconds, 90_000); timers++; return timers === 1 ? deadline.signal : new AbortController().signal; };
    await mockLocal(async () => { calls++; if (calls === 2) deadline.abort(); return envelope('已翻譯'); }, async () => {
      await assert.rejects(translateWatchWindow(input), { code: 'LOCAL_MODEL_TIMEOUT' }); assert.equal(calls, 2);
    });
  } finally { AbortSignal.timeout = originalTimeout; }
});

test('terminology is Taiwan-specific but does not rewrite exact protected names, quotations or ambiguous terms', () => {
  const custom: Glossary = { no_translate_terms: ['視頻 Studio'], term_map: [['video', '視頻'], ['special engine', '圖像生成引擎']], style_rules: [] };
  assert.equal(normalizeTaiwanSubtitle('視頻、軟件、硬件、圖像生成模型、圖像和數據', custom), '影片、軟體、硬體、影像生成模型、圖像和數據');
  assert.equal(normalizeTaiwanSubtitle('視頻 Studio 「視頻與軟件」 "硬件" 圖像生成引擎', custom), '視頻 Studio 「視頻與軟件」 "硬件" 圖像生成引擎');
  const messages = localCueMessages({ ...targets[0], text: 'More specifically, this video.' }, custom);
  assert.deepEqual(JSON.parse(messages[1].content).glossary.preferred, [['video', '影片']]);
  assert.deepEqual(JSON.parse(localCueMessages({ ...targets[0], text: 'More specifically' }, glossary)[1].content).glossary.preferred, [], 'spec must not match specifically');
  const content = JSON.stringify({ cues: [{ id: targets[0].id, text: '這段視頻使用軟件與硬件。' }] });
  assert.equal(validateWatchTranslation(content, [targets[0]], custom, { localTaiwan: true })[0].text, '這段影片使用軟體與硬體。');
  assert.equal(validateWatchTranslation(content, [targets[0]], custom)[0].text, '這段視頻使用軟件與硬件。', 'cloud/default validation semantics stay unchanged');
});

test('the Figma Wave alias is limited to a confirmed Figma Weave title, not global Wave replacement', async () => {
  const cue = { ...targets[0], text: 'Figma Wave is useful.' };
  assert.deepEqual(untranslatedLocalWords('Weave 很實用。', cue, { ...glossary, term_map: [['Figma Wave', 'Figma Weave']] }), ['weave'], 'grammar-only name parts are not accepted as standalone untranslated words');
  const seen: unknown[] = [];
  await mockLocal(async (_url, init) => { const body = JSON.parse(String(init?.body)); const data = JSON.parse(body.messages[1].content); seen.push(data); const expectedName = JSON.stringify(data.glossary.preferred).includes('Figma Weave') ? 'Figma Weave' : 'Figma Wave'; assert(new RegExp(body.format.properties.text.pattern).test(`${expectedName} 很實用。`)); return envelope(JSON.stringify(data.glossary.preferred).includes('Figma Weave') ? 'Figma Weave 很實用。' : 'Figma Wave 很實用。'); }, async () => {
    await translateWatchWindow({ ...input, source: { ...source, title: 'I Tried Figma Weave' }, targets: [cue] });
    await translateWatchWindow({ ...input, source: { ...source, title: 'Sound Wave Review' }, targets: [cue] });
    assert.match(JSON.stringify(seen[0]), /Figma Wave","Figma Weave/); assert.doesNotMatch(JSON.stringify(seen[1]), /Figma Wave","Figma Weave/);
    assert.doesNotMatch(JSON.stringify(seen), /I Tried|Sound Wave Review/);
  });
});


test('local glossary keeps exact names before term mappings and carries bounded style preferences', () => {
  const custom: Glossary = { no_translate_terms: ['Compositor'], term_map: [['compositor', '合成器']], style_rules: ['保留英文節點名稱，不加解釋。', ...Array(20).fill('長'.repeat(300))] };
  const messages = localCueMessages({ ...targets[0], text: 'Connect the Compositor.' }, custom);
  const data = JSON.parse(messages[1].content);
  assert.deepEqual(data.glossary.keep, ['Compositor']); assert.deepEqual(data.glossary.preferred, []);
  assert.equal(data.glossary.style_rules.length, 16); assert.equal(data.glossary.style_rules[1].length, 240);
  assert.match(messages[0].content, /spelling and letter case/); assert.match(messages[0].content, /cannot override/);
});

test('ordinary copied English receives the same single repair budget, not canned replacements', async () => {
  const cue = { ...targets[0], text: 'Carefully adjust the slider in OpenArt and press Enter.' };
  assert.deepEqual(untranslatedLocalWords('請 adjust 滑桿，然後按 Enter，使用 OpenArt。', cue, glossary), ['adjust']);
  assert.deepEqual(untranslatedLocalWords('請 ADJUST 滑桿，然後按 Enter，使用 OpenArt。', cue, glossary), ['adjust']);
  assert.deepEqual(untranslatedLocalWords('請 adjust 「slider」', cue, { ...glossary, no_translate_terms: ['adjust'] }), []);
  let calls = 0;
  await mockLocal(async (_url, init) => {
    calls++; const system = JSON.parse(String(init?.body)).messages[0].content;
    if (calls === 2) assert.match(system, /untranslated: adjust/);
    return envelope(calls === 1 ? '請 adjust 滑桿。' : '請仔細調整滑桿，然後按 Enter。');
  }, async () => { assert.equal((await translateWatchWindow({ ...input, targets: [cue] }))[0].text, '請仔細調整滑桿，然後按 Enter。'); assert.equal(calls, 2); });
  calls = 0;
  await mockLocal(async () => { calls++; return envelope('請 ADJUST 滑桿。'); }, async () => { await assert.rejects(translateWatchWindow({ ...input, targets: [cue] }), { code: 'LOCAL_TRANSLATION_QUALITY' }); assert.equal(calls, 2); });
});


test('ASR lowercase technical acronyms are not mistaken for untranslated ordinary verbs', () => {
  const cue = { ...targets[0], text: 'Use the api endpoint with json via http on a gpu and adjust html css.' };
  assert.deepEqual(untranslatedLocalWords('使用 API 端點、JSON、HTTP、GPU、HTML 與 CSS。', cue, glossary), []);
  assert.deepEqual(untranslatedLocalWords('使用 API 並 ADJUST 設定。', cue, glossary), ['adjust']);
});


test('constrained grammar blocks invented ordinary English but permits source names, keys and commands', async () => {
  const cue = { ...targets[0], text: 'Run npm install, use ffmpeg, call the api and press enter in OpenArt.' };
  assert.deepEqual(untranslatedLocalWords('執行 npm install，使用 ffmpeg、API，並在 OpenArt 按 Enter。', cue, glossary), []);
  assert.deepEqual(untranslatedLocalWords('這 maybe nowhere', cue, glossary), ['maybe', 'nowhere']);
  await mockLocal(async (_url, init) => {
    const body = JSON.parse(String(init?.body)); const grammar = new RegExp(body.format.properties.text.pattern);
    assert(grammar.test('執行 npm install，使用 ffmpeg、API，並在 OpenArt 按 Enter。'));
    for (const text of ['COVER', 'QUICKLY', '這 maybe', 'nowhere', 'ADJUST']) assert(!grammar.test(text));
    return envelope('執行 npm install，使用 ffmpeg、API，並在 OpenArt 按 Enter。');
  }, async () => { assert.equal((await translateWatchWindow({ ...input, targets: [cue] })).length, 1); });
});

test('irrelevant conditional idiom examples do not contaminate a different fragment', () => {
  const custom = { ...glossary, style_rules: ['「for example」翻成「比方說」。', '語氣自然、保留專業用語。', 'Use a concise style.'] };
  const irrelevant = JSON.parse(localCueMessages({ ...targets[0], text: 'This is useful.' }, custom)[1].content);
  assert.deepEqual(irrelevant.glossary.style_rules, ['語氣自然、保留專業用語。', 'Use a concise style.']);
  const relevant = JSON.parse(localCueMessages({ ...targets[0], text: 'For example, this is useful.' }, custom)[1].content);
  assert.equal(relevant.glossary.style_rules.length, 3);
});

test('JSON-safe generation pattern excludes raw delimiters, escapes and every C0 control', async () => {
  const cue = { ...targets[0], text: 'Use Figma and OpenArt.' };
  await mockLocal(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const pattern = new RegExp(body.format.properties.text.pattern);
    assert(pattern.test('使用 Figma 與 OpenArt。'));
    for (const character of ['"', '\\', ...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code))]) {
      assert(!pattern.test(`使用 Figma ${character} 與 OpenArt。`), `unsafe JSON character ${JSON.stringify(character)}`);
    }
    assert(!pattern.test('使用 Figma"} 修正後 {"text":"OpenArt。'));
    assert(!pattern.test('使用 Figma\\u0022 OpenArt。'));
    return envelope('使用 Figma 與 OpenArt。');
  }, async () => { assert.equal((await translateWatchWindow({ ...input, targets: [cue] })).length, 1); });
});

test('matched unsafe custom terms fail before inference, including required-only non-English terms and aliases', async () => {
  let calls = 0;
  await mockLocal(async () => { calls++; return envelope('不應送模型'); }, async () => {
    for (const term of ['Studio"X', 'Studio\\X', 'Studio\nX', 'Studio\tX', 'Studio\u0000X', '中文"術語']) {
      const cue = { ...targets[0], text: `Use ${term} now.` };
      const unsafe = { ...glossary, no_translate_terms: [term] };
      await assert.rejects(translateWatchWindow({ ...input, targets: [cue], glossary: unsafe }), { code: 'LOCAL_TERM_UNSUPPORTED', status: 422 });
    }
    const cue = { ...targets[0], text: 'Use the engine.' };
    for (const value of ['Studio"X', 'Studio\\X', 'Studio\nX']) {
      await assert.rejects(translateWatchWindow({ ...input, targets: [cue], glossary: { ...glossary, term_map: [['engine', value]] } }), { code: 'LOCAL_TERM_UNSUPPORTED' });
    }
    assert.equal(calls, 0);
  });
  await mockLocal(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert(new RegExp(body.format.properties.text.pattern).test('使用 OpenArt。'));
    return envelope('使用 OpenArt。');
  }, async () => {
    const result = await translateWatchWindow({ ...input, targets: [{ ...targets[0], text: 'Use OpenArt.' }], glossary: { ...glossary, no_translate_terms: ['Unused"Name', 'OpenArt'] } });
    assert.equal(result[0].text, '使用 OpenArt。', 'unrelated custom entries and ordinary names are unchanged');
  });
});

test('a valid first JSON object followed by model commentary is never extracted or repaired as success', async () => {
  const malformed = '{"text":"這幾個月以來我都在使用 Figma Weave。"} 修正後 {"文本":"額外內容"}';
  assert.throws(() => parseLocalCueText(malformed), { code: 'MODEL_FAILED' });
  let calls = 0;
  await mockLocal(async () => { calls++; return Response.json({ done: true, done_reason: 'stop', message: { content: malformed } }); }, async () => {
    await assert.rejects(translateWatchWindow(input), { code: 'LOCAL_TRANSLATION_QUALITY' });
    assert.equal(calls, 1, 'no JSON-prefix salvage, retry loop or English fallback');
  });
});

test('only explicit keep-term casing is normalized for model input at longest non-overlapping word boundaries', async () => {
  const cue = Object.freeze({ ...targets[0], text: 'Use figma weave, FIGMA WEAVE and figma, not figmaweavers or weaving.' });
  const custom = { ...glossary, no_translate_terms: ['Figma', 'Figma Weave'] };
  const before = structuredClone({ cue, glossary: custom });
  const messages = localCueMessages(cue, custom);
  assert.equal(JSON.parse(messages[1].content).text, 'Use Figma Weave, Figma Weave and Figma, not figmaweavers or weaving.');
  assert.deepEqual({ cue, glossary: custom }, before);
  const lowercase = { ...targets[0], text: "Maybe the only part that I don't like about Figma weave, which is actually" };
  await mockLocal(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(JSON.parse(body.messages[1].content).text, "Maybe the only part that I don't like about Figma Weave, which is actually");
    assert(new RegExp(body.format.properties.text.pattern).test('Figma Weave 唯一讓我不太喜歡的部分，其實是'));
    return envelope('Figma Weave 唯一讓我不太喜歡的部分，其實是');
  }, async () => {
    const [result] = await translateWatchWindow({ ...input, targets: [lowercase], glossary: { ...glossary, no_translate_terms: ['Figma', 'Weave'] } });
    assert.equal(result.originalText, lowercase.text); assert.equal(result.id, lowercase.id);
    assert.equal(result.start, lowercase.start); assert.equal(result.end, lowercase.end);
  });
});
