import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GLOSSARY } from '../lib/glossary-defaults';
import type { requestLocalTranslation } from '../lib/watch/local-translator';
import { chineseNumerals, distribute, mergeTinySpans, missingNumbers, numberMentions, parseReviewOutput, runSubtitleReview, sentenceItems, type ReviewPayload } from '../lib/review/pipeline';
import { splitWindowSentences } from '../lib/review/sentences';
import { buildReviewWindows, toReviewCues } from '../lib/review/windows';

// 2026-09-08 允雷回報的真實視窗（8:41 到 9:10）：v1 的候選整窗往後滑一句，最後一句翻的是 after 的內容。
const drift = toReviewCues([
  { start: 521.6, end: 526.3, text: '>> And it sounds like that for you was like this critical moment, especially early' },
  { start: 526.3, end: 534.0, text: 'on. Like imagine getting that experience early on in your 20s, Rory. Like I I didn\'t experience that till late 30s and' },
  { start: 534.0, end: 538.2, text: 'probably not even to that degree. I just can\'t imagine what that does for' },
  { start: 538.2, end: 542.6, text: 'you to energize you and kind of keep you pushing. Well, it actually does a bit of' },
  { start: 542.6, end: 548.3, text: 'both, you know, because I was 21 at the time and had just started to make' },
  { start: 548.3, end: 550.6, text: 'like 10K a month like live streaming.' },
  { start: 550.6, end: 554.4, text: 'And these live streams would pull in roughly around like anywhere between 2' },
], [
  { start: 521.6, end: 526.3, text: '>> 看起來對你來說那是一個關鍵時刻，特別是早期' },
  { start: 526.3, end: 534.0, text: '開。就像想像自己在二十多歲時就有這種經驗，羅瑞。像我直到三十多歲後才經歷到這種事，' },
  { start: 534.0, end: 538.2, text: '可能連那種程度都沒有。我真的無法想像那樣做會有什麼效果，' },
  { start: 538.2, end: 542.6, text: '讓你有精神，有點像在推你一下。其實它會稍微做一點' },
  { start: 542.6, end: 548.3, text: '兩者，你知道，因為當時我剛滿二十一大概才開始做' },
  { start: 548.3, end: 550.6, text: '像每個月10萬，像直播這樣' },
  { start: 550.6, end: 554.4, text: '這些直播大概會吸引到兩個人左右，大概在2' },
]);
const driftWindow = buildReviewWindows(drift)[0];

test('a window is cut into English sentences that map many-to-many onto cues', () => {
  assert.equal(driftWindow.cues.length, 6);
  const sentences = splitWindowSentences(driftWindow);
  assert.deepEqual(sentences.map(sentence => sentence.text), [
    'And it sounds like that for you was like this critical moment, especially early on.',
    'Like imagine getting that experience early on in your 20s, Rory.',
    'Like I I didn\'t experience that till late 30s and probably not even to that degree.',
    'I just can\'t imagine what that does for you to energize you and kind of keep you pushing.',
    'Well, it actually does a bit of both, you know, because I was 21 at the time and had just started to make like 10K a month like live streaming.',
  ]);
  assert.equal(sentences[0].marker, '>> ', 'the speaker-turn marker is kept aside, not sent to the model');
  assert.deepEqual(sentences[0].spans.map(span => span.position), [0, 1]);
  assert.deepEqual(sentences[4].spans.map(span => span.position), [3, 4, 5]);
  assert.ok(sentences.every(sentence => sentence.terminated));
  const abbreviations = splitWindowSentences({ cues: toReviewCues([{ start: 0, end: 1, text: 'Mr. Smith paid 3.5 dollars to J. Crew. Then he left.' }], null) });
  assert.deepEqual(abbreviations.map(sentence => sentence.text), ['Mr. Smith paid 3.5 dollars to J. Crew.', 'Then he left.']);
  const turn = splitWindowSentences({ cues: toReviewCues([{ start: 0, end: 1, text: 'Um, but yes >> Okay, wait. We\'ll pause.' }], null) });
  assert.deepEqual(turn.map(sentence => [sentence.text, sentence.marker, sentence.terminated]), [['Um, but yes', '', false], ['Okay, wait.', '>> ', true], ['We\'ll pause.', '', true]]);
  const cut = buildReviewWindows(toReviewCues([{ start: 0, end: 2, text: 'I was thinking that we' }, { start: 5, end: 7, text: 'should go now.' }], null));
  assert.equal(splitWindowSentences(cut[0])[0].terminated, false);
});

