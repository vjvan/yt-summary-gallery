import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { WatchService } from '../lib/watch/service';
import { WatchStore } from '../lib/watch/store';
import { libraryTranslationsFrom } from '../lib/watch/library-lookup';
import type { WatchCue, WatchProviderInfo } from '../lib/watch/types';

// 影片庫已有翻好的字幕時，原站擴充與 /watch 直接用，不再逐句跑模型；命中句回寫快取。
const videoId = 'kfbWz9_bJoA';
const cues: WatchCue[] = [
  { id: 'cue-0', start: 0, end: 4, text: 'The compositor node.' },
  { id: 'cue-1', start: 4, end: 8, text: 'It has the potential to change everything.' },
  { id: 'cue-2', start: 8, end: 12, text: 'This line is only in the extension.' },
];

function libraryDb(rows: Array<{ start: number; text: string; zh: string }>) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE summaries (id TEXT PRIMARY KEY, video_id TEXT, is_translated INTEGER, segments TEXT, segments_zh TEXT)');
  db.prepare('INSERT INTO summaries VALUES (?,?,?,?,?)').run('sum', videoId, 1,
    JSON.stringify(rows.map(row => ({ start: row.start, end: row.start + 4, text: row.text }))),
    JSON.stringify(rows.map(row => ({ start: row.start, end: row.start + 4, text: row.zh }))));
  return db;
}

function fixture(mode: 'local' | 'cloud', library: ReturnType<typeof libraryTranslationsFrom>) {
  const store = new WatchStore(':memory:');
  let calls = 0;
  const translatedIds: string[] = [];
  const provider = (): WatchProviderInfo => ({ processingMode: mode, unlimited: mode === 'local', translationModel: 'mock', translationConfigured: true, audioConfigured: false });
  const service = new WatchService({
    store, provider,
    source: async () => ({ videoId, title: 'fixture', language: 'en', sourceKind: 'manual', trackId: 'fixture', cues }),
    translate: async ({ targets }) => { calls++; translatedIds.push(...targets.map(cue => cue.id)); return targets.map(cue => ({ ...cue, originalText: cue.text, text: `模型${cue.id.replace('cue-', '')}` })); },
    glossary: () => ({ no_translate_terms: [], term_map: [], style_rules: [] }), enabled: () => true, limits: () => ({ sessionCalls: 25, dailyCalls: 100 }),
    library: () => library,
  });
  return { service, store, counters: { get calls() { return calls; }, translatedIds } };
}

test('library lookup matches identical source text within a few seconds and ignores other segmentations', () => {
  const library = libraryTranslationsFrom(libraryDb([
    { start: 0, text: 'The compositor node.', zh: '合成器節點。' },
    { start: 4.2, text: 'It has the potential to change everything.', zh: '它有潛力改變一切。' },
    { start: 600, text: 'The compositor node.', zh: '（很後面的同一句）' },
  ]), videoId)!;
  assert.equal(library.size, 2);
  assert.deepEqual(library.find(cues[0]), { id: 'cue-0', start: 0, end: 4, text: '合成器節點。', originalText: 'The compositor node.' });
  assert.equal(library.find(cues[1])?.text, '它有潛力改變一切。', 'a 0.2s start drift still matches');
  assert.equal(library.find({ id: 'x', start: 300, end: 304, text: 'The compositor node.' }), null, 'same text far away in time is not a match');
  assert.equal(library.find(cues[2]), null);
  assert.equal(libraryTranslationsFrom(libraryDb([]), 'nope'), null);
  const broken = new Database(':memory:');
  broken.exec('CREATE TABLE summaries (id TEXT PRIMARY KEY, video_id TEXT, is_translated INTEGER, segments TEXT, segments_zh TEXT)');
  broken.prepare('INSERT INTO summaries VALUES (?,?,?,?,?)').run('sum', videoId, 1, '[{"start":0,"end":1,"text":"a"}]', 'not json');
  assert.equal(libraryTranslationsFrom(broken, videoId), null, 'broken rows are a miss, never a crash');
});

test('local mode: library hits come back as cachedCues, are written to the cue cache, and only the missing cue goes to the model', async () => {
  const library = libraryTranslationsFrom(libraryDb([
    { start: 0, text: 'The compositor node.', zh: '合成器節點。' },
    { start: 4, text: 'It has the potential to change everything.', zh: '它有潛力改變一切。' },
  ]), videoId);
  const { service, counters } = fixture('local', library);
  const created = await service.start(`https://www.youtube.com/watch?v=${videoId}`);
  assert.deepEqual(created.cachedCues?.map(cue => [cue.id, cue.text]), [['cue-0', '合成器節點。'], ['cue-1', '它有潛力改變一切。']]);
  assert.equal(counters.calls, 0, 'opening the video calls no model');
  const window = await service.window(created.sessionId, 0, true);
  assert.equal(counters.calls, 1);
  assert.deepEqual(counters.translatedIds, ['cue-2'], 'only the cue the library does not have is translated');
  assert.deepEqual(window.cues.map(cue => cue.text), ['合成器節點。', '它有潛力改變一切。', '模型2']);
  // 第二次開同一支影片：庫內命中已經在快取裡，就算庫查不到也不會再叫模型。
  const again = fixture('local', null);
  const second = await again.service.start(`https://www.youtube.com/watch?v=${videoId}`);
  assert.equal(second.cachedCues?.length, 0, 'a fresh store without the library has nothing cached');
  const reopened = await service.start(`https://www.youtube.com/watch?v=${videoId}`);
  assert.equal(reopened.cachedCues?.length, 3, 'the same store now holds all three from cache');
  assert.equal(counters.calls, 1);
});

