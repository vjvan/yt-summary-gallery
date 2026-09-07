import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as cardStyle from '../lib/card-style';
import { applyCardStylePreview, ensureCardStylePreviewFonts } from '../components/card-style-preview';

// VM React props are intentionally dynamic, matching emitted JSX.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type View = { type: unknown; props: Record<string, any> };
type Effect = { run: () => unknown; deps?: unknown[] };
const { DEFAULT_CARD_STYLE, resolveCardStyle, buildStyleCss } = cardStyle;
const alternate = resolveCardStyle(null, { palette: 'forest-cream', fontPreset: 'round-display', background: 'ink-dark' });
function elements(node: unknown): View[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const view = node as View;
  return [view, ...elements(view.props?.children)];
}
function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'number' || typeof node === 'string') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text((node as View).props?.children);
}
function fakeDocument() {
  const variables = new Map<string, string>();
  const classes = new Set(['card', 'social-card', 'social-card--hook', ...buildStyleCss(DEFAULT_CARD_STYLE).backgroundClass.split(' ')]);
  const card = { classList: { remove: (...values: string[]) => values.forEach(value => classes.delete(value)), add: (...values: string[]) => values.forEach(value => classes.add(value)) } };
  const styles: unknown[] = [];
  const document = { documentElement: { style: { setProperty: (key: string, value: string) => variables.set(key, value) } },
    fonts: { load: async () => [{ status: "loaded" }] },
    querySelectorAll: () => [card], createElement: () => ({ textContent: '' }), head: { append: (style: unknown) => styles.push(style) } } as unknown as Document;
  return { document, variables, classes, styles };
}
function componentHarness(file: string, initialStates: unknown[], extras: Record<string, unknown> = {}) {
  // Refs span dialog, iframe, DOM container, draft and callbacks in the VM.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const states = [...initialStates], refs: { current: any }[] = [];
  let stateIndex = 0, refIndex = 0, effects: Effect[] = [];
  const code = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports: { default?: (props?: unknown) => View } = {};
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  vm.runInNewContext(code, { exports, AbortController, AbortSignal, Error, Date, URLSearchParams, encodeURIComponent,
    fetch() { throw Error('Choice changes must not fetch'); },
    require(name: string) {
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (name === 'react') return {
        useState(initial: unknown) { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], (next: unknown) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
        useRef(value: unknown) { const index = refIndex++; return refs[index] ||= { current: value }; },
        useCallback(value: unknown) { return value; },
        useEffect(run: Effect['run'], deps: unknown[]) { effects.push({ run, deps }); },
      };
      if (name === '@/lib/card-style') return cardStyle;
      if (name === './card-style-preview') return { applyCardStylePreview, ensureCardStylePreviewFonts };
      if (name === 'next/navigation') return { useParams: () => ({ id: 'fixture' }) };
      if (name === 'next/image') return { default: 'image' };
      if (name === 'next/link') return { default: 'link' };
      if (name.startsWith('@/components/')) return { default: name };
      if (name.startsWith('@/lib/')) return {};
      throw Error('Unmocked dependency ' + name);
    }, ...extras });
  return { refs, states,
    render(props?: unknown) { stateIndex = 0; refIndex = 0; effects = []; return exports.default!(props); },
    applyDraftEffect() { const effect = effects.find(item => item.deps?.length === 2); assert.ok(effect); effect.run(); },
  };
}

test('preview shares exact renderer variables and removes every stale background class without touching card roles', () => {
  const fixture = fakeDocument();
  assert.equal(applyCardStylePreview(fixture.document, alternate), true);
  assert.deepEqual(Object.fromEntries(fixture.variables), buildStyleCss(alternate).variables);
  assert.equal(fixture.classes.has('paper-grain'), false);
  assert.equal(fixture.classes.has('bg-notebook-warm'), false);
  assert.equal(fixture.classes.has('bg-ink-dark'), true);
  assert.equal(fixture.classes.has('social-card--hook'), true);
  assert.equal(fixture.classes.has('card'), true);
  applyCardStylePreview(fixture.document, DEFAULT_CARD_STYLE);
  assert.equal(fixture.classes.has('bg-ink-dark'), false);
  assert.equal(fixture.classes.has('paper-grain'), true);
});

