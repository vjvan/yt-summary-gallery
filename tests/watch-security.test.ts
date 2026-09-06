import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPairingRequest, assertWatchRequest, readWatchJson, watchHeaders } from '../lib/watch/security';
const TOKEN = 'a'.repeat(64);
const request = (headers: Record<string,string> = {}, url = 'http://127.0.0.1:3000/api/watch/window') => new Request(url, { headers });

test('pairing is same-origin only; hostile sites and extensions cannot retrieve the token', () => {
  assert.doesNotThrow(() => assertPairingRequest(request({ 'sec-fetch-site': 'same-origin' })));
  for (const origin of ['https://youtube.com', 'https://evil.example', 'null', `chrome-extension://${'a'.repeat(32)}`]) {
    assert.throws(() => assertPairingRequest(request({ origin })));
  }
  assert.throws(() => assertPairingRequest(request({ 'sec-fetch-site': 'cross-site' })));
  assert.throws(() => assertPairingRequest(request({ host: 'evil.example' })));
});
test('only paired local/extension callers can access watch endpoints', () => {
  assert.doesNotThrow(() => assertWatchRequest(request({ authorization: `Bearer ${TOKEN}` }), TOKEN));
  assert.doesNotThrow(() => assertWatchRequest(request({ origin: `chrome-extension://${'b'.repeat(32)}`, authorization: `Bearer ${TOKEN}` }), TOKEN));
  assert.throws(() => assertWatchRequest(request(), TOKEN));
  assert.throws(() => assertWatchRequest(request({ authorization: `Bearer ${'é'.repeat(64)}` }), TOKEN));
  assert.throws(() => assertWatchRequest(request({ origin: 'https://evil.example', authorization: `Bearer ${TOKEN}` }), TOKEN));
  assert.throws(() => assertWatchRequest(request({ authorization: `Bearer ${TOKEN}` }, 'http://evil.example/api/watch/window'), TOKEN));
});
test('CORS echoes only an allowed origin, never wildcard', () => {
  const extension = `chrome-extension://${'c'.repeat(32)}`;
  assert.equal(watchHeaders(request({ origin: extension })).get('Access-Control-Allow-Origin'), extension);
  assert.throws(() => watchHeaders(request({ origin: 'http://evil.example' })));
});
test('Next production internal localhost alias accepts the real loopback Host without weakening Origin checks', () => {
  const normalized = (host:string,origin:string) => request({host,origin,'sec-fetch-site':'same-origin',authorization:`Bearer ${TOKEN}`},'http://localhost:3000/api/watch/pair');
  const sameBrowser = normalized('127.0.0.1:3000','http://127.0.0.1:3000');
  assert.doesNotThrow(()=>assertPairingRequest(sameBrowser));
  assert.doesNotThrow(()=>assertWatchRequest(sameBrowser,TOKEN));
  assert.equal(watchHeaders(sameBrowser).get('Access-Control-Allow-Origin'),'http://127.0.0.1:3000');
  for (const host of ['evil.example:3000','127.0.0.1:4000','localhost.evil.example:3000','user@localhost:3000','localhost:3000/path','127.1:3000']) {
    assert.throws(()=>assertPairingRequest(normalized(host,'http://127.0.0.1:3000')));
  }
  assert.throws(()=>assertPairingRequest(normalized('127.0.0.1:3000','http://localhost:3000')));
  assert.throws(()=>assertPairingRequest(normalized('127.0.0.1:3000','https://youtube.com')));
});
test('JSON body enforces content type, object shape and byte bound', async () => {
  const body = (data: string, content = 'application/json') => new Request('http://localhost/api/watch/window', { method: 'POST', headers: { 'content-type': content }, body: data });
  assert.deepEqual(await readWatchJson(body('{"time":1}')), { time: 1 });
  await assert.rejects(readWatchJson(body('[]')));
  await assert.rejects(readWatchJson(body('{}', 'text/plain')));
  await assert.rejects(readWatchJson(body(JSON.stringify({ x: 'a'.repeat(5000) }))));
});
