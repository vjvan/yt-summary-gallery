import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitSummaryInput, validateLocalSummary, extractLocalSummary, normalizeSummaryStrings, normalizeSummaryInputAliases } from '../lib/pipeline/local-summary';
import { fetchTranscript, transcriptFromWatchSource } from '../lib/pipeline/fetch-transcript';
import { libraryWindowTime, publicLibraryError, withLibraryBusyRetry } from '../lib/pipeline/local-youtube-library';
import { parseLocalFileWhisper } from '../lib/pipeline/local-file-transcribe';
import type { WatchSessionView, WatchSource } from '../lib/watch/types';
const socialCards = Array.from({ length: 20 }, (_, index) => ({
  role: index === 0 ? 'hook' : index === 19 ? 'closing' : 'insight',
  eyebrow: `第${index + 1}頁`, title: `測試標題${index + 1}`, body: `這是第${index + 1}頁的完整測試內容。`, accent: '',
}));
const fixture = { title_display: '測試', one_liner: '摘要重點', tldr_paragraph: '原文介紹影片創作流程，保留專有名詞與數字。', key_quote: '',
  key_points: [{ label: '重點', content: '影片創作' }], action_items: [], pitfalls: [], recall_questions: ['要注意什麼？'], tags: ['AI'],
  highlights: [{ timestamp: 80, label: '段落', description: '內容' }], social_cards: socialCards, video_genre: 'tutorial' };
const source: WatchSource = { videoId: 'N-tmQ_Can_o', title: 'Test', language: 'en', sourceKind: 'manual', trackId: 'track',
  cues: [{ id: '1', start: 1, end: 3, text: 'Hello.' }, { id: '2', start: 10, end: 12, text: 'Hello.' }] };

test('splitSummaryInput preserves every character including the middle of long transcripts', () => {
  const input = Array.from({ length: 80 }, (_, i) => `[${i}:00] ${'word '.repeat(150)}\n`).join('');
  const chunks = splitSummaryInput(input);
  assert.ok(chunks.length > 2); assert.equal(chunks.join(''), input); assert.ok(chunks.every(chunk => chunk.length <= 4000));
  assert.throws(() => splitSummaryInput(' '));
});
test('caption-first path accepts short and repeated original speech without any media/Whisper fallback', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-source-'));
  try {
    let calls = 0;
    const result = await fetchTranscript('https://www.youtube.com/watch?v=N-tmQ_Can_o&t=1635s', tmp, { source: async url => {
      calls++; assert.equal(url, 'https://www.youtube.com/watch?v=N-tmQ_Can_o'); return source;
    } });
    assert.equal(calls, 1); assert.equal(result.segments.length, 2); assert.equal(result.transcript, 'Hello. Hello.');
    assert.equal(result.metadata.transcript_source, 'subtitle:manual:en'); assert.deepEqual(fs.readdirSync(tmp), []);
  } finally { fs.rmSync(tmp, { recursive: true }); }
});
test('caption download errors stay actionable, do not expose shell/URL or implicitly transcribe', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-source-'));
  try {
    await assert.rejects(() => fetchTranscript('https://youtu.be/N-tmQ_Can_o', tmp, { source: async () => { throw new Error('secret signed URL HTTP403'); } }), error => {
      assert.ok(error instanceof Error); assert.match(error.message, /沒有自動下載音訊/); assert.doesNotMatch(error.message, /secret/); return true;
    });
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally { fs.rmSync(tmp, { recursive: true }); }
});
test('malicious/fake YouTube URL rejected before subprocess dependency', async () => {
  await assert.rejects(() => fetchTranscript('https://evil.invalid/youtube.com?v=N-tmQ_Can_o', '/tmp/not-created', { source: async () => { throw new Error('must not run'); } }));
});
test('translation clock is retained when adapting source to library records', () => {
  assert.deepEqual(transcriptFromWatchSource(source).segments, source.cues.map(({ start, end, text }) => ({ start, end, text })));
});
test('summary schema rejects empty/English-only/malformed output rather than marking ready', () => {
  assert.equal(validateLocalSummary(fixture).title_display, '測試');
  assert.throws(() => validateLocalSummary({ ...fixture, tldr_paragraph: 'Only English' }));
  assert.throws(() => validateLocalSummary({ ...fixture, key_points: ['wrong shape'] }));
});
test('map/reduce local summary reads complete text, then reuses validated cache with zero model work', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'local-summary-cache-'));
  const seen: string[] = [];
  const request: Parameters<typeof extractLocalSummary>[3] = { model: 'unit-test', glossary: '', cacheDir: tmp,
    request: async input => {
      const user = JSON.parse(input.messages[1].content);
      seen.push(user.transcript);
      if ('notes' in ((input.schema as { properties: object }).properties)) return JSON.stringify({ notes: `本段重點：${user.transcript.includes('MIDDLE_MARKER') ? '中間已納入' : '內容'}`, highlights: [] });
      return JSON.stringify(fixture);
    } };
  const transcript = `START${'A'.repeat(4500)}MIDDLE_MARKER${'B'.repeat(4500)}END`;
  try {
    await extractLocalSummary(transcript, 'title', '', request);
    assert.equal(seen.slice(0, 2).join(''), transcript);
    assert.ok(seen.some(part => part.includes('MIDDLE_MARKER')));
    const count = seen.length;
    await extractLocalSummary(transcript, 'title', '', request);
    assert.equal(seen.length, count);
  } finally { fs.rmSync(tmp, { recursive: true }); }
});
test('library window anchors select every aligned batch without dropping an overlapping cue', () => {
  const cues = Array.from({ length: 20 }, (_, index) => ({ id: `${index}`, start: index * 2, end: index * 2 + 2, text: 'text' }));
  const session = { ...source, cues } as WatchSessionView;
  assert.equal(libraryWindowTime(session, 8), 16); assert.equal(libraryWindowTime(session, 16), 32);
  const bad = { ...session, cues: [{ ...cues[0], end: 100 }, ...cues.slice(1)] };
  assert.throws(() => libraryWindowTime(bad, 8));
});
test('library error text never leaks model responses, signed URLs or shell commands', () => {
  assert.doesNotMatch(publicLibraryError(new Error('curl -H Authorization secret')), /curl|secret|Authorization/);
});

