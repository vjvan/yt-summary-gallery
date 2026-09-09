import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_GLOSSARY } from '../lib/glossary-defaults';
import type { requestLocalTranslation } from '../lib/watch/local-translator';
import { parseReviewOutput, reviewMessages, runSubtitleReview, splitPassage, splitSpeakerLabel, reviewSchema, REVIEW_SYSTEM_PROMPT, type ReviewPayload } from '../lib/review/pipeline';
import { SubtitleReviewService } from '../lib/review/service';
import { SubtitleReviewStore } from '../lib/review/store';
import { buildReviewWindows, toReviewCues } from '../lib/review/windows';
import { detectRiskFlags } from '../lib/review/risk-flags';

const segments = [
  { start: 0, end: 2, text: "right? There's not all these bottlenecks that you have to get up to." },
  { start: 2.2, end: 5, text: 'We made millions with Midjourney last year.' },
  { start: 9, end: 11, text: 'Okay.' },
];
const segmentsZh = [
  { start: 0, end: 2, text: '對？這些瓶頸你都得克服。' },
  { start: 2.2, end: 5, text: '我們去年用 Midjourney 賺了數億。' },
  { start: 9, end: 11, text: '好。' },
];
const cues = toReviewCues(segments, segmentsZh);
const windows = buildReviewWindows(cues);

/**
 * 以視窗原文開頭幾個字當鍵；指定的答案依中文句尾標點拆給各句（多的併到最後一句、少的補「好。」），
 * 沒指定就每句回「譯：」加一個中文字對一個英文字元的假譯文，讓比例切分有東西可切。
 */
function fakeRequest(answers: Record<string, string>): typeof requestLocalTranslation {
  return async input => {
    const data = JSON.parse(input.messages[1].content) as ReviewPayload;
    const joined = data.sentences.map(sentence => sentence.en).join(' ');
    const key = Object.keys(answers).find(prefix => joined.startsWith(prefix));
    if (!key) return JSON.stringify({ translations: data.sentences.map(sentence => ({ n: sentence.n, zh: `譯：${'中'.repeat(Math.max(4, Math.ceil(sentence.en.length / 2)))}。` })) });
    const chunks = answers[key].split(/(?<=[。？！])/).filter(Boolean);
    while (chunks.length > data.sentences.length) chunks.splice(-2, 2, chunks.slice(-2).join(''));
    while (chunks.length < data.sentences.length) chunks.push('好。');
    return JSON.stringify({ translations: data.sentences.map((sentence, index) => ({ n: sentence.n, zh: chunks[index] })) });
  };
}

test('prompt sends numbered sentences without speaker labels or old translations, and after-context only for an unfinished sentence', () => {
  const window = windows[0];
  const messages = reviewMessages(window, 'Test video', DEFAULT_GLOSSARY);
  assert.equal(messages[0].content, REVIEW_SYSTEM_PROMPT);
  const payload = JSON.parse(messages[1].content) as ReviewPayload & { title?: unknown; passage?: unknown };
  assert.deepEqual(payload.sentences, [{ n: 1, en: 'right?' }, { n: 2, en: "There's not all these bottlenecks that you have to get up to." }]);
  assert.ok(!messages[1].content.includes('得克服'), 'the old translation is never sent');
  assert.equal(payload.title, undefined, 'the title is not sent: a 7B model translates it into the passage');
  assert.equal(payload.passage, undefined);
  assert.equal(payload.after, '', 'the window ends a sentence, so no following context is sent');
  const unfinished = toReviewCues([{ start: 0, end: 2, text: 'I was thinking that we' }, { start: 5, end: 7, text: 'should go now, honestly, because it is late and the trains stop soon. Okay.' }], null);
  const cut = buildReviewWindows(unfinished);
  assert.equal(cut[0].cues.length, 1, 'a long pause closes the window mid-sentence');
  const cutPayload = JSON.parse(reviewMessages(cut[0], 'Test', DEFAULT_GLOSSARY)[1].content) as ReviewPayload;
  assert.equal(cutPayload.after, 'should go now, honestly, because it is late and the trains stop', 'only the first few words of the next cue are sent');
  assert.equal(reviewMessages(window, 'Test', DEFAULT_GLOSSARY, '再試一次')[0].content, `${REVIEW_SYSTEM_PROMPT}\n再試一次`);
  const schema = reviewSchema(2);
  assert.equal(schema.properties.translations.minItems, 2);
  assert.equal(schema.properties.translations.maxItems, 2);
  assert.deepEqual(schema.properties.translations.items.required, ['n', 'zh']);
  assert.deepEqual(splitSpeakerLabel('Drew Brucker (04:21) like family movie time.'), { label: 'Drew Brucker (04:21)', text: 'like family movie time.' });
  assert.deepEqual(splitSpeakerLabel('plain words'), { label: '', text: 'plain words' });
});

