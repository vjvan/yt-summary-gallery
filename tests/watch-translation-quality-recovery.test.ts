import test from 'node:test';
import assert from 'node:assert/strict';
import { translateWatchWindow } from '../lib/watch/translator';
import { localCueMessages } from '../lib/watch/local-cue-translator';
import { missingProtectedTerms } from '../lib/watch/protected-terms';
import { WatchService } from '../lib/watch/service';
import { WatchStore } from '../lib/watch/store';
import { watchProviderInfo } from '../lib/watch/provider';
import type { Glossary } from '../lib/glossary-defaults';
import type { WatchCue, WatchSource } from '../lib/watch/types';

const glossary: Glossary = { no_translate_terms: ['Higgsfield'], term_map: [], style_rules: [] };
const targets: WatchCue[] = [
  { id: 'first', start: 173.36, end: 181.334, text: "Don't pull some Higgsfield stuff on me right now." },
  { id: 'second', start: 194.94, end: 202.64, text: 'The short is Higgsfield gonna Higgsfield.' },
];
const source: WatchSource = { videoId: 'N-tmQ_Can_o', title: 'Public podcast fixture', language: 'en', sourceKind: 'manual', trackId: 'quality-repair-fixture', cues: targets };
const input = { source, targets, before: [], after: [], glossary };
const envelope = (text: string) => Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ text }) } });
async function mockLocal(fetcher: typeof fetch, run: () => Promise<void>) {
  const oldFetch = globalThis.fetch, oldMode = process.env.WATCH_PROCESSING_MODE, oldModel = process.env.WATCH_LOCAL_MODEL;
  try {
    process.env.WATCH_PROCESSING_MODE = 'local'; process.env.WATCH_LOCAL_MODEL = 'qwen2.5:7b';
    globalThis.fetch = async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:11434/api/chat');
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      return fetcher(url, init);
    };
    await run();
  } finally {
    globalThis.fetch = oldFetch;
    if (oldMode === undefined) delete process.env.WATCH_PROCESSING_MODE; else process.env.WATCH_PROCESSING_MODE = oldMode;
    if (oldModel === undefined) delete process.env.WATCH_LOCAL_MODEL; else process.env.WATCH_LOCAL_MODEL = oldModel;
  }
}

test('two cues each receive one repair, including the second cue with two protected occurrences', async () => {
  const seen: string[] = [];
  const outputs = ['別拿希格斯場的事來煩我。', '現在別拿 Higgsfield 的事來煩我。', '簡單說，Higgsfield 就是老樣子。', '簡單說，Higgsfield 還是會做 Higgsfield 那一套。'];
  await mockLocal(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const data = JSON.parse(body.messages[1].content);
    seen.push(data.text ?? data.ordered_source_fragments.map((fragment: {text: string}) => fragment.text).join(''));
    if (seen.length === 2) assert.match(body.messages[0].content, /"name":"Higgsfield","occurrences":1/);
    if (seen.length === 4) {
      assert.deepEqual(body.format.required, ['p0', 'p1']);
      return Response.json({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ p0: '簡單說，就是 Higgsfield，', p1: '還是會做 Higgsfield 那一套。' }) } });
    }
    return envelope(outputs[seen.length - 1]);
  }, async () => {
    const result = await translateWatchWindow(input);
    assert.deepEqual(seen, [targets[0].text, targets[0].text, targets[1].text, targets[1].text]);
    assert.deepEqual(result.map(({ id, start, end, originalText }) => ({ id, start, end, originalText })), targets.map(cue => ({ id: cue.id, start: cue.start, end: cue.end, originalText: cue.text })));
    assert.deepEqual(missingProtectedTerms(result[1].text, ['Higgsfield', 'Higgsfield']), []);
  });
});

test('repair prompt communicates exact name counts without weakening duplicate postvalidation', () => {
  const message = localCueMessages(targets[1], glossary, true, ['Higgsfield'])[0].content;
  assert.match(message, /"name":"Higgsfield","occurrences":2/);
  assert.match(message, /exactly the specified number/);
  assert.match(message, /never append disconnected names/);
  assert.deepEqual(missingProtectedTerms('Higgsfield 就是老樣子。', ['Higgsfield', 'Higgsfield']), ['Higgsfield']);
});

test('eight cues needing repair make at most sixteen sequential calls', async () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: `bounded-${i}`, start: i * 5, end: i * 5 + 4, text: `Use Higgsfield for step ${i}.` }));
  let calls = 0, active = 0, peak = 0;
  await mockLocal(async () => {
    active++; peak = Math.max(peak, active); calls++;
    await new Promise<void>(resolve => setImmediate(resolve)); active--;
    return envelope(calls % 2 ? '使用希格斯場。' : '使用 Higgsfield。');
  }, async () => {
    const result = await translateWatchWindow({ ...input, source: { ...source, cues: eight }, targets: eight });
    assert.equal(result.length, 8); assert.equal(calls, 16); assert.equal(peak, 1);
  });
});

