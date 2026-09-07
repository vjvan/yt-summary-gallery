import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { segmentsToSrt } from '../lib/pipeline/generate-srt';
import * as cardStyle from '../lib/card-style';

// Exercise the production TSX effect, not a second copy of its active-state rule.
// React hooks/timers/fetch are isolated; no browser, model, DB or external request.
type Row = Record<string, unknown>;
type NodeView = { type: unknown; props: Record<string, unknown> };
type Effect = { run: () => undefined | (() => void); deps?: unknown[] };
const complete: Row = { id: 'fixture', status: 'done', subtitle_status: 'complete', subtitle_completed: 8, subtitle_total: 8, pipeline_stage: 'done', card_paths: [], summary: { title_display: '已保存摘要', one_liner: '字幕已完成', tags: [] } };
const code = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'app/card/[id]/page.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function harness(initial: Row, read: (signal: AbortSignal) => Promise<Row>) {
  const states: unknown[] = [initial, 0, 'carousel', false];
  const refs: { current: unknown }[] = [];
  let stateIndex = 0, refIndex = 0, effects: Effect[] = [], timerId = 0;
  const timers = new Map<number, { run: () => Promise<void>; delay: number }>();
  const requests: { url: string; signal: AbortSignal }[] = [];
  const blobs: Blob[] = [], revoked: string[] = [];
  const downloads: { href: string; download: string; removed: boolean }[] = [];
  const exported: { default?: () => NodeView } = {};
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  vm.runInNewContext(code, {
    exports: exported, Error, AbortController, AbortSignal, Date, encodeURIComponent, Blob,
    URL: { createObjectURL(blob: Blob) { blobs.push(blob); return `blob:test-${blobs.length}`; }, revokeObjectURL(url: string) { revoked.push(url); } },
    document: {
      body: { appendChild() {} },
      createElement(tag: string) {
        assert.equal(tag, 'a');
        const anchor = { href: '', download: '', removed: false, click() { downloads.push(anchor); }, remove() { anchor.removed = true; } };
        return anchor;
      },
    },
    setTimeout(run: () => Promise<void>, delay: number) { const id = ++timerId; timers.set(id, { run, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    async fetch(url: string, options: { signal: AbortSignal }) {
      assert.equal(url, '/api/summaries/fixture');
      requests.push({ url, signal: options.signal });
      const row = await read(options.signal);
      return { ok: true, json: async () => row };
    },
    require(name: string) {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (name === 'react') return {
        useState(value: unknown) { const index = stateIndex++; if (!(index in states)) states[index] = value; return [states[index], (next: unknown) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
        useRef(value: unknown) { const index = refIndex++; return refs[index] ||= { current: value }; },
        useCallback(value: unknown) { return value; },
        useEffect(run: Effect['run'], deps: unknown[]) { effects.push({ run, deps }); },
      };
      if (name === 'next/navigation') return { useParams: () => ({ id: 'fixture' }) };
      if (name === '@/lib/use-local-storage') return { useLocalStorage: () => [false, () => {}] };
      if (name === '@/lib/media-export-client') return {};
      if (name === '@/lib/card-style') return cardStyle;
      if (name === '@/lib/pipeline/generate-srt') return { segmentsToSrt };
      if (name === 'next/image') return { default: 'image' };
      if (name === 'next/link') return { default: 'link' };
      if (name.startsWith('@/components/')) return { default: name };
      throw new Error('Unmocked dependency: ' + name);
    },
  });
  return {
    requests, timers, blobs, revoked, downloads,
    data: () => states[0] as Row,
    setData: (row: Row) => { states[0] = row; },
    render() {
      stateIndex = 0; refIndex = 0; effects = [];
      const tree = exported.default!();
      const effect = effects.find(entry => entry.deps?.length === 4 && entry.deps[0] === 'fixture');
      assert.ok(effect, 'card progress effect must observe the rendering stage');
      return { tree, effect };
    },
    async tick() {
      const entry = timers.entries().next().value;
      assert.ok(entry, 'an explicit bounded polling timer must exist');
      timers.delete(entry[0]); await entry[1].run();
    },
  };
}
function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text((node as NodeView).props?.children);
}
function imageSources(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(imageSources);
  const item = node as NodeView;
  return [...(item.type === 'image' ? [item.props.src] : []), ...imageSources(item.props?.children)];
}
function elements(node: unknown): NodeView[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const item = node as NodeView;
  return [item, ...elements(item.props?.children)];
}

test('card-only retry keeps polling done + complete rows and applies the final card paths', async () => {
  const rendering = { ...complete, pipeline_stage: 'library_rendering' };
  const final = { ...complete, card_paths: ['/cards/fixture/slide-1.png'] };
  const responses = [rendering, final];
  const ui = harness(rendering, async () => responses.shift()!);
  const initial = ui.render();
  assert.match(text(initial.tree), /摘要已可閱讀.*字幕已完整匯出/);
  assert.match(text(initial.tree), /摘要圖卡產生中.*已完成的字幕會保留/);
  const cleanup = initial.effect.run();
  assert.equal([...ui.timers.values()][0].delay, 1000);
  await ui.tick();
  assert.equal([...ui.timers.values()][0].delay, 4000);
  await ui.tick();
  assert.equal(ui.requests.length, 2); assert.equal(ui.timers.size, 0);
  assert.equal(ui.data(), final);
  const done = ui.render();
  assert.deepEqual(imageSources(done.tree), ['/cards/fixture/slide-1.png']);
  assert.doesNotMatch(text(done.tree), /摘要圖卡產生中/);
  assert.equal(done.effect.run(), undefined);
  cleanup?.();
});

test('opening an in-flight token keeps polling independently of subtitle-owned pipeline_stage', async () => {
  const pending = { ...complete, pipeline_stage: 'summary_ready', card_render_token: 'claimed-render' };
  const settled = { ...complete, pipeline_stage: 'done', card_render_token: null, card_paths: ['/cards/fixture/style-complete/slide-1.png'] };
  const responses = [pending, settled];
  const ui = harness(pending, async () => responses.shift()!);
  const initial = ui.render();
  assert.match(text(initial.tree), /摘要圖卡產生中/);
  const cleanup = initial.effect.run();
  await ui.tick();
  assert.equal(ui.timers.size, 1, 'a stage overwrite must not stop token polling');
  await ui.tick();
  assert.equal(ui.timers.size, 0);
  assert.deepEqual(imageSources(ui.render().tree), ['/cards/fixture/style-complete/slide-1.png']);
  cleanup?.();
});

test('rendering stage alone changes the effect dependency and is visible without new subtitle metadata', () => {
  const ui = harness({ ...complete, subtitle_status: null }, async () => complete);
  const before = ui.render(); assert.equal(before.effect.run(), undefined);
  ui.setData({ ...complete, subtitle_status: null, pipeline_stage: 'library_rendering' });
  const after = ui.render();
  assert.notDeepEqual(after.effect.deps, before.effect.deps);
  assert.match(text(after.tree), /摘要圖卡產生中/);
  const cleanup = after.effect.run(); assert.equal(ui.timers.size, 1); cleanup?.(); assert.equal(ui.timers.size, 0);
});

test('render error leaves readable summary/subtitles, applies error and stops polling', async () => {
  const final = { ...complete, pipeline_stage: 'summary_ready', error: '圖卡產生失敗' };
  const ui = harness({ ...complete, pipeline_stage: 'library_rendering' }, async () => final);
  const cleanup = ui.render().effect.run(); await ui.tick();
  assert.equal(ui.timers.size, 0); assert.equal(ui.requests.length, 1);
  assert.equal(ui.data().error, final.error); assert.equal(ui.data().summary, complete.summary);
  const done = ui.render(); assert.match(text(done.tree), /已有摘要、原文及字幕仍保留/);
  assert.doesNotMatch(text(done.tree), /摘要圖卡產生中/); cleanup?.();
});

test('unmount cancels the rendering poll and late results cannot overwrite data', async () => {
  let resolve!: (row: Row) => void;
  const initial = { ...complete, pipeline_stage: 'library_rendering' };
  const ui = harness(initial, () => new Promise(done => { resolve = done; }));
  const cleanup = ui.render().effect.run(); const pending = ui.tick();
  assert.equal(ui.requests.length, 1); assert.equal(ui.timers.size, 0);
  cleanup?.(); assert.equal(ui.requests[0].signal.aborted, true);
  resolve({ ...complete, card_paths: ['/late.png'] }); await pending;
  assert.equal(ui.data(), initial); assert.equal(ui.timers.size, 0);
});

test('existing source/subtitle processing still polls; settled partial/error does not auto-retry', () => {
  for (const row of [{ ...complete, status: 'processing' }, { ...complete, subtitle_status: 'processing' }]) {
    const ui = harness(row, async () => complete);
    const cleanup = ui.render().effect.run(); assert.equal(ui.timers.size, 1); cleanup?.();
  }
  for (const subtitle_status of ['complete', 'partial', 'error']) {
    const ui = harness({ ...complete, subtitle_status }, async () => complete);
    assert.equal(ui.render().effect.run(), undefined); assert.equal(ui.timers.size, 0); assert.equal(ui.requests.length, 0);
  }
});

test('YouTube without downloaded video exposes real complete Chinese/bilingual paths and exports actual original text', async () => {
  const segments = [{ start: 59.9996, end: 62, text: ' OpenArt and Figma Weave. ' }, { start: 62, end: 65, text: 'Keep the full second sentence.' }];
  const ui = harness({ ...complete, source: 'youtube', video_url: null, video_id: '../unsafe?name', card_paths: ['/cards/fixture/slide-1.png'], is_translated: true, srt_en_path: null, srt_zh_path: '/burned/fixture.zh.srt', srt_bi_path: '/burned/fixture.bi.srt', segments, segments_zh: segments.map(cue => ({ ...cue, text: '這不是原文。' })) }, async () => complete);
  const nodes = elements(ui.render().tree);
  assert.equal(nodes.find(node => node.type === 'a' && text(node) === '中譯 SRT')?.props.href, '/burned/fixture.zh.srt');
  assert.equal(nodes.find(node => node.type === 'a' && text(node) === '雙語 SRT')?.props.href, '/burned/fixture.bi.srt');
  assert.equal(nodes.some(node => node.type === 'a' && node.props.href === '/api/summaries/fixture/srt'), false, 'do not mislabel the Chinese-preferring API');
  const button = nodes.find(node => node.type === 'button' && text(node) === '原文 SRT');
  assert.ok(button); (button.props.onClick as () => void)();
  assert.equal(ui.requests.length, 0); assert.equal(ui.blobs.length, 1); assert.equal(ui.downloads.length, 1);
  assert.equal(await ui.blobs[0].text(), segmentsToSrt(segments));
  assert.doesNotMatch(await ui.blobs[0].text(), /這不是原文/);
  assert.match(ui.downloads[0].download, /^[A-Za-z0-9_-]+\.original\.srt$/);
  assert.equal(ui.downloads[0].removed, true); assert.deepEqual(ui.revoked, []);
  assert.equal([...ui.timers.values()][0].delay, 30_000, 'do not revoke before the browser consumes the download');
  await ui.tick(); assert.deepEqual(ui.revoked, ['blob:test-1']);
});

test('partial YouTube exposes only original, even if stale Chinese/bilingual paths are present', () => {
  for (const subtitle_status of ['partial', 'processing', 'error']) {
    const ui = harness({ ...complete, subtitle_status, source: 'youtube', video_url: null, is_translated: true, srt_en_path: null, srt_zh_path: '/burned/stale.zh.srt', srt_bi_path: '/burned/stale.bi.srt', segments: [{ start: 0, end: 2, text: 'Original.' }] }, async () => complete);
    const tree = ui.render().tree, nodes = elements(tree);
    assert.ok(nodes.some(node => node.type === 'button' && text(node) === '原文 SRT'));
    assert.equal(nodes.some(node => node.type === 'a' && ['中譯 SRT', '雙語 SRT'].includes(text(node))), false);
    assert.match(text(tree), /目前只提供原文/);
  }
});

test('original SRT uses an actual recorded path when present, never invents one for an empty source', () => {
  const ui = harness({ ...complete, source: 'youtube', video_url: null, srt_en_path: '/burned/existing.en.srt', segments: [] }, async () => complete);
  const nodes = elements(ui.render().tree);
  assert.equal(nodes.find(node => node.type === 'a' && text(node) === '原文 SRT')?.props.href, '/burned/existing.en.srt');
  assert.equal(nodes.some(node => node.type === 'button' && text(node) === '原文 SRT'), false);
  ui.setData({ ...complete, source: 'youtube', video_url: null, srt_en_path: null, segments: [] });
  assert.equal(elements(ui.render().tree).some(node => ['a', 'button'].includes(String(node.type)) && text(node) === '原文 SRT'), false);
});

test('invalid original cue fails visibly rather than downloading malformed subtitles', () => {
  const ui = harness({ ...complete, source: 'youtube', video_url: null, srt_en_path: null, segments: [{ start: 1, end: 0, text: 'Invalid time.' }] }, async () => complete);
  const button = elements(ui.render().tree).find(node => node.type === 'button' && text(node) === '原文 SRT');
  assert.ok(button); (button.props.onClick as () => void)();
  assert.equal(ui.blobs.length, 0); assert.equal(ui.downloads.length, 0); assert.equal(ui.requests.length, 0);
  assert.match(text(ui.render().tree), /原文字幕時間或文字無效，無法匯出/);
});
