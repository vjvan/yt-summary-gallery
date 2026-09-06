import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captionTextWeight, selectCaptionPage, splitCaptionPages } from '../lib/watch/caption-pages';

const original = 'want to see what is possible right now, what kinds of videos and images you want to create then this is definitely not';
const translated = '想看看現在能做到什麼，以及自己想創作哪些類型的影片和圖片，那麼這絕對不';

test('all pages reconstruct exact original words, punctuation and whitespace without summarizing', () => {
  for (const text of [original, translated, '  Figma Weave、OpenArt 和 Higgsfield！\n第二行\r\n  最後一行。  ', '甲'.repeat(1000), '\n\n  \t']) {
    for (const lineUnits of [8, 16, 22, 34]) {
      const pages = splitCaptionPages(text, { lineUnits, pageUnits: Math.min(32, lineUnits * 2) });
      assert.equal(pages.map(page => page.text).join(''), text);
      for (const page of pages) {
        assert.equal(page.lines.join(''), page.text);
        assert.ok(page.lines.length > 0 && page.lines.length <= 2);
        assert.ok(Number.isFinite(page.weight) && page.weight >= 0);
      }
    }
  }
});

test('shorter display pages preserve the long 8:02 subtitle rather than shorten its meaning', () => {
  const zh = splitCaptionPages(translated);
  const en = splitCaptionPages(original, { lineUnits: 30 });
  assert.ok(zh.length >= 2);
  assert.ok(en.length >= 2);
  assert.equal(zh.map(page => page.text).join(''), translated);
  assert.equal(en.map(page => page.text).join(''), original);
  assert.ok(zh[0].text.length < translated.length);
  assert.ok(en[0].text.length < original.length);
});

test('actual 8:02 and 8:23 bilingual fixtures balance pages without orphaning the final words', () => {
  const fixtures = [
    { time: '8:02', source: original, translation: '想看看現在能創造什麼樣的影片和圖像，如果你想要創建什麼樣的內容，這絕對不是' },
    { time: '8:23', source: 'in open art or Higgs Field. And now let me show you very briefly what is', translation: '在OpenArt或Higgsfield。現在讓我把這件事簡短地向你展示一下，什麼是' },
  ];
  for (const fixture of fixtures) {
    for (const text of [fixture.source, fixture.translation]) {
      for (const options of [{ lineUnits: 22, pageUnits: 32 }, { lineUnits: 16, pageUnits: 32 }, { lineUnits: 10, pageUnits: 10, maxLines: 1 }]) {
        const pages = splitCaptionPages(text, options);
        assert.equal(pages.map(page => page.text).join(''), text, fixture.time);
        assert.ok(pages.length > 1);
        assert.ok(pages.every(page => page.weight <= options.pageUnits + 1e-8));
        assert.ok(pages.every(page => page.lines.length <= (options.maxLines || 2)));
        assert.ok(pages.every(page => page.lines.every(line => captionTextWeight(line) <= options.lineUnits + 1e-8)));
        assert.ok(pages[pages.length - 1].weight >= 4, `${fixture.time}: no two-character orphan page`);
        if (text.includes('什麼')) {
          assert.ok(pages.some(page => page.text.includes('什麼')));
          assert.ok(pages.every(page => !page.text.endsWith('什') && !page.text.startsWith('麼')));
        }
      }
    }
  }
  const zh823 = splitCaptionPages(fixtures[1].translation);
  assert.deepEqual(zh823.map(page => page.text), ['在OpenArt或Higgsfield。', '現在讓我把這件事簡短地向你展示一下，什麼是']);
  assert.ok(Math.max(...zh823.map(page => page.weight)) / Math.min(...zh823.map(page => page.weight)) < 2);
});

test('near-capacity text balances final pages and never exceeds limits to attach punctuation', () => {
  for (const text of ['甲'.repeat(33), '甲'.repeat(31) + '，乙丙丁。', '什麼樣的內容，現在能夠做到什麼？'.repeat(4)]) {
    const pages = splitCaptionPages(text);
    assert.equal(pages.map(page => page.text).join(''), text);
    assert.ok(pages.every(page => page.weight <= 32 + 1e-8));
    assert.ok(pages.every(page => page.lines.every(line => captionTextWeight(line) <= 22 + 1e-8)));
    assert.ok(pages[pages.length - 1].weight >= 4);
  }
  const pages = splitCaptionPages('甲'.repeat(33));
  assert.equal(pages.length, 2);
  assert.ok(Math.abs(pages[0].weight - pages[1].weight) <= 1);
});

test('English platform words and fitting title-case names remain intact at page boundaries', () => {
  for (const name of ['Higgsfield', 'OpenArt', 'Figma Weave', 'Nano Banana Pro', 'GPT-4o-mini', 'get_user_name']) {
    const text = `${'甲'.repeat(27)} ${name}，完整保留。`;
    const pages = splitCaptionPages(text);
    assert.ok(pages.some(page => page.text.includes(name)), `${name} should stay in one page`);
    assert.equal(pages.map(page => page.text).join(''), text);
  }
});

test('overlong technical identifiers are split only as needed without dropping characters', () => {
  const identifier = 'OpenAICompatibleAudioTranscriptionAdapter'.repeat(6);
  const pages = splitCaptionPages(identifier, { lineUnits: 12, pageUnits: 24 });
  assert.ok(pages.length > 1);
  assert.equal(pages.map(page => page.text).join(''), identifier);
  assert.ok(pages.every(page => page.lines.length <= 2));
  assert.ok(pages.every(page => page.text.length > 0));
});

