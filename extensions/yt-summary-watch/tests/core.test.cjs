/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS tests for classic MV3 scripts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

test('server allowlist accepts only exact loopback HTTP origins', () => {
  assert.equal(core.serverOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(core.serverOrigin('http://localhost:3210/'), 'http://localhost:3210');
  for (const value of ['https://example.com', 'http://127.0.0.1.evil.test', 'http://evil@localhost:3000', 'http://localhost:3000/api', 'http://localhost:3000/?token=x', 'http://localhost:3000/#x', 'https://localhost:3000']) {
    assert.throws(() => core.serverOrigin(value), undefined, value);
  }
});
test('YouTube routes canonicalize video IDs and reject other surfaces', () => {
  assert.deepEqual(core.youtubeUrl('https://www.youtube.com/watch?v=kfbWz9_bJoA&t=22s'), { id: 'kfbWz9_bJoA', url: 'https://www.youtube.com/watch?v=kfbWz9_bJoA' });
  for (const url of ['https://www.youtube.com/shorts/kfbWz9_bJoA', 'https://youtube.com.evil/watch?v=kfbWz9_bJoA', 'https://www.youtube.com/watch?v=<script>', 'javascript:alert(1)', 'https://evil@youtube.com/watch?v=kfbWz9_bJoA']) assert.equal(core.youtubeUrl(url), null);
});
const cues = Array.from({ length: 24 }, (_, index) => ({ id: `c${index}`, start: index * 2, end: index * 2 + 1.5, text: `Source ${index}` }));
test('cue visibility preserves source start and exclusive end boundaries', () => {
  assert.deepEqual(core.currentCues(cues, 0).map(cue => cue.id), ['c0']);
  assert.deepEqual(core.currentCues(cues, 1.5), []);
  assert.deepEqual(core.currentCues(cues, 2).map(cue => cue.id), ['c1']);
  assert.deepEqual(core.currentCues(cues, 49), []);
});
test('8-cue batches, prefetch and seeking do not produce per-second requests', () => {
  assert.deepEqual(core.nextRequest(cues, 2, new Set()), { key: '0', time: 2 });
  assert.equal(core.nextRequest(cues, 2, new Set(['0'])).key, '1');
  assert.equal(core.nextRequest(cues, 2, new Set(['0', '1'])), null);
  assert.equal(core.nextRequest(cues, 34, new Set(['0', '1'])).key, '2');
  assert.equal(core.nextRequest(cues, 5, new Set(['0', '1', '2'])), null);
  assert.equal(core.nextRequest(cues, 50, new Set()), null);
});
test('prefetch does not leap more than 30 seconds to the next batch', () => {
  const sparse = cues.map(cue => ({ ...cue, start: cue.start * 10, end: cue.end * 10 }));
  assert.equal(core.nextRequest(sparse, 0, new Set(['0'])), null);
  assert.equal(core.nextRequest(sparse, 135, new Set(['0'])).key, '1');
});
test('default off, opt-in only and cloud maximum batch preference clamp', () => {
  const defaults = core.boundedSettings();
  assert.equal(defaults.enabled, false); assert.equal(defaults.consent, false); assert.equal(defaults.autoMode, false);
  assert.equal(core.boundedSettings({ enabled: 'true', consent: 1 }).enabled, false);
  assert.equal(core.boundedSettings({ maxBatches: 999 }).maxBatches, 50);
  assert.equal(core.boundedSettings({ maxBatches: -2 }).maxBatches, 1);
  assert.equal(core.boundedSettings({ mode: 'injected' }).mode, 'bilingual');
});


test('server-confirmed local unlimited ignores legacy 10/50 limits; cloud never does', () => {
  const local = { processingMode: 'local', unlimited: true, limits: { sessionCalls: null, dailyCalls: null } };
  for (const preference of [10, 50]) {
    assert.equal(core.translationLimit(local, preference), null);
    assert.equal(core.limitReached(local, 11, preference), false);
    assert.equal(core.limitReached(local, 51, preference), false);
    assert.equal(core.limitReached(local, 10000, preference), false);
    const cloud = { ...local, processingMode: 'cloud' };
    assert.equal(core.translationLimit(cloud, preference), preference);
    assert.equal(core.limitReached(cloud, preference, preference), true);
  }
  assert.equal(core.translationLimit({ processingMode: 'local', sessionLimit: null }, 10), null);
  assert.equal(core.translationLimit({ processingMode: 'cloud', limits: { sessionCalls: 2 } }, 10), 2);
});

test('display-only caption pages preserve every original character, names and graphemes', () => {
  const fixtures = [
    '這是一段完整字幕。',
    '保留所有原文意思、否定、數量和專業術語，不摘要也不省略。'.repeat(6),
    'Compare OpenArt, Runway Gen-4, Kling, Luma, Pixel Dance and Jimeng. This complete explanation must remain in the original sequence. '.repeat(3),
    'a'.repeat(170),
    '  第一行\n第二行\r\n\tOpen Art  Pixel Dance。\n',
    `${'甲'.repeat(31)}e\u0301 👩🏽‍💻🌿`,
  ];
  for (const text of fixtures) {
    const pages = core.splitCaptionPages(text);
    assert.equal(pages.map(page => page.text).join(''), text, 'exact full-text round trip');
    assert.ok(pages.every(page => page.lines.length <= 2));
    assert.ok(pages.every(page => !/^\p{Mark}/u.test(page.text)), 'never detach a combining mark');
  }
  const names = core.splitCaptionPages('Use Open Art and Pixel Dance to create a video, then compare the full result in Runway.');
  assert.ok(names.some(page => page.text.includes('Pixel Dance')));
  const at823 = '在OpenArt或Higgsfield。現在讓我把這件事簡短地向你展示一下，什麼是';
  const balanced = core.splitCaptionPages(at823);
  assert.equal(balanced.map(page => page.text).join(''), at823);
  assert.ok(balanced.some(page => page.text.includes('什麼')));
  assert.ok(balanced.every(page => page.weight >= 4 && page.weight <= 32 + 1e-8));
  assert.ok(balanced.every(page => page.text.trim() !== '麼是'));
  assert.equal(core.splitCaptionPages('').length, 0);
});

test('caption pages follow only the original cue clock: pause stable, seek reversible, dense flagged', () => {
  const text = '完整的翻譯內容必須依序呈現，不可跳過任何片段。'.repeat(5);
  const pages = core.splitCaptionPages(text); const sum = pages.reduce((total, page) => total + page.weight, 0);
  let before = 0;
  for (let index = 0; index < pages.length; index++) {
    const time = 482 + 24 * (before + pages[index].weight / 2) / sum;
    const selected = core.selectCaptionPage(pages, { start: 482, end: 506, time });
    assert.equal(selected.index, index); assert.equal(selected.page.text, pages[index].text);
    assert.deepEqual(core.selectCaptionPage(pages, { start: 482, end: 506, time }), selected);
    before += pages[index].weight;
  }
  assert.equal(core.selectCaptionPage(pages, { start: 482, end: 506, time: 482 }).index, 0);
  assert.equal(core.selectCaptionPage(pages, { start: 482, end: 506, time: 505.999 }).index, pages.length - 1);
  assert.equal(core.selectCaptionPage(pages, { start: 0, end: 0.5, time: 0.2 }).dense, true);
  assert.equal(core.selectCaptionPage(pages, { time: 99 }).timingKnown, false);
});

test('classic extension helpers stay behavior-identical to the /watch TypeScript implementation', () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
  const source = fs.readFileSync(path.join(__dirname, '../../../lib/watch/caption-pages.ts'), 'utf8');
  const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {}; vm.runInNewContext(script, { exports: exported, Intl });
  const normalize = value => JSON.parse(JSON.stringify(value));
  for (const text of ['短字幕。', '完整翻譯不可摘要，OpenArt / Pixel Dance / Jimeng 保持英文。'.repeat(5), ' English  whitespace\n中文\r\n👩🏽‍💻e\u0301  ']) {
    for (const options of [{}, { lineUnits: 16, pageUnits: 32 }, { lineUnits: 34, pageUnits: 32 }]) {
      const pages = core.splitCaptionPages(text, options);
      assert.deepEqual(pages, normalize(exported.splitCaptionPages(text, options)));
      for (const time of [481, 482, 490, 505.999, 506]) {
        const input = { start: 482, end: 506, time };
        assert.deepEqual(core.selectCaptionPage(pages, input), normalize(exported.selectCaptionPage(pages, input)));
      }
    }
  }
});