test('a passage is split back onto cues by source length, snapping to punctuation, never producing an empty cue', () => {
  assert.deepEqual(splitPassage('對吧？不會有那麼多你得跨過的瓶頸。我每次跟客戶合作時都在想。', [70, 60]), ['對吧？不會有那麼多你得跨過的瓶頸。', '我每次跟客戶合作時都在想。']);
  assert.deepEqual(splitPassage('一二三四五六七八九十', [1, 1]), ['一二三四五', '六七八九十']);
  assert.deepEqual(splitPassage('只有一句', [10]), ['只有一句']);
  const three = splitPassage('第一段，第二段，第三段。', [5, 5, 5]);
  assert.equal(three.length, 3);
  assert.ok(three.every(part => part.length > 0));
  assert.throws(() => splitPassage('短', [1, 1, 1]), /太短/);
});

test('parsed candidates re-attach speaker labels, note dropped names and digits, and mark unchanged text', () => {
  const window = windows.find(item => item.cues.some(cue => cue.source.includes('Midjourney')))!;
  const cue = window.cues[0];
  const single = { ...window, cues: [cue] };
  const good = parseReviewOutput({ text: '我們去年用 Midjourney 賺了好幾百萬。' }, single, cues, 'Test', DEFAULT_GLOSSARY);
  assert.equal(good.length, 1);
  assert.equal(good[0].changed, true);
  assert.deepEqual(good[0].notes, []);
  const dropped = parseReviewOutput({ text: '我們去年賺了好幾百萬。' }, single, cues, 'Test', DEFAULT_GLOSSARY);
  assert.ok(dropped[0].notes.some(note => note.includes('Midjourney')));
  const same = parseReviewOutput({ text: '我們去年用 Midjourney 賺了數億。' }, single, cues, 'Test', DEFAULT_GLOSSARY);
  assert.equal(same[0].changed, false);
  assert.throws(() => parseReviewOutput({ text: 'still english' }, single, cues, 'Test', DEFAULT_GLOSSARY), /中文/);
  assert.throws(() => parseReviewOutput({ cues: [] }, single, cues, 'Test', DEFAULT_GLOSSARY), /空白/);
  const labelled = toReviewCues([{ start: 0, end: 2, text: 'Drew Brucker (04:21) like family movie time' }, { start: 2, end: 4, text: 'you know, when they are under five.' }], null);
  const labelledWindow = buildReviewWindows(labelled)[0];
  const parsed = parseReviewOutput({ text: '像家庭電影時間。你知道，他們五歲以下的時候。' }, labelledWindow, labelled, 'Test', DEFAULT_GLOSSARY);
  assert.equal(parsed.length, 2);
  assert.match(parsed[0].candidate, /^Drew Brucker \(04:21\) 像家庭電影時間。$/);
  assert.equal(parsed[1].candidate, '你知道，他們五歲以下的時候。');
});

