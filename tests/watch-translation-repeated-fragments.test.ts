import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatedNameSourceFragments, requestLocalRepeatedNameRepair } from '../lib/watch/local-cue-translator';
import { translateWatchWindow } from '../lib/watch/translator';
import type { Glossary } from '../lib/glossary-defaults';
import type { WatchCue, WatchSource } from '../lib/watch/types';

const glossary: Glossary = { no_translate_terms: ['Flux', 'Higgsfield', 'Nano Banana'], term_map: [], style_rules: [] };
const target: WatchCue = { id: 'repeat-fixture', start: 2036.88, end: 2044.62, text: "let's just try let's try let's do Flux maybe Flux let's do Flux 2." };
const source: WatchSource = { videoId: 'abcdefghijk', title: 'Unrelated fixture', language: 'en', sourceKind: 'manual', trackId: 'repeat-fixture', cues: [target] };
const input = { source, targets: [target], before: [], after: [], glossary };
const envelope = (value: unknown, doneReason = 'stop') => Response.json({ done: true, done_reason: doneReason, message: { content: JSON.stringify(value) } });
async function withMock(fetcher: typeof fetch, run: () => Promise<void>) {
  const oldFetch = globalThis.fetch, oldMode = process.env.WATCH_PROCESSING_MODE, oldModel = process.env.WATCH_LOCAL_MODEL;
  try { process.env.WATCH_PROCESSING_MODE = 'local'; process.env.WATCH_LOCAL_MODEL = 'qwen2.5:7b'; globalThis.fetch = async (url, init) => { assert.equal(url, 'http://127.0.0.1:11434/api/chat'); assert.equal(new Headers(init?.headers).has('authorization'), false); return fetcher(url, init); }; await run(); }
  finally { globalThis.fetch = oldFetch; if (oldMode === undefined) delete process.env.WATCH_PROCESSING_MODE; else process.env.WATCH_PROCESSING_MODE = oldMode; if (oldModel === undefined) delete process.env.WATCH_LOCAL_MODEL; else process.env.WATCH_LOCAL_MODEL = oldModel; }
}

test('source fragments are exact consecutive substrings; attached versions and all trailing text survive', () => {
  const split = repeatedNameSourceFragments(target, glossary)!;
  assert.deepEqual(split, ["let's just try let's try let's do Flux", ' maybe Flux', " let's do Flux 2."]);
  assert.equal(split.join(''), target.text);
  for (const version of ['2', '2.1', '2 Pro', 'Pro 2', '2.1 Max']) {
    const cue = { ...target, text: `Use Flux ${version}, not Flux, perhaps Flux 3. Keep this tail.` };
    const parts = repeatedNameSourceFragments(cue, glossary)!;
    assert.equal(parts[0], `Use Flux ${version}`); assert.equal(parts.join(''), cue.text);
    assert.match(parts.at(-1)!, /3\. Keep this tail\.$/);
  }
  assert.equal(repeatedNameSourceFragments({ ...target, text: 'Use Flux once.' }, glossary), null);
  assert.equal(repeatedNameSourceFragments({ ...target, text: Array(9).fill('Flux').join(', ') }, glossary), null);
});

test('repeated-name deficit receives one structured repair with per-fragment names and numbers, not an extra call', async () => {
  let calls = 0;
  await withMock(async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    if (calls === 1) { assert.deepEqual(body.format.required, ['text']); return envelope({ text: '我們試試 Flux，可能用 Flux 2。' }); }
    assert.deepEqual(body.format.required, ['p0', 'p1', 'p2']);
    const data = JSON.parse(body.messages[1].content);
    assert.equal(data.text, undefined);
    assert.deepEqual(data.ordered_source_fragments.map((part: { verbatim_numbers: string[] }) => part.verbatim_numbers), [[], [], ['2']]);
    assert.deepEqual(data.ordered_source_fragments.map((part: { required_names_in_order: string[] }) => part.required_names_in_order), [['Flux'], ['Flux'], ['Flux']]);
    assert.equal(data.ordered_source_fragments.map((part: { text: string }) => part.text).join(''), target.text);
    return envelope({ p0: '我們試試 Flux，', p1: '也許用 Flux，', p2: '就用 Flux 2。' });
  }, async () => {
    const [result] = await translateWatchWindow(input);
    assert.equal(calls, 2); assert.equal(result.text, '我們試試 Flux， 也許用 Flux， 就用 Flux 2。');
    assert.equal(result.originalText, target.text); assert.equal(result.start, target.start); assert.equal(result.end, target.end);
  });
});

test('moving or duplicating the last version into maybe fragment fails closed, with no third call', async () => {
  let calls = 0;
  await withMock(async () => { calls++; return calls === 1 ? envelope({ text: '試試 Flux，可能用 Flux 2。' }) : envelope({ p0: '試試 Flux，', p1: '也許用 Flux 2，', p2: '就用 Flux 2。' }); }, async () => {
    await assert.rejects(translateWatchWindow(input), { code: 'LOCAL_TRANSLATION_QUALITY' }); assert.equal(calls, 2);
  });
});

