import test from 'node:test';
import assert from 'node:assert/strict';
import { processingMode, watchProviderInfo, watchProviderStatus } from '../lib/watch/provider';
import { translateWatchWindow } from '../lib/watch/translator';
import { watchLimits } from '../lib/watch/service';
import { pairingToken } from '../lib/watch/security';
import { GET as statusRoute } from '../app/api/watch/status/route';
import type { WatchCue, WatchSource } from '../lib/watch/types';

const targets: WatchCue[] = [
  { id: 'a', start: 4, end: 7, text: 'This is the background layer.' },
  { id: 'b', start: 7, end: 9, text: 'Connect it to the Compositor node.' },
];
const source: WatchSource = { videoId: 'kfbWz9_bJoA', title: 'Compositor', language: 'en', sourceKind: 'manual', trackId: 'local-fixture', cues: targets };
const input = { source, targets, before: [], after: [], glossary: { no_translate_terms: ['Compositor'], term_map: [['layer', '圖層']] as [string, string][], style_rules: ['使用台灣用語。'] } };
const envelope = (content = JSON.stringify({ cues: [{ id: 'a', text: '这是背景图层。' }, { id: 'b', text: '將它連接到 Compositor 節點。' }] }), extra = {}) => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { role: 'assistant', content }, ...extra }));
async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await run(); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
const localEnv = { WATCH_PROCESSING_MODE: undefined, WATCH_LOCAL_MODEL: undefined, WATCH_LOCAL_WHISPER_MODEL: undefined, OPENAI_API_KEY: 'unit-test-placeholder-not-a-real-key' };

test('watch defaults to local despite a cloud key; cloud is explicit and bounded', async () => {
  await withEnv(localEnv, async () => {
    assert.equal(processingMode(), 'local');
    assert.deepEqual(watchProviderInfo(), { processingMode: 'local', unlimited: true, translationModel: 'qwen2.5:7b', translationConfigured: true, audioConfigured: false });
    assert.deepEqual(watchLimits(), { sessionCalls: null, dailyCalls: null });
    process.env.WATCH_PROCESSING_MODE = 'typo'; assert.equal(processingMode(), 'local');
    process.env.WATCH_PROCESSING_MODE = 'cloud'; assert.equal(processingMode(), 'cloud');
    assert.equal(watchProviderInfo().translationModel, 'gpt-4o-mini');
    assert.equal(watchProviderInfo().unlimited, false); assert.equal(typeof watchLimits().dailyCalls, 'number');
  });
});

test('local model config rejects URLs, cloud aliases and oversized names', async () => {
  await withEnv(localEnv, () => {
    for (const name of ['http://evil.example/model', 'qwen3:cloud', 'gpt-oss:20b-cloud', 'x'.repeat(200), 'model\nheader']) {
      process.env.WATCH_LOCAL_MODEL = name;
      assert.throws(() => watchProviderInfo(), { code: 'LOCAL_MODEL_INVALID' });
    }
  });
});

test('local inference stays on fixed loopback with structured JSON, no credentials and Taiwan script normalization', async () => {
  await withEnv(localEnv, async () => {
    const saved = globalThis.fetch; let calls = 0;
    globalThis.fetch = async (url, init) => {
      calls++; assert.equal(url, 'http://127.0.0.1:11434/api/chat');
      assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('authorization'), null);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'qwen2.5:7b'); assert.equal(body.stream, false);
      assert.deepEqual(body.format.required, ['text']); assert.equal(body.options.temperature, 0);
      assert.equal(body.messages[0].role, 'system'); assert.match(body.messages[0].content, /台灣繁體中文/);
      assert.match(body.messages[0].content, /subtitle fragment/);
      const cue = JSON.parse(body.messages[1].content);
      return envelope(JSON.stringify({ text: cue.text === targets[0].text ? '这是背景图层。' : '將它連接到 Compositor 節點。' }));
    };
    try {
      const output = await translateWatchWindow(input);
      assert.equal(calls, 2); assert.equal(output[0].text, '這是背景圖層。');
      assert.equal(output[1].text, '將它連接到 Compositor 節點。');
      assert.equal(output[0].start, 4); assert.equal(output[0].end, 7); assert.equal(output[0].originalText, targets[0].text);
    } finally { globalThis.fetch = saved; }
  });
});

