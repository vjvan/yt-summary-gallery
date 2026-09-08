import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMediaUrl, parseCaptionFile, pickCaptionTrack, stripTags } from '../lib/pipeline/media-captions';

// X 的字幕帶逐字時間軸標記；YouTube 自動字幕帶 <c> 與行內時間戳。兩種都要還原成乾淨句子。
const xVtt = `WEBVTT

00:00:00.000 --> 00:00:03.002
<X-word-ms ms=60,80,300 index=1 character_ranges=0-2,3-8,9-15>You know, people really love the Grokbot identity</X-word-ms>

00:00:03.202 --> 00:00:05.104
<X-word-ms ms=60,581 index=2 character_ranges=0-2,3-13>the animation, the logo is really fun</X-word-ms>

00:00:06.084 --> 00:00:07.084
<X-word-ms ms=80 index=3 character_ranges=0-2>And not to mention</X-word-ms>
`;

const youtubeVtt = `WEBVTT
Kind: captions
Language: en

NOTE this is a comment

00:00:01.000 --> 00:00:03.500 align:start position:0%
<00:00:01.000><c>so </c><00:00:01.400><c>we </c>started with nothing

00:00:03.400 --> 00:00:05.000
started with nothing

00:00:05.000 --> 00:00:06.500
and it &amp; grew fast
`;

test('caption files from X and YouTube both parse into clean, ordered segments', () => {
  const x = parseCaptionFile(xVtt);
  assert.deepEqual(x, [
    { start: 0, end: 3.002, text: 'You know, people really love the Grokbot identity' },
    { start: 3.202, end: 5.104, text: 'the animation, the logo is really fun' },
    { start: 6.084, end: 7.084, text: 'And not to mention' },
  ]);
  const youtube = parseCaptionFile(youtubeVtt);
  assert.deepEqual(youtube.map(cue => cue.text), ['so we started with nothing', 'and it & grew fast'], 'rolling repeats collapse and entities decode');
  assert.equal(youtube[0].end, 5, 'the repeated cue extends the first one instead of duplicating it');
  assert.deepEqual(parseCaptionFile('WEBVTT\n\n'), []);
  // SRT 的逗號毫秒與時數欄位也要吃。
  assert.deepEqual(parseCaptionFile('1\n01:00:01,500 --> 01:00:02,000\nlate line\n'), [{ start: 3601.5, end: 3602, text: 'late line' }]);
  // 壞資料不當成句子：結束時間不晚於開始、只剩標記的空句。
  assert.deepEqual(parseCaptionFile('00:00:05.000 --> 00:00:05.000\nzero length\n\n00:00:06.000 --> 00:00:07.000\n<c></c>\n'), []);
  const outOfOrder = parseCaptionFile('00:00:09.000 --> 00:00:10.000\nsecond\n\n00:00:01.000 --> 00:00:02.000\nfirst\n');
  assert.deepEqual(outOfOrder.map(cue => cue.text), ['first', 'second']);
});

test('a manual track beats an automatic one, English beats other languages, and no track means fall back to transcription', () => {
  assert.deepEqual(pickCaptionTrack({ manualLangs: ['fr', 'en-US'], autoLangs: ['en'] }), { lang: 'en-US', automatic: false });
  assert.deepEqual(pickCaptionTrack({ manualLangs: ['fr', 'zh-Hant'], autoLangs: ['en'] }), { lang: 'zh-Hant', automatic: false }, 'a manual Chinese track beats automatic English');
  assert.deepEqual(pickCaptionTrack({ manualLangs: [], autoLangs: ['de', 'en'] }), { lang: 'en', automatic: true });
  // 翻譯層只處理英文與簡轉繁：只有德文或韓文字幕時不要硬收，讓呼叫端走聽打。
  assert.equal(pickCaptionTrack({ manualLangs: ['de'], autoLangs: ['ko'] }), null, 'a language the translator cannot handle is not a hit');
  assert.equal(pickCaptionTrack({ manualLangs: [], autoLangs: [] }), null);
});

test('the parser is linear and bounded, and only collapses genuine rolling repeats', () => {
  // 沒有結尾的 `<`：正則版本會退回重掃，40 KB 就要半秒；線性掃描必須維持在毫秒等級。
  const started = Date.now();
  const nasty = `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${'<'.repeat(80000)}text\n`;
  const parsed = parseCaptionFile(nasty);
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started}ms`);
  assert.deepEqual(parsed, [], 'an unterminated tag swallows the line rather than hanging');
  assert.equal(stripTags('a<b>c'), 'a c');
  assert.equal(stripTags('a<b'), 'a', 'an unterminated tag never emits its contents');
  // 真的說了兩次的短句不可以被收掉（時間相接但不重疊）。
  const repeats = parseCaptionFile('00:00:01.000 --> 00:00:02.000\nNo.\n\n00:00:02.000 --> 00:00:03.000\nNo.\n');
  assert.equal(repeats.length, 2, 'adjacent identical cues are two real utterances');
  // 字詞邊界：someone 之後的 one 不是滾動重播。
  const boundary = parseCaptionFile('00:00:01.000 --> 00:00:03.000\nsomeone\n\n00:00:02.000 --> 00:00:04.000\none\n');
  assert.deepEqual(boundary.map(cue => cue.text), ['someone', 'one']);
  // 亂序的檔案先排序再收，較早的句子不會被刪掉。
  const outOfOrder = parseCaptionFile('00:00:09.000 --> 00:00:10.000\nsame\n\n00:00:01.000 --> 00:00:02.000\nsame\n');
  assert.deepEqual(outOfOrder.map(cue => cue.start), [1, 9]);
  // 超長行不吃進來，cue 數也有上限。
  assert.deepEqual(parseCaptionFile(`00:00:01.000 --> 00:00:02.000\n${'x'.repeat(5000)}\n`), []);
});

test('only http(s) links reach yt-dlp', () => {
  assert.equal(assertMediaUrl('https://x.com/a/status/1'), 'https://x.com/a/status/1');
  assert.throws(() => assertMediaUrl('file:///etc/passwd'), /http/);
  assert.throws(() => assertMediaUrl('not a url'), /無效/);
});