test('preview font checks reject missing/failed local faces instead of accepting fallback text', async () => {
  const fixture = fakeDocument();
  await ensureCardStylePreviewFonts(fixture.document, alternate);
  const missing = { fonts: { load: async () => [] } } as unknown as Document;
  await assert.rejects(() => ensureCardStylePreviewFonts(missing, alternate), /無法載入.*JiaoTangBuDing.*本機字型/);
  const failed = { fonts: { load: async () => { throw Error('local face unavailable'); } } } as unknown as Document;
  await assert.rejects(() => ensureCardStylePreviewFonts(failed, DEFAULT_CARD_STYLE), /尚未套用/);
});

test('a missing preview font is announced and prevents the apply button', async () => {
  const props = { id: 'fixture', activeStyle: { ...DEFAULT_CARD_STYLE }, onCancel() {}, onApply: async () => {} };
  const ui = componentHarness('components/CardStylePanel.tsx', []);
  const fixture = fakeDocument();
  Object.defineProperty(fixture.document, 'fonts', { value: { load: async () => [] } });
  let tree = ui.render(props);
  ui.refs[1].current = { contentDocument: fixture.document };
  elements(tree).find(item => item.type === 'iframe')!.props.onLoad();
  tree = ui.render(props); ui.applyDraftEffect(); await flush(); tree = ui.render(props);
  assert.match(text(tree), /此電腦無法載入.*本機字型/);
  assert.equal(elements(tree).find(item => item.type === 'button' && text(item) === '套用並重畫 20 頁')!.props.disabled, true);
});

test('all three axes only change draft and the existing iframe; cancel never applies or mutates saved style', () => {
  const activeStyle = Object.freeze({ ...DEFAULT_CARD_STYLE });
  let cancelled = 0, applied = 0;
  const props = { id: 'fixture', activeStyle, onCancel: () => { cancelled++; }, onApply: async () => { applied++; } };
  const ui = componentHarness('components/CardStylePanel.tsx', []);
  const fixture = fakeDocument();
  let tree = ui.render(props);
  ui.refs[1].current = { contentDocument: fixture.document };
  const frame = elements(tree).find(item => item.type === 'iframe')!;
  assert.equal(frame.props.src, '/api/summaries/fixture/editor?preview=1');
  assert.equal(frame.props.sandbox, 'allow-same-origin');
  frame.props.onLoad();
  tree = ui.render(props); ui.applyDraftEffect();
  for (const [name, value] of [['card-palette', alternate.palette], ['card-font', alternate.fontPreset], ['card-background', alternate.background]]) {
    const option = elements(tree).find(item => item.type === 'input' && item.props.name === name && item.props.value === value)!;
    assert.ok(option, `${name} is a labelled native radio`);
    option.props.onChange(); tree = ui.render(props); ui.applyDraftEffect();
    assert.equal(elements(tree).find(item => item.type === 'iframe')!.props.src, frame.props.src);
  }
  assert.deepEqual(Object.fromEntries(fixture.variables), buildStyleCss(alternate).variables);
  assert.deepEqual(activeStyle, DEFAULT_CARD_STYLE);
  assert.match(text(tree), /尚未套用/);
  elements(tree).find(item => item.type === 'button' && text(item) === '取消')!.props.onClick();
  assert.equal(cancelled, 1); assert.equal(applied, 0);
  assert.equal(fixture.styles.length, 1, 'preview document was initialized once');
});