test('local failure, absent model and incomplete response never retry against cloud', async () => {
  await withEnv(localEnv, async () => {
    const saved = globalThis.fetch; let calls = 0;
    try {
      for (const mock of [
        async () => { throw new Error('private-provider-detail'); },
        async () => new Response('private-provider-detail', { status: 404 }),
        async () => envelope(undefined, { done_reason: 'length' }),
        async () => envelope(JSON.stringify({ cues: [{ id: 'a', text: targets[0].text }, { id: 'b', text: targets[1].text }] })),
        async () => envelope(JSON.stringify({ cues: [{ id: 'a', text: '只有一段。' }] })),
        async () => new Response('x'.repeat(256 * 1024 + 1)),
      ]) {
        const prior = calls;
        globalThis.fetch = async (url) => { calls++; assert.equal(url, 'http://127.0.0.1:11434/api/chat'); return mock(); };
        await assert.rejects(translateWatchWindow(input), (error: unknown) => {
          assert(error instanceof Error); assert.doesNotMatch(error.message, /private-provider-detail/); return true;
        });
        assert.equal(calls, prior + 1);
      }
    } finally { globalThis.fetch = saved; }
  });
});

test('cancelled and provider-switched requests cannot start another local or cloud inference', async () => {
  await withEnv(localEnv, async () => {
    const saved = globalThis.fetch; let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      await new Promise<void>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return envelope();
    };
    try {
      const before = new AbortController(); before.abort();
      await assert.rejects(translateWatchWindow({ ...input, signal: before.signal }), { code: 'CANCELLED' });
      assert.equal(calls, 0);
      await assert.rejects(translateWatchWindow({ ...input, provider: { processingMode: 'cloud', translationModel: 'gpt-4o-mini' } }), { code: 'SESSION_PROVIDER_CHANGED' });
      assert.equal(calls, 0);
      const during = new AbortController(); const pending = translateWatchWindow({ ...input, signal: during.signal });
      during.abort(); await assert.rejects(pending, { code: 'CANCELLED' }); assert.equal(calls, 1);
    } finally { globalThis.fetch = saved; }
  });
});

test('authenticated status uses only a fixed local availability probe without inference or credentials', async () => {
  await withEnv(localEnv, async () => {
    const saved = globalThis.fetch; let calls = 0;
    globalThis.fetch = async (url, init) => { calls++; assert.equal(url, 'http://127.0.0.1:11434/api/tags'); assert.equal(init?.redirect, 'error'); return Response.json({ models: [{ name: 'qwen2.5:7b' }] }); };
    try {
      const request = new Request('http://127.0.0.1:3000/api/watch/status', { headers: { origin: 'http://127.0.0.1:3000', authorization: `Bearer ${pairingToken()}` } });
      const response = await statusRoute(request); assert.equal(response.status, 200);
      const status = await response.json(); assert.equal(status.version, 3); assert.equal(status.processingMode, 'local');
      assert.equal(status.unlimited, true); assert.equal(status.translationConfigured, true); assert.equal(status.audioConfigured, false);
      assert.equal(status.translationReady, true); assert.match(status.translationStatusMessage, /首次推論/);
      assert(!JSON.stringify(status).includes('unit-test-placeholder')); assert.equal(calls, 1);
    } finally { globalThis.fetch = saved; }
  });
});

test('runtime readiness requires the exact local model and unavailable probes never call a cloud endpoint', async () => {
  await withEnv(localEnv, async () => {
    const saved = globalThis.fetch; let calls = 0;
    try {
      for (const mock of [
        async () => { throw new Error('internal-only'); },
        async () => Response.json({ models: [{ name: 'qwen2.5:14b' }] }),
        async () => Response.json({ models: [{ name: 'qwen2.5:7b-extra' }] }),
        async () => Response.json({ error: 'internal-only' }),
        async () => new Response('invalid'),
        async () => new Response('x'.repeat(256 * 1024 + 1)),
      ]) {
        const previous = calls;
        globalThis.fetch = async (url) => { calls++; assert.equal(url, 'http://127.0.0.1:11434/api/tags'); return mock(); };
        const status = await watchProviderStatus();
        assert.equal(status.translationConfigured, true); assert.equal(status.translationReady, false);
        assert.equal(status.processingMode, 'local'); assert.equal(calls, previous + 1);
        assert.doesNotMatch(status.translationStatusMessage || '', /internal-only/);
      }
      const aborted = new AbortController(); aborted.abort(); const previous = calls;
      await assert.rejects(watchProviderStatus(aborted.signal), { code: 'CANCELLED' }); assert.equal(calls, previous);
    } finally { globalThis.fetch = saved; }
  });
});