test('per-sentence translations land on the cues each sentence spans, so a leaked tail cannot shift the whole window', () => {
  const translations = [
    { n: 1, zh: '聽起來那對你來說是個關鍵時刻，特別是早期。' },
    { n: 2, zh: '想像一下在二十多歲就有那種經驗，Rory。' },
    { n: 3, zh: '像我直到三十多歲後段才經歷到，而且可能還沒到那種程度。' },
    { n: 4, zh: '我真的無法想像那對你有多大的激勵，讓你一直往前推。' },
    { n: 5, zh: '其實兩者都有，因為當時我二十一歲，才剛開始靠直播每個月賺到一萬左右。' },
  ];
  const parsed = parseReviewOutput({ translations }, driftWindow, drift, 'Test', DEFAULT_GLOSSARY);
  assert.equal(parsed.length, 6);
  assert.equal(parsed[0].candidate, '>> 聽起來那對你來說是個關鍵時刻，特別是早期。', 'the tiny "on." tail is merged back, so cue 1 keeps the whole first sentence with its >> marker');
  assert.ok(parsed[1].candidate.startsWith('想像一下在二十多歲就有那種經驗，Rory。像我直到'), parsed[1].candidate);
  assert.ok(parsed[2].candidate.startsWith('而且可能還沒到那種程度。我真的無法想像'), parsed[2].candidate);
  assert.ok(parsed[3].candidate.includes('往前推。') && parsed[3].candidate.includes('其實兩者都有'), parsed[3].candidate);
  assert.equal(parsed[4].candidate, '因為當時我二十一歲，', 'the wide punctuation search keeps 每個月 in one piece');
  assert.equal(parsed[5].candidate, '才剛開始靠直播每個月賺到一萬左右。', 'the last cue keeps the 10K sentence tail');
  assert.equal(parsed.join('').includes('undefined'), false);
  // 二十一與一萬都算保留了數字；20s、30s 也對得上二十、三十。
  assert.deepEqual(parsed.flatMap(item => item.notes.filter(note => note.startsWith('數字'))), []);
  // 每句的譯文合起來剛好是六個 cue 的候選（去掉 >> 標記），沒有掉字也沒有多字。
  assert.equal(parsed.map(item => item.candidate.replace(/^>> /, '')).join(''), translations.map(item => item.zh).join(''));
  // 第 5 句原文 140 字元；正常譯文約 35 字（比 0.25），把後文整句翻進來再加解釋會衝到 0.65 以上。
  const leaked = `${translations[4].zh}這些直播每晚大概能帶來兩到五千塊的收入，當時真的覺得很誇張，完全不敢相信自己這麼年輕就能賺到這種數字，老實說完全不知道該怎麼花。`;
  const long = parseReviewOutput({ translations: translations.map(item => item.n === 5 ? { ...item, zh: leaked } : item) }, driftWindow, drift, 'Test', DEFAULT_GLOSSARY);
  assert.ok(long[3].notes.some(note => note.includes('第 5 句譯文偏長')), JSON.stringify(long.map(item => item.notes)));
  assert.ok(parsed.every(item => item.notes.every(note => !note.includes('偏長'))), 'ordinary translations are not flagged');
  assert.ok(long[0].candidate.endsWith('特別是早期。'), 'a leaked tail in sentence 5 does not move sentence 1');
  assert.throws(() => parseReviewOutput({ translations: translations.slice(0, 4) }, driftWindow, drift, 'Test', DEFAULT_GLOSSARY), /句數或句序/);
  assert.throws(() => parseReviewOutput({ translations: translations.map(item => ({ ...item, n: 1 })) }, driftWindow, drift, 'Test', DEFAULT_GLOSSARY), /句數或句序/);
  assert.throws(() => parseReviewOutput({ translations: translations.map((item, index) => index === 2 ? { ...item, zh: '。' } : item) }, driftWindow, drift, 'Test', DEFAULT_GLOSSARY), /第 3 句譯文空白/);
  assert.equal(sentenceItems({ translations: [{ n: 2, zh: 'b' }, { n: 1, zh: 'a' }] }, 2)?.map(item => item.zh).join(''), 'ab', 'items are re-ordered by n');
  assert.equal(sentenceItems({ translations: [{ n: 1, zh: 'a' }, { n: 3, zh: 'c' }] }, 2), null);
});