test('apply is the only commit action; failure keeps draft, saved style and the open panel', async () => {
  let calls = 0, cancelled = 0;
  const props = { id: 'fixture', activeStyle: { ...DEFAULT_CARD_STYLE }, onCancel: () => { cancelled++; },
    onApply: async (style: cardStyle.CardStyle) => { calls++; assert.equal(style.fontPreset, 'handwritten-note'); throw Error('synthetic redraw failed'); } };
  const ui = componentHarness('components/CardStylePanel.tsx', []);
  let tree = ui.render(props);
  ui.refs[1].current = { contentDocument: fakeDocument().document };
  elements(tree).find(item => item.type === 'iframe')!.props.onLoad();
  tree = ui.render(props);
  elements(tree).find(item => item.type === 'input' && item.props.value === 'handwritten-note')!.props.onChange();
  tree = ui.render(props);
  assert.equal(calls, 0);
  await elements(tree).find(item => item.type === 'button' && text(item) === '套用並重畫 20 頁')!.props.onClick();
  tree = ui.render(props);
  assert.equal(calls, 1); assert.equal(cancelled, 0);
  assert.match(text(tree), /synthetic redraw failed/);
  assert.equal(elements(tree).find(item => item.type === 'input' && item.props.value === 'handwritten-note')!.props.checked, true);
  assert.deepEqual(props.activeStyle, DEFAULT_CARD_STYLE);
});

const initialRow = { id: 'fixture', status: 'done', pipeline_stage: 'library_complete', card_style: JSON.stringify(DEFAULT_CARD_STYLE),
  card_paths: ['/cards/fixture/slide-1.png'], slide_count: 1, summary: { title_display: '閱讀測試', tags: [] } };
