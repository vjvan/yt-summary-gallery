import test from 'node:test';
import assert from 'node:assert/strict';
import { GET, POST, PATCH } from '../app/api/summaries/[id]/learning/route';
import { readLearningPatchJson } from '../lib/learning/http';
const context = { params: Promise.resolve({ id: 'video' }) };
test('private GET/POST/PATCH reject remote host and cross-origin requests before accessing database', async () => {
  for (const method of ['GET', 'POST', 'PATCH'] as const) {
    for (const url of ['https://remote.example/api/summaries/video/learning', 'http://127.0.0.1:3000/api/summaries/video/learning']) {
      const request = new Request(url, { method, headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, ...(method !== 'GET' ? { body: '{}' } : {}) });
      const response = await ({ GET, POST, PATCH }[method])(request, context);
      assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
    }
  }
});
test('missing explicit consent and invalid JSON rejected without starting model', async () => {
  const request = new Request('http://localhost:3000/api/summaries/video/learning', { method: 'POST', headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'generate' }) });
  assert.equal((await POST(request, context)).status, 400);
});
test('PATCH reader bounds bytes and accepts valid maximum CJK implementation notes', async () => {
  const value = { sourceHash: 'a'.repeat(64), pointId: 'point-1234567890abcdef', implementation: { action: '中'.repeat(1200), result: '文'.repeat(1600), observedAt: '2026-09-07T08:00:00.000Z' } };
  const make = (body: string) => new Request('http://localhost:3000/', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body });
  assert.deepEqual(await readLearningPatchJson(make(JSON.stringify(value))), value);
  await assert.rejects(readLearningPatchJson(make('x'.repeat(12300))));
});
