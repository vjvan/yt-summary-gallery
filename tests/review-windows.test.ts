import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRiskFlags, riskScore } from '../lib/review/risk-flags';
import { buildReviewWindows, prioritizeWindows, toReviewCues } from '../lib/review/windows';

const flagCodes = (source: string, current: string | null, previous?: string) => detectRiskFlags({ source, current }, previous ? { source: previous } : null).map(flag => flag.code);

test('negation flags fire only when the translation lost the negative', () => {
  assert.ok(flagCodes("right? There's not all these bottlenecks that you have to get up to", '對？這些瓶頸你都得克服').includes('negation'));
  assert.ok(!flagCodes("There's not all these bottlenecks", '不會有這麼多瓶頸').includes('negation'));
  assert.ok(flagCodes("you're not afraid to say", '你敢不敢說').includes('question'), 'statement turned into a question');
  assert.ok(!flagCodes('Is this working?', '這樣行嗎？').includes('question'));
});

test('magnitude and quantity checks catch million→億 and dropped numbers', () => {
  const magnitude = detectRiskFlags({ source: 'they make millions, sometimes billions', current: '他們賺數以億計，有時數以兆計' });
  assert.ok(magnitude.some(flag => flag.code === 'magnitude' && /兆/.test(flag.detail)));
  assert.ok(!flagCodes('we spent 2 million on ads', '我們花了 200 萬做廣告').includes('magnitude'));
  assert.ok(flagCodes('guys making like 80 grand off of me', '那些人靠我賺了八十萬英鎊').includes('magnitude'));
  assert.ok(!flagCodes('guys making like 80 grand off of me', '那些人靠我賺了八萬').includes('magnitude'));
  assert.ok(flagCodes('it costs 15 dollars for 3 days', '三天要價 15 美元').includes('quantity'));
  assert.ok(!flagCodes('it costs 15 dollars for 3 days', '3 天要價 15 美元').includes('quantity'));
});

test('context-dependent cues get fragment, foreground, idiom and pronoun flags', () => {
  assert.ok(flagCodes('take your job post', '把你的工作職缺拿來', 'this is the anti- AI is going to').includes('fragment'));
  assert.ok(flagCodes('white on black works better', '白底黑字比較好').includes('foreground'));
  assert.ok(flagCodes('use outbound marketing', '用出海行銷').includes('idiom'));
  assert.ok(flagCodes('It just works.', '就是能用。').includes('pronoun'));
  assert.equal(riskScore(detectRiskFlags({ source: 'Hello there.', current: '哈囉。' })), 0);
});

test('windows close at sentence ends, long gaps, speaker labels and size limits, with context on both sides', () => {
  const cues = toReviewCues([
    { start: 0, end: 2, text: 'We started with nothing' },
    { start: 2, end: 4, text: 'and grew to eight figures.' },
    { start: 4.2, end: 6, text: 'Drew Brucker (0:04) Tell me more' },
    { start: 6, end: 8, text: 'about the first client.' },
    { start: 12, end: 14, text: 'They paid late' },
    { start: 14, end: 16, text: 'but they paid.' },
  ], null);
  const windows = buildReviewWindows(cues);
  assert.deepEqual(windows.map(window => window.cues.map(cue => cue.index)), [[0, 1], [2, 3], [4, 5]]);
  assert.equal(windows[1].key, 'w-2-3');
  assert.deepEqual(windows[1].before.map(cue => cue.index), [0, 1]);
  assert.deepEqual(windows[1].after.map(cue => cue.index), [4, 5]);
  assert.deepEqual(windows[0].before, []);
  const many = toReviewCues(Array.from({ length: 9 }, (_, index) => ({ start: index, end: index + 1, text: `part ${index} of a long run-on sentence` })), null);
  const limited = buildReviewWindows(many, { maxCues: 4 });
  assert.deepEqual(limited.map(window => window.cues.length), [4, 4, 1]);
});

test('prioritisation surfaces flagged windows first and keeps time order for ties', () => {
  const cues = toReviewCues([
    { start: 0, end: 2, text: 'This is fine.' },
    { start: 2, end: 4, text: "There's not all these bottlenecks." },
    { start: 4, end: 6, text: 'We make millions here.' },
    { start: 6, end: 8, text: 'Okay.' },
  ], [
    { start: 0, end: 2, text: '這樣可以。' },
    { start: 2, end: 4, text: '這些瓶頸都要克服。' },
    { start: 4, end: 6, text: '我們在這裡賺了數億。' },
    { start: 6, end: 8, text: '好。' },
  ]);
  const windows = buildReviewWindows(cues);
  const ranked = prioritizeWindows(windows);
  assert.deepEqual(ranked.map(window => window.key), ['w-1-1', 'w-2-2']);
  assert.ok(ranked[0].flags.some(flag => flag.code === 'negation'));
  assert.ok(ranked[1].flags.some(flag => flag.code === 'magnitude'));
  assert.equal(prioritizeWindows(windows, 100).length, 0);
});