test('cloud mode: a window fully covered by the library is served from it without a paid call; a partial window still goes to the cloud', async () => {
  const full = fixture('cloud', libraryTranslationsFrom(libraryDb([
    { start: 0, text: 'The compositor node.', zh: '合成器節點。' },
    { start: 4, text: 'It has the potential to change everything.', zh: '它有潛力改變一切。' },
    { start: 8, text: 'This line is only in the extension.', zh: '這句只有擴充有。' },
  ]), videoId));
  const created = await full.service.start(`https://www.youtube.com/watch?v=${videoId}`);
  assert.equal(created.cachedCues, undefined, 'cloud sessions keep their existing shape');
  const window = await full.service.window(created.sessionId, 0, true);
  assert.equal(window.cached, true);
  assert.equal(full.counters.calls, 0);
  assert.deepEqual(window.cues.map(cue => cue.text), ['合成器節點。', '它有潛力改變一切。', '這句只有擴充有。']);
  const partial = fixture('cloud', libraryTranslationsFrom(libraryDb([{ start: 0, text: 'The compositor node.', zh: '合成器節點。' }]), videoId));
  const partialSession = await partial.service.start(`https://www.youtube.com/watch?v=${videoId}`);
  await partial.service.window(partialSession.sessionId, 0, true);
  assert.equal(partial.counters.calls, 1, 'cloud mode translates the whole window when any cue is missing');
});

test('the library beats a stale per-cue and window cache from an earlier full prefetch, and overwrites it', async () => {
  const library = libraryTranslationsFrom(libraryDb([
    { start: 0, text: 'The compositor node.', zh: '合成器節點（校訂後）。' },
    { start: 4, text: 'It has the potential to change everything.', zh: '它有潛力改變一切（校訂後）。' },
    { start: 8, text: 'This line is only in the extension.', zh: '這句也在庫裡了。' },
  ]), videoId);
  // 先用沒有庫的服務把整片預譯進快取（模擬先前的整片預譯）。
  const stale = fixture('local', null);
  const first = await stale.service.start(`https://www.youtube.com/watch?v=${videoId}`);
  const staleWindow = await stale.service.window(first.sessionId, 0, true);
  assert.deepEqual(staleWindow.cues.map(cue => cue.text), ['模型0', '模型1', '模型2']);
  // 同一個快取，接上影片庫：開影片就拿到庫內譯文，整窗也不再回舊快取，且舊快取被覆寫。
  const service = new WatchService({
    store: stale.store, provider: () => ({ processingMode: 'local', unlimited: true, translationModel: 'mock', translationConfigured: true, audioConfigured: false }),
    source: async () => ({ videoId, title: 'fixture', language: 'en', sourceKind: 'manual', trackId: 'fixture', cues }),
    translate: async () => { throw new Error('must not translate'); },
    glossary: () => ({ no_translate_terms: [], term_map: [], style_rules: [] }), enabled: () => true, limits: () => ({ sessionCalls: 25, dailyCalls: 100 }),
    library: () => library,
  });
  const created = await service.start(`https://www.youtube.com/watch?v=${videoId}`);
  assert.deepEqual(created.cachedCues?.map(cue => cue.text), ['合成器節點（校訂後）。', '它有潛力改變一切（校訂後）。', '這句也在庫裡了。']);
  const window = await service.window(created.sessionId, 0, true);
  assert.equal(window.cached, true);
  assert.deepEqual(window.cues.map(cue => cue.text), ['合成器節點（校訂後）。', '它有潛力改變一切（校訂後）。', '這句也在庫裡了。']);
  // 庫之後拿掉（例如影片被刪），快取裡留的是庫內版本，不是舊模型輸出。
  const afterwards = fixture('local', null);
  const reopened = await new WatchService({
    store: stale.store, provider: () => ({ processingMode: 'local', unlimited: true, translationModel: 'mock', translationConfigured: true, audioConfigured: false }),
    source: async () => ({ videoId, title: 'fixture', language: 'en', sourceKind: 'manual', trackId: 'fixture', cues }),
    translate: async () => { throw new Error('must not translate'); },
    glossary: () => ({ no_translate_terms: [], term_map: [], style_rules: [] }), enabled: () => true, limits: () => ({ sessionCalls: 25, dailyCalls: 100 }),
  }).start(`https://www.youtube.com/watch?v=${videoId}`);
  void afterwards;
  assert.deepEqual(reopened.cachedCues?.map(cue => cue.text), ['合成器節點（校訂後）。', '它有潛力改變一切（校訂後）。', '這句也在庫裡了。']);
});