test('fragment keys, local names and count/order are checked, not merely aggregate full-cue totals', async () => {
  for (const bad of [
    { p0: '試試 Flux，', p1: '也許用 Flux，' },
    { p0: '試試 Flux，', p1: '也許用 Flux，', p2: '就用 Flux 2。', p3: '新增。' },
    { p0: '試試 Flux、Flux，', p1: '也許用，', p2: '就用 Flux 2。' },
    { p0: '試試 Flux，', p1: 'maybe Flux', p2: '就用 Flux 2。' },
    { p0: '試試 Higgsfield，', p1: '也許用 Flux，', p2: '就用 Flux 2。' },
  ]) {
    await withMock(async () => envelope(bad), async () => {
      await assert.rejects(requestLocalRepeatedNameRepair({ cue: target, glossary, model: 'qwen2.5:7b', signal: new AbortController().signal, fragments: repeatedNameSourceFragments(target, glossary)! }), { code: 'MODEL_FAILED' });
    });
  }
});

test('numeric validation preserves minus, decimal, thousands separator, percentages and 3D digit', async () => {
  const cue = { ...target, text: 'Use -2.5, 1,000 and 3D with Flux, then 99% with Flux 2.' };
  const fragments = repeatedNameSourceFragments(cue, glossary)!;
  await withMock(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.deepEqual(data.ordered_source_fragments.map((part: { verbatim_numbers: string[] }) => part.verbatim_numbers), [['-2.5', '1,000', '3'], ['99%', '2']]);
    return envelope({ p0: '搭配 Flux 使用 -2.5、1,000 與 3D，', p1: '再以 Flux 2 使用 99%。' });
  }, async () => {
    // The second fragment reordered the original numbers: this must not pass.
    await assert.rejects(requestLocalRepeatedNameRepair({ cue, glossary, model: 'qwen2.5:7b', signal: new AbortController().signal, fragments }), { code: 'MODEL_FAILED' });
  });
});

test('structured repair preserves the shared cancel/deadline behavior and refuses length output', async () => {
  const controller = new AbortController(); let calls = 0;
  await withMock(async () => { calls++; controller.abort(); return envelope({ p0: 'Flux', p1: 'Flux', p2: 'Flux 2' }); }, async () => {
    await assert.rejects(requestLocalRepeatedNameRepair({ cue: target, glossary, model: 'qwen2.5:7b', signal: controller.signal, fragments: repeatedNameSourceFragments(target, glossary)! }), { code: 'CANCELLED' }); assert.equal(calls, 1);
  });
  await withMock(async () => envelope({ p0: '試試 Flux', p1: '也許 Flux', p2: '用 Flux 2' }, 'length'), async () => {
    await assert.rejects(requestLocalRepeatedNameRepair({ cue: target, glossary, model: 'qwen2.5:7b', signal: new AbortController().signal, fragments: repeatedNameSourceFragments(target, glossary)! }), { code: 'LOCAL_TRANSLATION_TRUNCATED' });
  });
});

test('a name plus its own version is neutral only within repair and is not forced to invent Chinese', async () => {
  const cue = { ...target, text: 'Flux 2.1.3 Pro, maybe Flux 3.' };
  const fragments = repeatedNameSourceFragments(cue, glossary)!;
  assert.deepEqual(fragments, ['Flux 2.1.3 Pro', ', maybe Flux 3.']);
  assert.deepEqual(repeatedNameSourceFragments({ ...target, text: 'Use Flux Pro, maybe Flux.' }, glossary), ['Use Flux Pro', ', maybe Flux.']);
  await withMock(async () => envelope({ p0: 'Flux 2.1.3 Pro', p1: '也許用 Flux 3。' }), async () => {
    assert.equal(await requestLocalRepeatedNameRepair({ cue, glossary, model: 'qwen2.5:7b', signal: new AbortController().signal, fragments }), 'Flux 2.1.3 Pro 也許用 Flux 3。');
  });
  for (const version of ['2.1 3', '2.1.4']) {
    await withMock(async () => envelope({ p0: `Flux ${version} Pro`, p1: '也許用 Flux 3。' }), async () => {
      await assert.rejects(requestLocalRepeatedNameRepair({ cue, glossary, model: 'qwen2.5:7b', signal: new AbortController().signal, fragments }), { code: 'MODEL_FAILED' });
    });
  }
});

test('a model descriptor cannot be dropped or swapped while its digits remain correct', async () => {
  const cue = { ...target, text: 'Flux 2.1.3 Pro, maybe Flux 3.' };
  for (const label of ['Flux 2.1.3', 'Flux 2.1.3 Max']) {
    await withMock(async () => envelope({ p0: label, p1: '也許用 Flux 3。' }), async () => {
      await assert.rejects(requestLocalRepeatedNameRepair({ cue, glossary, model: 'qwen2.5:7b', signal: new AbortController().signal, fragments: repeatedNameSourceFragments(cue, glossary)! }), { code: 'MODEL_FAILED' });
    });
  }
});

test('source numeric sequence cannot silently drop a Unicode minus or split exponent notation', async () => {
  const cue = { ...target, text: 'Use −2 and 1e3 with Flux, maybe Flux.' };
  const fragments = repeatedNameSourceFragments(cue, glossary)!;
  await withMock(async (_url, init) => {
    const data = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    assert.deepEqual(data.ordered_source_fragments[0].verbatim_numbers, ['-2', '1e3']);
    return envelope({ p0: '搭配 Flux 使用 2 和 1 3，', p1: '也許用 Flux。' });
  }, async () => {
    await assert.rejects(requestLocalRepeatedNameRepair({ cue, glossary, model: 'qwen2.5:7b', signal: new AbortController().signal, fragments }), { code: 'MODEL_FAILED' });
  });
});