test('tiny spans merge into a neighbour only when that cue is covered by another sentence; punctuation-only pieces fold back', () => {
  assert.deepEqual(mergeTinySpans([{ position: 0, weight: 76 }, { position: 1, weight: 3 }], [1, 2]), [{ position: 0, weight: 79 }]);
  assert.deepEqual(mergeTinySpans([{ position: 0, weight: 76 }, { position: 1, weight: 3 }], [1, 1]), [{ position: 0, weight: 76 }, { position: 1, weight: 3 }], 'cue 1 would otherwise be empty');
  assert.deepEqual(mergeTinySpans([{ position: 0, weight: 2 }, { position: 1, weight: 40 }], [2, 1]), [{ position: 1, weight: 42 }]);
  assert.deepEqual(mergeTinySpans([{ position: 0, weight: 30 }], [1]), [{ position: 0, weight: 30 }]);
  assert.deepEqual(distribute('第一段，第二段。', [50, 50]), ['第一段，', '第二段。']);
  assert.deepEqual(distribute('好。', [40, 1]), ['好。', '']);
});

test('the runner retries once on a sentence-count mismatch, then falls back to proportional splitting with a note', async () => {
  const calls: string[] = [];
  const bad = { translations: [{ n: 1, zh: '甲乙丙丁戊己庚辛壬癸。' }, { n: 1, zh: '壹貳參肆伍陸柒捌玖拾。' }] };
  const request: typeof requestLocalTranslation = async input => {
    calls.push(input.messages[0].content);
    const data = JSON.parse(input.messages[1].content) as ReviewPayload;
    if (calls.length === 1) return JSON.stringify(bad);
    if (calls.length === 2) return JSON.stringify(bad);
    return JSON.stringify({ translations: data.sentences.map(sentence => ({ n: sentence.n, zh: '一二三四五六七八九十。' })) });
  };
  const cues = toReviewCues([{ start: 0, end: 2, text: 'We like the first idea a lot.' }, { start: 2, end: 4, text: 'But the second one is cheaper.' }], null);
  const windows = buildReviewWindows(cues, { gapSeconds: 0 });
  const merged = { ...windows[0], key: 'w-0-1', cues };
  const deps = { model: 'm', request, signal: new AbortController().signal, glossary: DEFAULT_GLOSSARY, title: 'Test', sourceHash: 'h', load: () => undefined, save: () => {}, progress: () => {} };
  const result = await runSubtitleReview({ title: 'Test', cues, windows: [merged] }, deps);
  assert.equal(calls.length, 2, 'one retry, no third call');
  assert.match(calls[1], /必須回傳剛好 2 個 translations/);
  assert.equal(result.failedWindows.length, 0);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates[0].notes.some(note => note.includes('句界未對齊')), JSON.stringify(result.candidates[0].notes));
  assert.equal(result.candidates.map(item => item.candidate).join(''), '甲乙丙丁戊己庚辛壬癸。壹貳參肆伍陸柒捌玖拾。');
});