test('decomposed accents and emoji graphemes never become detached at a page edge', () => {
  for (const text of [`${'甲'.repeat(31)}e\u0301`, `${'甲'.repeat(29)}Cafe\u0301`, `${'甲'.repeat(31)}1️⃣`, `${'甲'.repeat(31)}👩🏽‍💻`]) {
    const pages = splitCaptionPages(text);
    assert.equal(pages.map(page => page.text).join(''), text);
    for (const page of pages) {
      assert.doesNotMatch(page.text, /^\p{Mark}/u);
      for (const line of page.lines) assert.doesNotMatch(line, /^\p{Mark}/u);
    }
    if (text.includes('e\u0301')) assert.ok(pages.some(page => page.text.includes('e\u0301')));
    if (text.includes('1️⃣')) assert.ok(pages.some(page => page.text.includes('1️⃣')));
    if (text.includes('👩🏽‍💻')) assert.ok(pages.some(page => page.text.includes('👩🏽‍💻')));
  }
});

test('time zero, invalid clocks and missing or zero-length cue intervals are safe', () => {
  const pages = splitCaptionPages('一二三四五六七八', { lineUnits: 4, pageUnits: 4 });
  assert.equal(selectCaptionPage(pages, { start: 0, end: 4, time: 0 }).index, 0);
  for (const time of [NaN, Infinity, -Infinity, -5]) assert.equal(selectCaptionPage(pages, { start: 0, end: 4, time }).index, 0);
  for (const input of [{ start: 0, end: 0 }, { start: NaN, end: 4 }, { start: 0, end: Infinity }, { start: -1, end: 4 }, {}]) {
    const selected = selectCaptionPage(pages, { ...input, time: 100 });
    assert.equal(selected.index, 0); assert.equal(selected.timingKnown, false);
    assert.equal(selected.dense, true);
  }
  assert.deepEqual(splitCaptionPages(''), []);
  assert.equal(selectCaptionPage([], { time: NaN }).page, null);
});

test('pause is stable and forward/backward seeks recompute from source cue time', () => {
  const pages = splitCaptionPages('一二三四五六七八', { lineUnits: 4, pageUnits: 4 });
  const at = (time: number) => selectCaptionPage(pages, { start: 10, end: 14, time });
  assert.equal(at(10).index, 0);
  assert.equal(at(11.99).index, 0);
  assert.equal(at(12).index, 1);
  assert.equal(at(100).index, 1);
  assert.equal(at(10.5).index, 0);
  for (let frame = 0; frame < 100; frame++) assert.equal(at(12.4).index, 1, 'no independent timer may advance paused pages');
});

test('bilingual selections are independent but deterministic at the same cue time and across mode switches', () => {
  const zh = splitCaptionPages(translated);
  const en = splitCaptionPages(original, { lineUnits: 30 });
  const at = { start: 482.12, end: 488.04, time: 486 };
  const expected = { zh: selectCaptionPage(zh, at), en: selectCaptionPage(en, at) };
  for (const mode of ['translated', 'original', 'bilingual', 'off', 'bilingual']) {
    assert.ok(mode);
    assert.deepEqual(selectCaptionPage(zh, at), expected.zh);
    assert.deepEqual(selectCaptionPage(en, at), expected.en);
  }
});

test('extremely short dense cues are flagged, never truncated or assigned new timing', () => {
  const pages = splitCaptionPages(translated);
  const input = { start: 482.12, end: 482.22, time: 482.17 };
  const selected = selectCaptionPage(pages, input);
  assert.equal(selected.dense, true);
  assert.equal(pages.map(page => page.text).join(''), translated);
  assert.deepEqual(input, { start: 482.12, end: 482.22, time: 482.17 });
  assert.equal(selectCaptionPage(pages, { start: 0, end: 100, time: 30 }).dense, false);
});

test('weights, narrow widths and invalid options remain bounded and lossless', () => {
  assert.equal(captionTextWeight('中'), 1);
  assert.ok(captionTextWeight('a') < captionTextWeight('中'));
  assert.equal(captionTextWeight('👩🏽‍💻'), 1);
  assert.equal(captionTextWeight('e\u0301'), 1);
  for (const options of [{ lineUnits: NaN, pageUnits: Infinity }, { lineUnits: 0, maxLines: 0 }, { lineUnits: 15, pageUnits: 30 }, { maxLines: 100 }]) {
    const pages = splitCaptionPages(original + translated, options);
    assert.equal(pages.map(page => page.text).join(''), original + translated);
    assert.ok(pages.every(page => page.lines.length <= 2));
  }
});

test('player uses original interval and display-only paging with complete manual transcript access', () => {
  const player = readFileSync(new URL('../components/WatchPlayer.tsx', import.meta.url), 'utf8');
  assert.match(player, /start: props\.cueStart, end: props\.cueEnd, time: props\.time/);
  assert.match(player, /selectCaptionPage\(translatedPages, interval\)/);
  assert.match(player, /selectCaptionPage\(originalPages, interval\)/);
  assert.match(player, /暫停看本句全文/);
  assert.match(player, /setFullCaption\(\{ original: props\.original, translated: props\.translated/);
  assert.doesNotMatch(player, /line-clamp|text-overflow|textOverflow|ellipsis|setPlaybackRate/);
});