test('local ASR uses real segment milliseconds plus chunk offset, never invents words', () => {
  const result = parseLocalFileWhisper({ transcription: [{ offsets: { from: 500, to: 1250 }, text: ' hello ' }] }, 60);
  assert.deepEqual(result, { text: 'hello', segments: [{ start: 60.5, end: 61.25, text: 'hello' }], words: [] });
  assert.throws(() => parseLocalFileWhisper({ params: { translate: true }, transcription: [] }));
  assert.throws(() => parseLocalFileWhisper({ transcription: [{ offsets: { from: 3, to: 2 }, text: 'bad' }] }));
});
test('summary display normalizes common Taiwan vocabulary without inventing facts', () => {
  assert.equal(normalizeSummaryStrings({ ...validateLocalSummary(fixture), one_liner: '視頻生成軟件使用者' }).one_liner, '影片生成軟體使用者');
});

test('library retries transient BUSY but not cancellation/model failures', async () => {
  let time = 0, attempts = 0;
  const result = await withLibraryBusyRetry(async () => { if (++attempts < 3) throw { code: 'BUSY' }; return 'success'; }, { now: () => time, delay: async ms => { time += ms; } });
  assert.equal(result, 'success'); assert.equal(attempts, 3); assert.equal(time, 4000);
  await assert.rejects(() => withLibraryBusyRetry(async () => { throw { code: 'CANCELLED' }; }), error => (error as { code: string }).code === 'CANCELLED');
});
test('library BUSY wait has a finite deadline and preserves a actionable error code', async () => {
  let time = 0;
  await assert.rejects(() => withLibraryBusyRetry(async () => { throw { code: 'BUSY' }; }, { now: () => time, delay: async ms => { time += ms; }, deadlineMs: 5000 }), error => (error as { code: string }).code === 'LIBRARY_BUSY_TIMEOUT');
  assert.equal(time, 5000);
});

test('summary input reuses known contextual aliases without inventing new platform names', () => {
  const glossary = { no_translate_terms: [], term_map: [] as [string, string][], style_rules: [] };
  assert.equal(normalizeSummaryInputAliases('[0:00] We use open art and higgs field for AI videos.', 'AI platforms', glossary), '[0:00] We use OpenArt and Higgsfield for AI videos.');
  assert.equal(normalizeSummaryInputAliases('[0:00] Visit an open art gallery.', 'Local museum', glossary), '[0:00] Visit an open art gallery.');
  assert.equal(normalizeSummaryInputAliases('[0:00] Cling Video 2.1', 'AI platforms', glossary), '[0:00] Cling Video 2.1');
});