test('number guard accepts scaled, comma and Chinese forms and only reports numbers that really vanished', () => {
  assert.deepEqual(chineseNumerals(21), ['二十一']);
  assert.deepEqual(chineseNumerals(10), ['十']);
  assert.deepEqual(chineseNumerals(105), ['一百零五']);
  assert.deepEqual(chineseNumerals(2000), ['二千', '兩千']);
  assert.deepEqual(chineseNumerals(2.5), []);
  assert.deepEqual(numberMentions('like 10K a month').map(item => item.raw), ['10K']);
  assert.ok(numberMentions('10K').some(item => item.forms.includes('1萬') && item.forms.includes('一萬') && item.forms.includes('10000')));
  assert.deepEqual(missingNumbers('like 10K a month like live streaming.', '才剛開始靠直播每個月賺到一萬左右。'), []);
  assert.deepEqual(missingNumbers('it got like 50,000 likes', '有五萬個讚'), []);
  assert.deepEqual(missingNumbers('I was 21 at the time', '當時我二十一歲'), []);
  assert.deepEqual(missingNumbers('early on in your 20s', '在你二十多歲時'), []);
  assert.deepEqual(missingNumbers('he was like 5k', '他說五千英鎊'), []);
  assert.deepEqual(missingNumbers('£5,000 to make a video', '花 5,000 英鎊做一支影片'), []);
  assert.deepEqual(missingNumbers('about 2.5k a night', '一晚大概 2500'), []);
  assert.deepEqual(missingNumbers('grew 50% this year', '今年成長了百分之五十'), []);
  assert.deepEqual(missingNumbers('Yes, 100%.', '對啊，百分之百。'), []);
  assert.deepEqual(missingNumbers('making like 80 grand off of me', '靠我賺了八十萬'), ['80 grand'], '八十萬 is 800000, not 80000');
  assert.deepEqual(missingNumbers('we have 12 full-time employees', '我們有全職員工'), ['12']);
  assert.deepEqual(missingNumbers('in 10 minutes', '十分鐘內'), [], 'minutes is not a magnitude suffix');
  assert.deepEqual(missingNumbers('between 350 to 600k a month', '一個月 35 萬到 60 萬'), [], 'a range shares the trailing magnitude');
  assert.deepEqual(missingNumbers('2 to 5 grand a night', '一晚 2 到 5 千'), []);
  assert.deepEqual(missingNumbers('gave me 14 grand', '給了我 1 萬 4'), [], 'spoken 1萬4 is 14000');
  assert.deepEqual(missingNumbers('consulting for 15 grand', '1 萬 5 千美金的顧問案'), []);
  assert.deepEqual(missingNumbers('for 2 months', '痛恨了兩個月'), [], '兩 is 2');
  assert.deepEqual(chineseNumerals(2), ['二', '兩']);
  assert.deepEqual(missingNumbers('between 350 to 600k a month', '一個月 3 萬 5 到 60 萬'), ['350']);
  // 同一句裡 5k 與 £5,000 各要有自己的數字：譯文只有一個「五千」代表 £5,000 被翻成了五萬（2026-09-08 7B 實測輸出）。
  assert.deepEqual(missingNumbers('he was like 5k and I was like, what do you mean £5,000 to make a video?', '他說要五千英鎊，我當時想，拍個影片要五萬英鎊？'), ['5,000']);
  assert.deepEqual(missingNumbers('he was like 5k and I was like, what do you mean £5,000 to make a video?', '他說要五千英鎊，我當時想，拍個影片要五千英鎊？'), []);
  assert.deepEqual(missingNumbers('10 or 10K', '10 或 1萬'), []);
  assert.deepEqual(missingNumbers('10K', '10,000'), []);
  const money = toReviewCues([
    { start: 0, end: 4, text: 'then he came back and he was like 5k and I was like, I beg your pardon like what' },
    { start: 4, end: 8, text: 'do you mean £5,000 to make a video? Um, but little did I' },
    { start: 8, end: 12, text: 'know on the background guys making like 80 grand off of me.' },
  ], null);
  const moneyWindow = buildReviewWindows(money)[0];
  assert.equal(moneyWindow.cues.length, 3);
  assert.equal(splitWindowSentences(moneyWindow).length, 2);
  const parsed = parseReviewOutput({ translations: [
    { n: 1, zh: '然後他又回來，要五千英鎊，我當時想，請問什麼意思，拍個影片要五萬英鎊？' },
    { n: 2, zh: '不過當時我完全不知道，背後那些人從我這賺了八萬。' },
  ] }, moneyWindow, money, 'Test', DEFAULT_GLOSSARY);
  assert.deepEqual(parsed.map(item => item.notes.filter(note => note.startsWith('數字'))), [[], ['數字未逐字保留：5,000'], []], 'the note lands on the cue that holds £5,000');
});