test('control characters are flattened, punctuation-only splits are rejected, and semantic punctuation counts as a change', () => {
  const window = windows[0];
  const single = { ...window, cues: [window.cues[0]] };
  const injected = parseReviewOutput({ text: '對吧？不會有那麼多瓶頸。\r\r00:10:00.000 --> 00:10:05.000\r插入內容' }, single, cues, 'Test', DEFAULT_GLOSSARY);
  assert.ok(!/[\r\n]/.test(injected[0].candidate));
  const question = parseReviewOutput({ text: '對？這些瓶頸你都得克服？' }, single, cues, 'Test', DEFAULT_GLOSSARY);
  assert.equal(question[0].changed, true, 'a question mark instead of a full stop is a semantic change');
  const three = toReviewCues([{ start: 0, end: 1, text: 'a b c' }, { start: 1, end: 2, text: 'd e f' }, { start: 2, end: 3, text: 'g h i' }], null);
  const threeWindow = buildReviewWindows(three)[0];
  assert.equal(threeWindow.cues.length, 3);
  assert.throws(() => parseReviewOutput({ text: '甲乙。' }, threeWindow, three, 'Test', DEFAULT_GLOSSARY), /只有標點/);
  assert.equal(detectRiskFlags({ source: 'guys making like 80 grand off of me', current: '那些人靠我賺了八十萬' }).find(flag => flag.code === 'magnitude')?.detail, '80 grand 是 80000（8 萬），譯文量級過大');
  assert.equal(detectRiskFlags({ source: 'it was 8.5 grand', current: '要價八十萬。' }).find(flag => flag.code === 'magnitude')?.detail, '8.5 grand 是 8500（0.85 萬），譯文量級過大');
  assert.equal(detectRiskFlags({ source: 'about 12.5k a month', current: '每月八十萬。' }).find(flag => flag.code === 'magnitude')?.detail, '12.5k 是 12500（1.25 萬），譯文量級過大');
  // C1 控制字元也要清掉；品牌不能被切點切成兩半。
  const c1 = parseReviewOutput({ text: '對吧？不會有\u0085那麼多瓶頸\u009f。' }, single, cues, 'Test', DEFAULT_GLOSSARY);
  assert.ok(!/[\u0080-\u009f]/.test(c1[0].candidate));
  const brand = toReviewCues([{ start: 0, end: 1, text: 'We use Higgsfield to' }, { start: 1, end: 2, text: 'generate our AI videos.' }], null);
  const brandWindow = buildReviewWindows(brand)[0];
  assert.equal(brandWindow.cues.length, 2);
  const brandParts = parseReviewOutput({ text: '我們用Higgsfield生成AI影片。' }, brandWindow, brand, 'Test', DEFAULT_GLOSSARY);
  assert.ok(brandParts.every(item => !/^[A-Za-z]/.test(item.candidate) || /^Higgsfield/.test(item.candidate)), JSON.stringify(brandParts.map(item => item.candidate)));
  assert.ok(brandParts.some(item => item.candidate.includes('Higgsfield')), 'the brand survives the split intact');
  const brandThree = toReviewCues([{ start: 0, end: 1, text: 'We are' }, { start: 1, end: 2, text: 'using' }, { start: 2, end: 3, text: 'Higgsfield now' }], null);
  const brandThreeWindow = buildReviewWindows(brandThree)[0];
  assert.equal(brandThreeWindow.cues.length, 3);
  assert.throws(() => parseReviewOutput({ text: '我們用Higgsfield' }, brandThreeWindow, brandThree, 'Test', DEFAULT_GLOSSARY), /無法避開英數詞/);
  assert.equal(detectRiskFlags({ source: 'about 8.123 grand', current: '要價八十萬。' }).find(flag => flag.code === 'magnitude')?.detail, '8.123 grand 是 8123（0.8123 萬），譯文量級過大');
});

test('the pipeline caches per window, survives a failed window and stops after five consecutive failures', async () => {
  const saved = new Map<string, unknown>();
  let calls = 0;
  const request: typeof requestLocalTranslation = async input => { calls++; return fakeRequest({})(input); };
  const deps = { model: 'qwen2.5:7b', request, signal: new AbortController().signal, glossary: DEFAULT_GLOSSARY, title: 'Test', sourceHash: 'hash',
    load: (key: string) => saved.get(key), save: (key: string, value: unknown) => saved.set(key, value), progress: () => {} };
  const first = await runSubtitleReview({ title: 'Test', cues, windows }, deps);
  assert.equal(first.candidates.length, cues.length);
  assert.equal(first.failedWindows.length, 0);
  const before = calls;
  await runSubtitleReview({ title: 'Test', cues, windows }, deps);
  assert.equal(calls, before, 'checkpoints are reused without new model calls');
  const flaky: typeof requestLocalTranslation = async () => 'not json';
  const failing = await runSubtitleReview({ title: 'Test', cues, windows: windows.slice(0, 2) }, { ...deps, load: () => undefined, request: flaky });
  assert.equal(failing.candidates.length, 0);
  assert.equal(failing.failedWindows.length, 2);
  assert.equal(failing.partial, true);
  const many = Array.from({ length: 6 }, (_, index) => ({ ...windows[0], key: `w-${index}-${index}` }));
  await assert.rejects(() => runSubtitleReview({ title: 'Test', cues, windows: many }, { ...deps, load: () => undefined, request: flaky }), /連續 5 個視窗失敗/);
});

