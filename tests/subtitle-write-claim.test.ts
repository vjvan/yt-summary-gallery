import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { claimSubtitleWrite, subtitleWriteActive, SUBTITLE_CLAIM_TTL_MS } from '../lib/subtitle-writers';

// 整片重譯會讀出原文、跑幾分鐘模型、最後無條件覆寫中譯；claim 讓匯入與校訂在那段期間拒絕寫入。
function fixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE summaries (id TEXT PRIMARY KEY, video_id TEXT)');
  db.prepare('INSERT INTO summaries VALUES (?,?)').run('sum', 'vid');
  return db;
}

test('a claim is exclusive across processes, releases only its own token, and expires on its own', () => {
  const db = fixture();
  assert.equal(subtitleWriteActive('sum', db), false);
  const release = claimSubtitleWrite('sum', db)!;
  assert.ok(release);
  assert.equal(subtitleWriteActive('sum', db), true, 'the claim is visible to any process reading this database');
  assert.equal(claimSubtitleWrite('sum', db), null, 'a second writer cannot claim');
  release();
  assert.equal(subtitleWriteActive('sum', db), false);
  const second = claimSubtitleWrite('sum', db)!;
  assert.ok(second, 'the slot is free again after release');
  release();
  assert.equal(subtitleWriteActive('sum', db), true, 'a stale release function does not free the new claim');
  second();
  // 程序當掉沒釋放（資料庫留著別的 process 的 token）：到期後自動回收。
  db.prepare('UPDATE summaries SET subtitle_write_token=?, subtitle_write_until=? WHERE id=?').run('w-crashed', Date.now() - 1000, 'sum');
  assert.equal(subtitleWriteActive('sum', db), false, 'an expired claim no longer blocks readers');
  assert.ok(claimSubtitleWrite('sum', db), 'an expired claim can be taken over');
  db.prepare('UPDATE summaries SET subtitle_write_token=?, subtitle_write_until=? WHERE id=?').run('w-live', Date.now() + SUBTITLE_CLAIM_TTL_MS, 'sum');
  assert.equal(claimSubtitleWrite('sum', db), null, 'a live claim from another process blocks us');
  assert.equal(claimSubtitleWrite('missing', db), null, 'an unknown video claims nothing');
});