test('number guard rejects partial hits, bare coefficients and lost percent signs, and reports cross-cue magnitude words on the right cue', () => {
  assert.deepEqual(missingNumbers('12 people', '312人'), ['12']);
  assert.deepEqual(missingNumbers('10K', '11萬'), ['10K']);
  assert.deepEqual(missingNumbers('1 or 12', '12 或 1'), []);
  assert.deepEqual(missingNumbers('50%', '50倍'), ['50%']);
  assert.deepEqual(missingNumbers('50%', '50%'), []);
  assert.deepEqual(missingNumbers('80 grand', '八十元'), ['80 grand']);
  assert.deepEqual(missingNumbers('80 grand', '八萬元'), []);
  assert.deepEqual(missingNumbers('4K video', '4K 影片'), []);
  assert.deepEqual(missingNumbers('a 2.5k budget', '預算 2.5k'), []);
  assert.deepEqual(missingNumbers('3.5 hours', '5 小時'), ['3.5']);
  const cross = toReviewCues([{ start: 0, end: 2, text: 'He earned 50' }, { start: 2, end: 4, text: 'thousand this year.' }], null);
  const crossWindow = buildReviewWindows(cross)[0];
  assert.equal(crossWindow.cues.length, 2);
  const parsed = parseReviewOutput({ translations: [{ n: 1, zh: '他今年賺了七萬元。' }] }, crossWindow, cross, 'Test', DEFAULT_GLOSSARY);
  assert.deepEqual(parsed.map(item => item.notes), [['數字未逐字保留：50 thousand'], []], 'the note lands on the cue that holds 50');
});

test('two sentences cannot both merge away the same cue, and >> survives an empty first piece or the fallback', () => {
  // 中間的 cue 只有兩句的零碎尾巴與開頭：第一句併走 on.，第二句就不能再併走 It。
  const shared = toReviewCues([
    { start: 0, end: 4, text: 'The approach that we have worked' },
    { start: 4, end: 5, text: 'on. It' },
    { start: 5, end: 9, text: 'has the potential to change everything we do here.' },
  ], null);
  const sharedWindow = buildReviewWindows(shared)[0];
  assert.equal(sharedWindow.cues.length, 3);
  const parsed = parseReviewOutput({ translations: [{ n: 1, zh: '我們一直在做的那個方法。' }, { n: 2, zh: '它有潛力改變我們在這裡做的每一件事。' }] }, sharedWindow, shared, 'Test', DEFAULT_GLOSSARY);
  assert.equal(parsed.length, 3);
  assert.ok(parsed.every(item => /[\p{L}\p{N}]/u.test(item.candidate)), JSON.stringify(parsed.map(item => item.candidate)));
  const coverage = [1, 2, 1];
  assert.deepEqual(mergeTinySpans([{ position: 0, weight: 30 }, { position: 1, weight: 3 }], coverage), [{ position: 0, weight: 33 }]);
  assert.deepEqual(coverage, [1, 1, 1], 'merging decrements the shared coverage');
  assert.deepEqual(mergeTinySpans([{ position: 1, weight: 2 }, { position: 2, weight: 50 }], coverage), [{ position: 1, weight: 2 }, { position: 2, weight: 50 }]);
  // 第二句譯文以純標點開頭：那截被併走後，>> 要接到第一段有內容的片段。
  const turn = toReviewCues([{ start: 0, end: 2, text: 'Okay. >> Well, you' }, { start: 2, end: 6, text: 'know, we should talk about the next step next.' }], null);
  const turnWindow = buildReviewWindows(turn)[0];
  assert.equal(turnWindow.cues.length, 2);
  const marked = parseReviewOutput({ translations: [{ n: 1, zh: '好。' }, { n: 2, zh: '……你知道的，我們該談談下一步了。' }] }, turnWindow, turn, 'Test', DEFAULT_GLOSSARY);
  assert.ok(marked.some(item => item.candidate.includes('>> ')), JSON.stringify(marked.map(item => item.candidate)));
  assert.ok(!marked.some(item => /^>> $/.test(item.candidate)));
  // 退路（整段比例切分）也要把句首的 >> 接回去，句中的接不回就備註。
  const fallback = parseReviewOutput({ text: '我同意。但我不同意。', fallback: 'SENTENCE_COUNT' }, turnWindow, turn, 'Test', DEFAULT_GLOSSARY);
  assert.ok(fallback[0].notes.some(note => note.includes('句中的 >> 換人標記無法接回')), JSON.stringify(fallback[0].notes));
  const leading = toReviewCues([{ start: 0, end: 2, text: '>> I agree with that.' }, { start: 2, end: 4, text: 'But I disagree with this.' }], null);
  const leadingWindow = { ...buildReviewWindows(leading)[0], cues: leading };
  const leadingFallback = parseReviewOutput({ text: '我同意那個。但我不同意這個。', fallback: 'SENTENCE_COUNT' }, leadingWindow, leading, 'Test', DEFAULT_GLOSSARY);
  assert.match(leadingFallback[0].candidate, /^>> 我同意/);
  assert.ok(!leadingFallback[1].candidate.startsWith('>>'));
  // 雙向控制字元跟其他控制字元一樣攤平，不能進 SRT。
  const bidi = parseReviewOutput({ translations: [{ n: 1, zh: '好\u202E的\u202C。' }, { n: 2, zh: '你知道的，我們該談談下一步了。' }] }, turnWindow, turn, 'Test', DEFAULT_GLOSSARY);
  assert.ok(bidi.every(item => !/[\u202A-\u202E]/.test(item.candidate)));
});