function serviceFixture(request: typeof requestLocalTranslation, options: { zh?: typeof segmentsZh; srtZhPath?: string | null; jobActive?: boolean } = {}) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE summaries (id TEXT PRIMARY KEY, video_id TEXT, title TEXT, segments TEXT, segments_zh TEXT, transcript_zh TEXT, is_translated INTEGER, transcript_source TEXT, srt_zh_path TEXT, card_render_token TEXT, pipeline_stage TEXT, status TEXT, subtitle_status TEXT)`);
  const zh = options.zh ?? segmentsZh;
  db.prepare('INSERT INTO summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('vid', 'vid', 'Test', JSON.stringify(segments), JSON.stringify(zh), zh.map(c => c.text).join(' '), 1, 'subtitle:manual:en', options.srtZhPath ?? null, null, 'done', 'done', 'complete');
  const store = new SubtitleReviewStore(db);
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  const service = new SubtitleReviewService({ db, store, model: () => 'qwen2.5:7b', processingMode: () => 'local', glossary: () => DEFAULT_GLOSSARY, request, projectRoot, jobActive: () => options.jobActive ?? false });
  return { db, store, service, projectRoot };
}

test('service runs flagged windows in the background, then approve → apply rewrites subtitles and revert restores them', async () => {
  const { db, service } = serviceFixture(fakeRequest({ "right? There's not": '對吧？不會有那麼多你得跨過的瓶頸。', 'We made millions': '我們去年用 Midjourney 賺了好幾百萬。' }));
  try {
    const idle = service.get('vid');
    assert.equal(idle.status, 'idle');
    assert.ok(idle.counts.flaggedWindows >= 2, 'negation and magnitude windows are flagged');
    const started = service.start('vid', { scope: 'flagged', limit: 40 });
    assert.equal(started.accepted, true);
    assert.equal(started.response.status, 'running');
    await service.settled('vid');
    const done = service.get('vid');
    assert.equal(done.status, 'complete');
    const negation = done.candidates.find(item => item.cueIndex === 0)!;
    assert.equal(negation.candidate, '對吧？不會有那麼多你得跨過的瓶頸。');
    assert.equal(negation.changed, true);
    assert.equal(negation.decision, 'candidate');
    assert.ok(negation.flags.some(flag => flag.code === 'negation'));
    assert.ok(!done.candidates.some(item => item.cueIndex === 2), 'the unflagged window was not translated');

    // Approve both, apply, and check the row + revision history.
    service.decide('vid', done.sourceHash!, [0, 1], 'approved');
    const applied = service.apply('vid', done.sourceHash!);
    assert.equal(applied.applied, 2);
    const row = db.prepare('SELECT segments_zh, transcript_zh FROM summaries WHERE id=?').get('vid') as { segments_zh: string; transcript_zh: string };
    const zh = JSON.parse(row.segments_zh);
    assert.equal(zh[0].text, '對吧？不會有那麼多你得跨過的瓶頸。');
    assert.equal(zh[0].start, 0, 'timing is untouched');
    assert.equal(zh[2].text, '好。');
    assert.match(row.transcript_zh, /^對吧？不會有那麼多/);
    const after = service.get('vid');
    assert.equal(after.counts.applied, 2);
    assert.equal(after.sourceHash, done.sourceHash, 'changing the translation does not invalidate the review');
    assert.ok(after.lastAppliedAt);

    const reverted = service.revertLast('vid');
    assert.equal(reverted.reverted, 2);
    const restored = JSON.parse((db.prepare('SELECT segments_zh FROM summaries WHERE id=?').get('vid') as { segments_zh: string }).segments_zh);
    assert.equal(restored[0].text, '對？這些瓶頸你都得克服。');
    assert.equal(service.get('vid').counts.applied, 0);
    assert.throws(() => service.revertLast('vid'), /沒有可還原/);
    assert.throws(() => service.apply('vid', 'stale-hash'), /原文字幕已變更/);

    // A concurrent subtitle write between our read and our write must abort the whole batch.
    service.decide('vid', done.sourceHash!, [0], 'approved');
    const racing = new SubtitleReviewService({ db, store: new SubtitleReviewStore(db), model: () => 'qwen2.5:7b', processingMode: () => 'local', glossary: () => DEFAULT_GLOSSARY, request: fakeRequest({}), jobActive: () => false });
    const original = db.prepare('SELECT segments_zh FROM summaries WHERE id=?').get('vid') as { segments_zh: string };
    const patched = JSON.parse(original.segments_zh); patched[2].text = '另一個工作改了這句。';
    const originalPrepare = db.prepare.bind(db);
    let injected = false;
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      // 在 apply 讀完整列之後、進交易之前注入另一個工作的寫入（交易內注入會被 rollback 一起收掉）。
      if (!injected && sql.startsWith('SELECT * FROM subtitle_review_candidates')) {
        injected = true;
        originalPrepare('UPDATE summaries SET segments_zh=? WHERE id=?').run(JSON.stringify(patched), 'vid');
      }
      return statement;
    }) as typeof db.prepare;
    try { assert.throws(() => racing.apply('vid', done.sourceHash!), /被其他工作更動/); } finally { db.prepare = originalPrepare; }
    const afterRace = JSON.parse((db.prepare('SELECT segments_zh FROM summaries WHERE id=?').get('vid') as { segments_zh: string }).segments_zh);
    assert.equal(afterRace[2].text, '另一個工作改了這句。', 'the other worker\'s write survives');
    assert.equal(afterRace[0].text, '對？這些瓶頸你都得克服。', 'our stale batch was not written');
  } finally { db.close(); }
});

test('misaligned timing, active subtitle jobs and stale batches are refused; export failures are visible and retryable', async () => {
  const shifted = segmentsZh.map(cue => ({ ...cue, start: cue.start + 100, end: cue.end + 100 }));
  const misaligned = serviceFixture(fakeRequest({}), { zh: shifted });
  try { assert.throws(() => misaligned.service.get('vid'), /時間軸/); } finally { misaligned.db.close(); }

  const busy = serviceFixture(fakeRequest({ "right? There's not": '對吧？不會有那麼多你得跨過的瓶頸。' }), { jobActive: true });
  try {
    busy.service.start('vid', { scope: 'flagged', limit: 40 }); await busy.service.settled('vid');
    const state = busy.service.get('vid');
    busy.service.decide('vid', state.sourceHash!, [0], 'approved');
    assert.throws(() => busy.service.apply('vid', state.sourceHash!), /工作進行中/);
  } finally { busy.db.close(); }

  const exporting = serviceFixture(fakeRequest({ "right? There's not": '對吧？不會有那麼多你得跨過的瓶頸。' }), { srtZhPath: '/burned/vid/vid.zh.srt' });
  try {
    const { service, projectRoot, db } = exporting;
    service.start('vid', { scope: 'flagged', limit: 40 }); await service.settled('vid');
    const state = service.get('vid');
    service.decide('vid', state.sourceHash!, [0], 'approved');
    // Make public/burned/vid a regular file so the directory cannot be created.
    fs.mkdirSync(path.join(projectRoot, 'public', 'burned'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'public', 'burned', 'vid'), 'not a directory');
    const applied = service.apply('vid', state.sourceHash!);
    assert.equal(applied.applied, 1);
    assert.match(applied.exportError || '', /重寫失敗/);
    assert.match(service.get('vid').exportError || '', /重寫失敗/);
    const row = db.prepare('SELECT segments_zh FROM summaries WHERE id=?').get('vid') as { segments_zh: string };
    assert.equal(JSON.parse(row.segments_zh)[0].text, '對吧？不會有那麼多你得跨過的瓶頸。', 'the database write is kept and reported');
    fs.rmSync(path.join(projectRoot, 'public', 'burned', 'vid'));
    const retried = service.exportAgain('vid');
    assert.equal(retried.exportError, null);
    assert.ok(fs.existsSync(path.join(projectRoot, 'public', 'burned', 'vid', 'vid.zh.srt')));
    assert.match(fs.readFileSync(path.join(projectRoot, 'public', 'burned', 'vid', 'vid.zh.srt'), 'utf8'), /不會有那麼多你得跨過的瓶頸/);

    // Changing the source after applying makes the batch unsafe to revert.
    db.prepare('UPDATE summaries SET segments=? WHERE id=?').run(JSON.stringify(segments.map((cue, index) => index === 2 ? { ...cue, text: 'Changed.' } : cue)), 'vid');
    assert.throws(() => service.revertLast('vid'), /無法安全還原/);
  } finally { exporting.db.close(); }
});

test('work status is re-checked inside the transaction, and overwritten applied lines are detected and can be reapplied', async () => {
  const { db, service } = serviceFixture(fakeRequest({ "right? There's not": '對吧？不會有那麼多你得跨過的瓶頸。' }));
  try {
    service.start('vid', { scope: 'flagged', limit: 40 }); await service.settled('vid');
    const state = service.get('vid');
    service.decide('vid', state.sourceHash!, [0], 'approved');
    // 另一個工作在我們讀完列之後才把字幕標成 processing：交易內重驗必須擋下。
    const originalPrepare = db.prepare.bind(db);
    let injected = false;
    db.prepare = ((sql: string) => {
      const statement = originalPrepare(sql);
      if (!injected && sql.startsWith('SELECT * FROM subtitle_review_candidates')) { injected = true; originalPrepare("UPDATE summaries SET subtitle_status='processing' WHERE id=?").run('vid'); }
      return statement;
    }) as typeof db.prepare;
    try { assert.throws(() => service.apply('vid', state.sourceHash!), /工作進行中/); } finally { db.prepare = originalPrepare; }
    db.prepare("UPDATE summaries SET subtitle_status='complete' WHERE id=?").run('vid');
    assert.equal(service.apply('vid', state.sourceHash!).applied, 1);
    // 整片重新翻譯把那句蓋回舊譯文：get 要看得出漂移，reapply 要能補回去。
    const zh = JSON.parse((db.prepare('SELECT segments_zh FROM summaries WHERE id=?').get('vid') as { segments_zh: string }).segments_zh);
    zh[0].text = '對？這些瓶頸你都得克服。';
    db.prepare('UPDATE summaries SET segments_zh=? WHERE id=?').run(JSON.stringify(zh), 'vid');
    const drifted = service.get('vid');
    assert.equal(drifted.drifted, 1);
    assert.equal(drifted.candidates.find(item => item.cueIndex === 0)!.current, '對？這些瓶頸你都得克服。', 'current is recomputed from the live subtitles');
    // 另一句只是「已採用尚未套用」：reapply 不能順手把它也寫進去；失敗時決定狀態要回滾。
    service.decide('vid', drifted.sourceHash!, [1], 'approved');
    db.prepare("UPDATE summaries SET subtitle_status='processing' WHERE id=?").run('vid');
    assert.throws(() => service.reapply('vid', drifted.sourceHash!), /工作進行中/);
    assert.equal(service.get('vid').drifted, 1, 'a failed reapply keeps the drift warning');
    db.prepare("UPDATE summaries SET subtitle_status='complete' WHERE id=?").run('vid');
    const reapplied = service.reapply('vid', drifted.sourceHash!);
    assert.equal(reapplied.applied, 1, 'only the drifted line is rewritten');
    const after = service.get('vid');
    assert.equal(after.drifted, 0);
    assert.equal(after.candidates.find(item => item.cueIndex === 1)!.decision, 'approved', 'the other approved line is untouched');
    assert.equal(JSON.parse((db.prepare('SELECT segments_zh FROM summaries WHERE id=?').get('vid') as { segments_zh: string }).segments_zh)[0].text, '對吧？不會有那麼多你得跨過的瓶頸。');
  } finally { db.close(); }
});

test('reapply works when the video is addressed by its video_id alias', async () => {
  const { db, service } = serviceFixture(fakeRequest({ "right? There's not": '對吧？不會有那麼多你得跨過的瓶頸。' }));
  try {
    db.prepare("UPDATE summaries SET video_id='alias-video' WHERE id='vid'").run();
    service.start('alias-video', { scope: 'flagged', limit: 40 }); await service.settled('alias-video');
    const state = service.get('alias-video');
    service.decide('alias-video', state.sourceHash!, [0], 'approved');
    assert.equal(service.apply('alias-video', state.sourceHash!).applied, 1);
    const zh = JSON.parse((db.prepare('SELECT segments_zh FROM summaries WHERE id=?').get('vid') as { segments_zh: string }).segments_zh);
    zh[0].text = '對？這些瓶頸你都得克服。';
    db.prepare('UPDATE summaries SET segments_zh=? WHERE id=?').run(JSON.stringify(zh), 'vid');
    assert.equal(service.get('alias-video').drifted, 1);
    assert.equal(service.reapply('alias-video', state.sourceHash!).applied, 1);
    assert.equal(service.get('alias-video').drifted, 0);
  } finally { db.close(); }
});

test('candidates from finished windows survive a later failure in the same run', async () => {
  let calls = 0;
  const request: typeof requestLocalTranslation = async input => { calls++; if (calls > 1) throw new Error('boom'); return fakeRequest({})(input); };
  const { db, service } = serviceFixture(request);
  try {
    service.start('vid', { scope: 'all', limit: 40 }); await service.settled('vid');
    const state = service.get('vid');
    assert.ok(['partial', 'failed'].includes(state.status), state.status);
    assert.ok(state.candidates.length > 0, 'the first window was saved before the failure');
  } finally { db.close(); }
});

test('service refuses cloud mode, a second run on already covered windows, and applying nothing is a no-op', async () => {
  const { db, service } = serviceFixture(fakeRequest({}));
  try {
    const cloud = new SubtitleReviewService({ db, store: new SubtitleReviewStore(db), model: () => 'x', processingMode: () => 'cloud', glossary: () => DEFAULT_GLOSSARY, request: fakeRequest({}) });
    assert.throws(() => cloud.start('vid', { scope: 'flagged', limit: 10 }), /本機模式/);
    service.start('vid', { scope: 'all', limit: 10 });
    await service.settled('vid');
    assert.throws(() => service.start('vid', { scope: 'all', limit: 10 }), /已有候選/);
    const response = service.get('vid');
    const nothing = service.apply('vid', response.sourceHash!);
    assert.equal(nothing.applied, 0);
    // Re-running a specific window overwrites its candidate but keeps prior approvals of identical text.
    service.decide('vid', response.sourceHash!, [2], 'approved');
    const rerun = service.start('vid', { scope: 'windows', limit: 10, windowKeys: [response.windows.find(w => w.cueIndexes.includes(2))!.key] });
    assert.equal(rerun.accepted, true);
    await service.settled('vid');
    assert.equal(service.get('vid').candidates.find(item => item.cueIndex === 2)!.decision, 'approved');
  } finally { db.close(); }
});

test('re-running a chosen window calls the model again, and candidates from an older review version do not count as done', async () => {
  let calls = 0;
  const answers = { "right? There's not": '對吧？不會有那麼多你得跨過的瓶頸。', 'We made millions': '我們去年用 Midjourney 賺了好幾百萬。' };
  const request: typeof requestLocalTranslation = async input => { calls++; return fakeRequest(answers)(input); };
  const { db, service } = serviceFixture(request);
  try {
    service.start('vid', { scope: 'windows', limit: 40, windowKeys: ['w-0-0'] });
    await service.settled('vid');
    assert.equal(calls, 1);
    assert.equal(service.get('vid').outdated, 0);
    // 人工「重新校訂本窗」：同樣的原文與提示也要真的再叫一次模型，不能只重讀檢查點。
    service.start('vid', { scope: 'windows', limit: 40, windowKeys: ['w-0-0'] });
    await service.settled('vid');
    assert.equal(calls, 2, 'a manual re-run bypasses the checkpoint cache');
    // 一般續跑仍吃快取：同一窗不會再推論。
    service.start('vid', { scope: 'windows', limit: 40, windowKeys: ['w-1-1'] });
    await service.settled('vid');
    assert.equal(calls, 3);
    assert.throws(() => service.start('vid', { scope: 'flagged', limit: 40 }), /已有候選/);
    // 升版：舊版本的候選要被標成 outdated，且高風險視窗重新排隊。真實升版時檢查點的鍵含版本，不會命中舊快取，這裡把檢查點清掉來模擬。
    db.prepare("UPDATE subtitle_review_candidates SET version='subtitle-review-v1-discourse-window' WHERE cue_index=0").run();
    db.prepare('DELETE FROM subtitle_review_checkpoints').run();
    const upgraded = service.get('vid');
    assert.equal(upgraded.outdated, 1);
    assert.equal(upgraded.candidates.find(item => item.cueIndex === 0)?.outdated, true);
    assert.equal(upgraded.candidates.find(item => item.cueIndex === 1)?.outdated, false);
    service.start('vid', { scope: 'flagged', limit: 40 });
    await service.settled('vid');
    assert.equal(calls, 4, 'only the outdated window is re-run');
    assert.equal(service.get('vid').outdated, 0);
    // 同窗有一句已寫回（舊版）不算 outdated，但也不擋這一窗的其餘舊候選升版。
    db.prepare("UPDATE subtitle_review_candidates SET version='subtitle-review-v1-discourse-window', decision='applied' WHERE cue_index=1").run();
    assert.equal(service.get('vid').outdated, 0);
    db.prepare('DELETE FROM subtitle_review_checkpoints').run();
    service.start('vid', { scope: 'flagged', limit: 40 });
    await service.settled('vid');
    assert.equal(calls, 5, 'an applied v1 sentence does not block re-running its window');
    assert.equal(service.get('vid').candidates.find(item => item.cueIndex === 1)?.decision, 'applied', 'same text keeps the applied decision');
  } finally { db.close(); }
});

test('a video with no translation yet can take an external one as its first, and only once', async () => {
  const { db, service } = serviceFixture(fakeRequest({}), { zh: [] });
  db.prepare('UPDATE summaries SET segments_zh=NULL, transcript_zh=NULL, is_translated=0 WHERE id=?').run('vid');
  try {
    const view = service.get('vid');
    assert.equal(view.counts.windows > 0, true, 'an untranslated video can still be prepared');
    assert.deepEqual(view.candidates, []);
    const sourceHash = view.sourceHash!;
    const store = new SubtitleReviewStore(db);
    const started = store.start('vid', sourceHash, 'external:test', 'v', 1);
    const cues = JSON.parse((db.prepare('SELECT segments FROM summaries WHERE id=?').get('vid') as { segments: string }).segments) as Array<{ start: number; end: number; text: string }>;
    store.saveCandidates('vid', started.token!, sourceHash, 'external:test', cues.map((cue, index) => ({
      cueIndex: index, cueId: `cue-${index}`, windowKey: 'w-0-0', start: cue.start, end: cue.end, source: cue.text, current: null,
      candidate: `外部第${index}句`, flags: [], changed: true, notes: [], decision: 'candidate' as const,
    })), 'v');
    store.decide('vid', sourceHash, cues.map((_, index) => index), 'approved');
    const applied = service.apply('vid', sourceHash);
    assert.equal(applied.applied, cues.length, 'every line lands');
    const row = db.prepare('SELECT segments_zh, is_translated FROM summaries WHERE id=?').get('vid') as { segments_zh: string; is_translated: number };
    assert.equal(row.is_translated, 1, 'the video is now translated');
    assert.deepEqual(JSON.parse(row.segments_zh).map((cue: { text: string }) => cue.text), cues.map((_, index) => `外部第${index}句`));
    // 第二次套用同一批：內容已經一樣，不再重寫，也不會把別人寫進去的東西蓋掉。
    assert.equal(service.apply('vid', sourceHash).applied, 0);
  } finally { db.close(); }
});
