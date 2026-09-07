import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyWatchReply } from '../scripts/redirect-legacy-watch.mjs';

test('舊入口只把瀏覽頁導回3000，保留路徑', () => {
  const result=legacyWatchReply({method:'GET',host:'127.0.0.1:3111',url:'/watch?url=example'});
  assert.equal(result.status,307); assert.equal(result.headers.Location,'http://127.0.0.1:3000/watch?url=example');
});
test('舊 API 不轉送 body 或配對憑證', () => {
  for (const method of ['POST','PUT','DELETE']) assert.equal(legacyWatchReply({method,host:'127.0.0.1:3111',url:'/api/generate'}).status,409);
  assert.equal(legacyWatchReply({method:'GET',host:'127.0.0.1:3111',url:'/api/watch/pair'}).status,409);
});
test('拒絕外部Host與network-path open redirect', () => {
  assert.equal(legacyWatchReply({method:'GET',host:'evil.example:3111',url:'/'}).status,403);
  assert.equal(legacyWatchReply({method:'GET',host:'127.0.0.1:3111',url:'//evil.example'}).status,409);
});