async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
function pageHarness(result: Record<string, unknown> | Record<string, unknown>[], initial = initialRow) {
  const requests: { url: string; method: string }[] = [];
  const timers = new Map<number, () => void>(); let timerId = 0;
  const queued = Array.isArray(result) ? [...result] : null;
  const ui = componentHarness('app/card/[id]/page.tsx', [{ ...initial }, 0, 'carousel', false], {
    setTimeout(fn: () => void) { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout(id: number) { timers.delete(id); },
    async fetch(url: string, options: { method: string }) {
      requests.push({ url, method: options.method });
      return { ok: true, json: async () => options.method === 'POST' ? { status: 'regenerating', render_token: 'render-ui-fixture' } : queued ? queued.shift() : result };
    },
  });
  let tree = ui.render();
  elements(tree).find(item => item.type === 'button' && text(item) === '樣式')!.props.onClick();
  tree = ui.render();
  const panel = elements(tree).find(item => item.type === '@/components/CardStylePanel')!;
  return { ...ui, requests, panel, async tick() { await flush(); const timer = timers.entries().next().value; assert.ok(timer); timers.delete(timer[0]); timer[1](); await flush(); } };
}

test('saved chips remain active until a full successful redraw, which cache-busts images and closes the panel', async () => {
  const complete = { ...initialRow, card_style: JSON.stringify(alternate), card_paths: Array.from({ length: 20 }, (_, index) => `/cards/fixture/style-render-ui-fixture/slide-${index + 1}.png`), slide_count: 20 };
  const ui = pageHarness(complete);
  const pending = ui.panel.props.onApply(alternate);
  let tree = ui.render();
  assert.match(text(elements(tree).find(item => item.props['data-style-axis'] === 'font')), /編輯宋體/);
  await ui.tick(); await pending;
  assert.equal(ui.requests.filter(item => item.method === 'POST').length, 1);
  assert.equal(ui.requests[0].url, '/api/summaries/fixture/regenerate-cards?palette=forest-cream&font=round-display&bg=ink-dark');
  tree = ui.render();
  assert.match(text(elements(tree).find(item => item.props['data-style-axis'] === 'font')), /焦糖布丁/);
  assert.match(elements(tree).find(item => item.type === 'image')!.props.src, /slide-1\.png\?v=\d+/);
  assert.equal(elements(tree).some(item => item.type === '@/components/CardStylePanel'), false);
  assert.ok(elements(tree).find(item => item.props.href === '/api/summaries/fixture/editor'), 'quick editor has no stale theme override');
});

test('redraw failure retains old chips and image URLs, never reporting success or hiding the draft panel', async () => {
  const ui = pageHarness({ ...initialRow, pipeline_stage: 'library_render_error' });
  const pending = ui.panel.props.onApply(alternate);
  const rejected = assert.rejects(pending, /原有圖卡與樣式仍保留/);
  await ui.tick(); await rejected;
  const tree = ui.render();
  assert.match(text(elements(tree).find(item => item.props['data-style-axis'] === 'font')), /編輯宋體/);
  assert.equal(elements(tree).find(item => item.type === 'image')!.props.src, '/cards/fixture/slide-1.png');
  assert.equal(elements(tree).some(item => item.type === '@/components/CardStylePanel'), true);
  assert.doesNotMatch(text(tree), /重畫完成/);
});

test('claimed renders keep polling even when subtitle work overwrites the shared stage', async () => {
  const old = { ...initialRow, card_paths: Array.from({ length: 20 }, (_, index) => `/cards/fixture/old/slide-${index + 1}.png`), slide_count: 20 };
  const inProgress = { ...old, card_render_token: 'in-flight-render', pipeline_stage: 'library_complete' };
  const finished = { ...old, card_render_token: null, pipeline_stage: 'summary_ready',
    card_style: JSON.stringify(alternate), card_paths: Array.from({ length: 20 }, (_, index) => `/cards/fixture/style-render-ui-fixture/slide-${index + 1}.png`) };
  const ui = pageHarness([inProgress, finished], old);
  let settled = false;
  const pending = ui.panel.props.onApply(alternate).then(() => { settled = true; });
  await ui.tick();
  assert.equal(settled, false);
  let tree = ui.render();
  assert.equal(elements(tree).some(item => item.type === '@/components/CardStylePanel'), true);
  assert.doesNotMatch(text(tree), /重畫完成/);
  await ui.tick(); await pending;
  tree = ui.render();
  assert.equal(settled, true);
  assert.match(text(tree), /完整 20 張圖卡重畫完成/);
  assert.equal(elements(tree).some(item => item.type === '@/components/CardStylePanel'), false);
});

test('same-style requests cannot succeed from old 20-card paths, even with no token and a complete stage', async () => {
  const old = { ...initialRow, card_paths: Array.from({ length: 20 }, (_, index) => `/cards/fixture/old/slide-${index + 1}.png`), slide_count: 20 };
  const finished = { ...old, card_render_token: null, pipeline_stage: 'done',
    card_paths: Array.from({ length: 20 }, (_, index) => `/cards/fixture/style-render-ui-fixture/slide-${index + 1}.png`) };
  const ui = pageHarness([{ ...old, card_render_token: null }, finished], old);
  let settled = false;
  const pending = ui.panel.props.onApply(DEFAULT_CARD_STYLE).then(() => { settled = true; });
  await ui.tick(); assert.equal(settled, false);
  await ui.tick(); await pending; assert.equal(settled, true);
});

test('render error remains detectable after subtitle work changes pipeline_stage', async () => {
  const ui = pageHarness({ ...initialRow, pipeline_stage: 'done', card_render_token: null, error: 'library_render_error: synthetic failure' });
  const rejected = assert.rejects(ui.panel.props.onApply(alternate), /原有圖卡與樣式仍保留/);
  await ui.tick(); await rejected;
  assert.equal(elements(ui.render()).some(item => item.type === '@/components/CardStylePanel'), true);
});

test('a different completed job cannot satisfy the acknowledged render token', async () => {
  const other = { ...initialRow, card_render_token: null, pipeline_stage: 'library_complete', card_style: JSON.stringify(alternate),
    card_paths: Array.from({ length: 20 }, (_, index) => `/cards/fixture/style-other-job/slide-${index + 1}.png`) };
  const requested = { ...other, card_paths: Array.from({ length: 20 }, (_, index) => `/cards/fixture/style-render-ui-fixture/slide-${index + 1}.png`) };
  const ui = pageHarness([other, requested]);
  let settled = false;
  const pending = ui.panel.props.onApply(alternate).then(() => { settled = true; });
  await ui.tick(); assert.equal(settled, false);
  await ui.tick(); await pending; assert.equal(settled, true);
});