test('service isolates a failed sixteenth call, retains seven cue caches and retries only the missing cue', async () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: `uncached-${i}`, start: i * 5, end: i * 5 + 4, text: `Use Higgsfield for step ${i}.` }));
  const store = new WatchStore(':memory:'); let calls = 0, recovered = false, writes = 0;
  const originalPut = store.put.bind(store);
  store.put = (key, cues) => { writes++; originalPut(key, cues); };
  await mockLocal(async (_url, init) => {
    calls++; const step = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).text.match(/\d+/)?.[0] ?? '';
    return envelope(recovered || (calls % 2 === 0 && calls < 16) ? `使用 Higgsfield 做第 ${step} 步。` : `使用希格斯場做第 ${step} 步。`);
  }, async () => {
    const service = new WatchService({ store, provider: watchProviderInfo, source: async () => ({ ...source, cues: eight }), translate: translateWatchWindow, glossary: () => glossary, enabled: () => true, limits: () => ({ sessionCalls: null, dailyCalls: null }) });
    try {
      const session = await service.start('https://youtu.be/N-tmQ_Can_o');
      const partial = await service.window(session.sessionId, 0, true);
      assert.equal(partial.complete, false); assert.equal(partial.cached, false); assert.equal(partial.cues.length, 7);
      assert.equal(partial.failedCues?.length, 1); assert.equal(partial.failedCues?.[0].id, eight[7].id);
      assert.equal(partial.failedCues?.[0].code, 'LOCAL_TRANSLATION_QUALITY');
      assert.equal(calls, 16); assert.equal(writes, 7); assert.equal(store.used('local'), 1);
      recovered = true;
      const result = await service.window(session.sessionId, 0, true);
      assert.equal(result.cached, false); assert.equal(result.complete, true); assert.deepEqual(result.failedCues, []);
      assert.equal(result.cues.length, 8); assert.equal(calls, 17); assert.equal(writes, 9, 'eight validated cue entries and one complete window');
      assert.equal((await service.window(session.sessionId, 0, true)).cached, true); assert.equal(calls, 17);
      service.stop(session.sessionId);
    } finally { store.close(); }
  });
});

test('quality errors expose only safe cue timing and fixed copy; transport/provider errors remain separate', async () => {
  let calls = 0;
  await mockLocal(async () => { calls++; return envelope('普通的中文，未保留品牌。'); }, async () => {
    await assert.rejects(translateWatchWindow(input), (error: unknown) => {
      assert(error instanceof Error);
      const typed = error as Error & { code: string; status: number };
      assert.equal(typed.code, 'LOCAL_TRANSLATION_QUALITY'); assert.equal(typed.status, 502);
      assert.match(typed.message, /02:53–03:02/);
      assert.doesNotMatch(typed.message, /Higgsfield|Don.t pull|first|Public podcast/);
      return true;
    });
    assert.equal(calls, 2);
  });
  await mockLocal(async () => new Response('private-provider-payload', { status: 404 }), async () => {
    await assert.rejects(translateWatchWindow(input), { code: 'LOCAL_MODEL_NOT_FOUND', status: 503 });
  });
  await mockLocal(async () => envelope('不應呼叫'), async () => {
    await assert.rejects(translateWatchWindow({ ...input, provider: { processingMode: 'cloud', translationModel: 'gpt-4o-mini' } }), { code: 'SESSION_PROVIDER_CHANGED', status: 409 });
  });
});

test('cancel or whole-batch deadline during a repair stops all later calls and keeps its original error code', async () => {
  let calls = 0;
  const cancel = new AbortController();
  await mockLocal(async () => { calls++; if (calls === 2) cancel.abort(); return envelope('沒有品牌。'); }, async () => {
    await assert.rejects(translateWatchWindow({ ...input, signal: cancel.signal }), { code: 'CANCELLED', status: 499 });
    assert.equal(calls, 2);
  });
  const originalTimeout = AbortSignal.timeout, deadline = new AbortController(); let timers = 0; calls = 0;
  try {
    AbortSignal.timeout = (milliseconds: number) => { assert.equal(milliseconds, 90_000); return ++timers === 1 ? deadline.signal : new AbortController().signal; };
    await mockLocal(async () => { calls++; if (calls === 2) deadline.abort(); return envelope('沒有品牌。'); }, async () => {
      await assert.rejects(translateWatchWindow(input), { code: 'LOCAL_MODEL_TIMEOUT', status: 504 });
      assert.equal(calls, 2);
    });
  } finally { AbortSignal.timeout = originalTimeout; }
});