test('cloud mode: a partially covered window still uses its own window cache on re-read instead of paying again', async () => {
  const partial = fixture('cloud', libraryTranslationsFrom(libraryDb([{ start: 0, text: 'The compositor node.', zh: '合成器節點。' }]), videoId));
  const created = await partial.service.start(`https://www.youtube.com/watch?v=${videoId}`);
  const first = await partial.service.window(created.sessionId, 0, true);
  assert.equal(partial.counters.calls, 1);
  assert.equal(first.cached, false);
  const second = await partial.service.window(created.sessionId, 0, true);
  assert.equal(partial.counters.calls, 1, 'the second read is served from the window cache');
  assert.equal(second.cached, true);
  assert.deepEqual(second.cues.map(cue => cue.text), first.cues.map(cue => cue.text));
});

test('library lookup refuses ambiguous repeats, misaligned rows and untranslated leftovers', async () => {
  // 同一句原文兩個不同譯文、另一軌整體延後 3 秒：兩個都在 5 秒內，最近的又不夠近，交回模型。
  const repeats = libraryTranslationsFrom(libraryDb([
    { start: 10, text: 'Right.', zh: '對。' },
    { start: 14, text: 'Right.', zh: '右邊。' },
  ]), videoId)!;
  assert.equal(repeats.find({ id: 'a', start: 13, end: 14, text: 'Right.' }), null);
  assert.equal(repeats.find({ id: 'b', start: 17, end: 18, text: 'Right.' })?.text, '右邊。', '17s only has one candidate within range, and it is the right one for a 3s shift');
  assert.equal(repeats.find({ id: 'c', start: 10.3, end: 11, text: 'Right.' })?.text, '對。', 'almost exact timing with the rival 3.7s away is safe');
  const same = libraryTranslationsFrom(libraryDb([{ start: 10, text: 'Right.', zh: '對。' }, { start: 14, text: 'Right.', zh: '對。' }]), videoId)!;
  assert.equal(same.find({ id: 'd', start: 13, end: 14, text: 'Right.' })?.text, '對。', 'identical translations are not ambiguous');
  // 譯文陣列時間對不上原文（重排過）或缺時間：整列跳過，不補造 0 秒。
  const db = new Database(':memory:');
  db.exec('CREATE TABLE summaries (id TEXT PRIMARY KEY, video_id TEXT, is_translated INTEGER, segments TEXT, segments_zh TEXT)');
  db.prepare('INSERT INTO summaries VALUES (?,?,?,?,?)').run('sum', videoId, 1,
    JSON.stringify([{ start: 0, end: 4, text: 'The compositor node.' }, { end: 8, text: 'It has the potential to change everything.' }]),
    JSON.stringify([{ start: 99, end: 103, text: '（99 秒的譯文）' }, { start: 4, end: 8, text: '它有潛力改變一切。' }]));
  const misaligned = libraryTranslationsFrom(db, videoId);
  assert.equal(misaligned, null, 'nothing usable survives validation');
  // 舊管線失敗留下英文原句：不當成命中；但譯文裡合理保留的品牌名不受影響。
  const leftover = libraryTranslationsFrom(libraryDb([{ start: 0, text: 'The compositor node.', zh: 'The compositor node.' }]), videoId);
  const { service, counters } = fixture('local', leftover);
  const created = await service.start(`https://www.youtube.com/watch?v=${videoId}`);
  assert.equal(created.cachedCues?.length, 0, 'an untranslated library row is not a hit');
  await service.window(created.sessionId, 0, true);
  assert.equal(counters.calls, 3, 'all three cues fall through to the model, one call each');
  // 好譯文裡保留的品牌與工具名（podcast、HeyGen）不能被守門誤殺。
  const brands = libraryTranslationsFrom(libraryDb([
    { start: 0, text: 'The compositor node.', zh: '我聽 podcast 學會用 HeyGen 做 vibe coding。' },
    { start: 4, text: 'It has the potential to change everything.', zh: '它有潛力改變一切。' },
    { start: 8, text: 'This line is only in the extension.', zh: '這句也在庫裡。' },
  ]), videoId);
  const kept = fixture('local', brands);
  const opened = await kept.service.start(`https://www.youtube.com/watch?v=${videoId}`);
  assert.equal(opened.cachedCues?.length, 3, 'translations that keep brand names are still hits');
  assert.equal(kept.counters.calls, 0);
});
