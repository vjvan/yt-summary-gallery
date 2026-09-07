import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotebookSource, formatCueTimestamp, NotebookSourceError, parseNotebookSourceLang } from '../lib/pipeline/notebooklm-source';

const segments = [
  { start: 0.4, end: 3.2, text: 'We built an eight figure business in a year.' },
  { start: 3.2, end: 7.9, text: 'Brand partnerships are the main revenue.\nThey pay monthly.' },
  { start: 65.1, end: 70.0, text: 'Credits keep the tools running.' },
];
const segmentsZh = [
  { start: 0.4, end: 3.2, text: '我們一年內做出八位數的生意。' },
  { start: 3.2, end: 7.9, text: '品牌合作是主要營收，每月付費。' },
  { start: 65.1, end: 70.0, text: '點數讓工具持續運作。' },
];
const base = { title: '他一年內打造 8 位數 AI 事業', channel: 'Fast Hours', url: 'https://www.youtube.com/watch?v=abc', durationDisplay: '82:40', generatedAt: new Date('2026-09-07T12:00:00Z') };

test('bilingual source pairs every cue as two timestamped lines and keeps the video URL in the header', () => {
  const output = buildNotebookSource({ ...base, segments, segmentsZh, lang: 'bi' });
  assert.equal(output.cues, 3); assert.equal(output.translated, 3); assert.equal(output.note, null);
  assert.equal(output.filename, '他一年內打造 8 位數 AI 事業.notebooklm.bi.txt');
  const lines = output.text.split('\n');
  assert.equal(lines[0], '# 他一年內打造 8 位數 AI 事業');
  assert.equal(lines[1], '來源：https://www.youtube.com/watch?v=abc');
  assert.match(output.text, /匯出：2026-09-07/);
  assert.ok(output.text.includes('[00:00] We built an eight figure business in a year.\n[00:00] 我們一年內做出八位數的生意。\n'));
  // Multi-line source text collapses to one line so the timestamp stays on the quoted sentence.
  assert.ok(output.text.includes('[00:03] Brand partnerships are the main revenue. They pay monthly.\n[00:03] 品牌合作是主要營收，每月付費。'));
  assert.ok(output.text.includes('[01:05] Credits keep the tools running.\n[01:05] 點數讓工具持續運作。'));
  assert.ok(output.text.endsWith('\n'));
});

test('english-only and chinese-only variants emit exactly one line per cue', () => {
  const en = buildNotebookSource({ ...base, segments, segmentsZh, lang: 'en' });
  assert.equal(en.text.match(/^\[\d\d:\d\d\] /gm)?.length, 3);
  assert.ok(!en.text.includes('八位數'));
  assert.equal(en.filename.endsWith('.notebooklm.en.txt'), true);
  const zh = buildNotebookSource({ ...base, segments, segmentsZh, lang: 'zh' });
  assert.equal(zh.text.match(/^\[\d\d:\d\d\] /gm)?.length, 3);
  assert.ok(!zh.text.includes('eight figure'));
});

test('misaligned or missing translation falls back to english with an explicit note; zh-only refuses', () => {
  const missing = buildNotebookSource({ ...base, segments, segmentsZh: null, lang: 'bi' });
  assert.equal(missing.translated, 0);
  assert.equal(missing.note, '中譯尚未完成，本檔只含英文原文。');
  assert.match(missing.text, /注意：中譯尚未完成/);
  assert.equal(missing.filename.endsWith('.notebooklm.en.txt'), true);
  const misaligned = buildNotebookSource({ ...base, segments, segmentsZh: segmentsZh.slice(0, 2), lang: 'bi' });
  assert.equal(misaligned.translated, 0);
  assert.match(misaligned.note || '', /對不齊/);
  assert.throws(() => buildNotebookSource({ ...base, segments, segmentsZh: null, lang: 'zh' }), (error: unknown) => error instanceof NotebookSourceError && error.status === 409);
});

test('long videos switch to h:mm:ss and empty transcripts are rejected as 404', () => {
  assert.equal(formatCueTimestamp(65, false), '01:05');
  assert.equal(formatCueTimestamp(3725, false), '1:02:05');
  const long = buildNotebookSource({ ...base, segments: [...segments, { start: 4000, end: 4003, text: 'Late line.' }], segmentsZh: null, lang: 'en' });
  assert.ok(long.text.includes('[0:00:00] We built'));
  assert.ok(long.text.includes('[1:06:40] Late line.'));
  assert.throws(() => buildNotebookSource({ ...base, segments: [], segmentsZh: null, lang: 'bi' }), (error: unknown) => error instanceof NotebookSourceError && error.status === 404);
  const emoji = buildNotebookSource({ ...base, title: 'A'.repeat(79) + '😀 tail', segments, segmentsZh: null, lang: 'en' });
  assert.equal(emoji.filename, `${'A'.repeat(79)}😀.notebooklm.en.txt`);
  assert.doesNotThrow(() => encodeURIComponent(emoji.filename));
  assert.equal(parseNotebookSourceLang(null), 'bi');
  assert.throws(() => parseNotebookSourceLang('fr'), NotebookSourceError);
});