test('round-two guards: decimals, enumerations, percent contention, per-sentence number placement and trailing >>', () => {
  assert.deepEqual(missingNumbers('3 hours', '3.5 小時'), ['3'], 'a decimal prefix is not the integer');
  assert.deepEqual(missingNumbers('3.5 hours', '3.50 小時'), [], 'equal decimals match');
  assert.deepEqual(missingNumbers('There are groups of 12 and 30 people.', '分成 12, 30 人的組別。'), [], 'an enumeration comma is not a thousands separator');
  assert.deepEqual(missingNumbers('1,000 people', '1000 人'), []);
  assert.deepEqual(missingNumbers('1,000,000 views', '1,000,000 次觀看'), []);
  assert.deepEqual(missingNumbers('He paid 50 dollars with a 50% discount.', '打了 50% 折扣後，他付了 50 美元。'), [], 'the bare 50 cannot take the 50% token');
  assert.deepEqual(missingNumbers('He paid 50 dollars with a 50% discount.', '打了五折後，他付了 50 美元。'), ['50%']);
  const dogs = toReviewCues([{ start: 0, end: 3, text: 'He saw 12 people. He then counted' }, { start: 3, end: 5, text: '12 dogs.' }], null);
  const dogsWindow = buildReviewWindows(dogs)[0];
  assert.equal(dogsWindow.cues.length, 2);
  const parsed = parseReviewOutput({ translations: [{ n: 1, zh: '他看到了 12 個人。' }, { n: 2, zh: '接著他數了那些狗。' }] }, dogsWindow, dogs, 'Test', DEFAULT_GLOSSARY);
  assert.deepEqual(parsed.map(item => item.notes), [[], ['數字未逐字保留：12']], 'the note lands on the cue whose sentence lost the number');
  const trailing = toReviewCues([{ start: 0, end: 2, text: 'I agree with that >>' }, { start: 2, end: 4, text: 'But I disagree with this.' }], null);
  const trailingWindow = { ...buildReviewWindows(trailing)[0], cues: trailing };
  const fallback = parseReviewOutput({ text: '我同意那個，但我不同意這個。', fallback: 'SENTENCE_COUNT' }, trailingWindow, trailing, 'Test', DEFAULT_GLOSSARY);
  assert.ok(!fallback[0].candidate.includes('>>'));
  assert.match(fallback[1].candidate, /^>> /, 'a marker at the end of a cue opens the next cue');
  assert.ok(!fallback[0].notes.some(note => note.includes('無法接回')));
});
