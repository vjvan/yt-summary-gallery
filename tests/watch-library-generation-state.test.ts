import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryGenerationState } from '../lib/library-generation-state';

test('摘要完成但字幕處理中不能停止查詢或宣稱完整', () => {
  const result = libraryGenerationState({status:'done', summary:{title:'test'}, subtitle_status:'processing', subtitle_completed:256, subtitle_total:1632});
  assert.equal(result.keepPolling, true);
  assert.equal(result.status, 'processing');
  assert.match(result.message, /256／1632/);
  assert.match(result.message, /摘要已可閱讀/);
});
test('部分字幕失敗保持摘要可讀，不能假冒完成', () => {
  const result = libraryGenerationState({status:'done', summary:{}, subtitle_status:'partial', subtitle_completed:1631, subtitle_total:1632});
  assert.equal(result.status,'error'); assert.equal(result.keepPolling,false);
  assert.match(result.message,/尚未全部完成/);
});
test('真正完整才提示整片成功', () => {
  const result = libraryGenerationState({status:'done', subtitle_status:'complete', subtitle_completed:1632, subtitle_total:1632});
  assert.equal(result.status,'done'); assert.match(result.message,/摘要與完整字幕已完成/);
});
test('舊格式done不冒稱中文全部完成', () => {
  assert.doesNotMatch(libraryGenerationState({status:'done'}).message,/完整字幕已完成/);
});
test('摘要本身失敗必須顯示錯誤', () => {
  assert.equal(libraryGenerationState({status:'error',error:'字幕來源無法取得'}).message,'字幕來源無法取得');
});

test('摘要階段不冒稱正在逐句翻譯', () => {
  const state = libraryGenerationState({pipeline_stage:'library_summarizing',subtitle_status:'processing',subtitle_completed:262,subtitle_total:1632});
  assert.equal(state.keepPolling,true); assert.match(state.message,/正在整理全文摘要/);
});
test('字幕完整但圖卡仍繪製中繼續輪詢', () => {
  const state = libraryGenerationState({status:'done',subtitle_status:'complete',pipeline_stage:'library_rendering'});
  assert.equal(state.keepPolling,true); assert.equal(state.status,'processing');
});
test('完整字幕不掩蓋圖卡失敗', () => {
  const state = libraryGenerationState({status:'done',subtitle_status:'complete',subtitle_completed:8,subtitle_total:8,pipeline_stage:'done',error:'圖卡繪製尚未完成'});
  assert.equal(state.status,'error'); assert.match(state.message,/完整字幕已完成/); assert.match(state.message,/圖卡繪製尚未完成/);
});
