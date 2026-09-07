import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import type { LearningAnalysis, LearningPatchPayload, LearningPoint, LearningResponse } from '../lib/learning/types';

// JSX event handlers and hook refs intentionally retain their emitted VM shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type View = { type: unknown; props: Record<string, any> };
type Effect = { run: () => undefined | (() => void); deps?: unknown[] };
const assessment = { answer: 'uncertain' as const, reason: '來源展示單一案例，仍需以另一個素材核對。' };
const point: LearningPoint = {
  id: 'point-one', core: '先確認遮罩範圍，再改背景', sourceFaithfulness: { supported: true, reason: '轉述保留了引文中的主體與背景條件。' },
  sourceClaims: [{ timestamp: 12.75, quote: 'Keep the subject and replace the background.', explanation: '模型將這句整理為保留主體、替換背景。' }],
  whyImportant: '先分離範圍可縮小出錯原因。', conditions: ['來源有清楚的前景與背景邊界。'],
  application: { decision: 'PRIVATE_DECISION', operation: 'PRIVATE_OPERATION', understanding: 'PRIVATE_UNDERSTANDING', action: 'PRIVATE_TEST_ACTION', observableEvidence: 'PRIVATE_OBSERVABLE' },
  assessment: { credible: { ...assessment }, relevant: { ...assessment }, changes: { ...assessment }, feasible: { ...assessment }, verifiable: { ...assessment } },
  disposition: 'later', reason: 'PRIVATE_ADOPTION_REASON', implementationRecords: [{ id: 'note-one', action: 'PRIVATE_PRACTICE', result: 'PRIVATE_RESULT', observedAt: '2026-09-07T02:00:00.000Z', createdAt: '2026-09-07T02:01:00.000Z' }],
};
const analysis: LearningAnalysis = {
  version: 'learning-fixture', sourceHash: 'source-fixture', model: 'local-fixture', createdAt: '2026-09-07T00:00:00.000Z',
  coverage: { totalChunks: 2, processedChunks: 2, failedChunks: [], totalSourceLines: 4, processedSourceLines: 4, unparsedLines: 0, invalidEvidenceCount: 0, unsupportedInterpretations: 0, candidateCount: 1, analyzedCandidates: 1, limitations: ['不推定一個示範適用於所有素材。'] },
  profileSnapshot: { version: 'profile-fixture', source: 'user-authorized-this-conversation', goals: ['PRIVATE_PROFILE_GOAL'] }, points: [point],
  publicCards: { targetCount: 20, status: 'insufficient-evidence', reason: '目前只有一個可回溯來源觀點，不能湊滿 20 頁。', cards: [{ id: 'public-one', kind: 'source-paraphrase-draft', reviewStatus: 'needs-semantic-review', title: '先確認遮罩範圍', body: '保留主體，再替換背景；繁中譯述待覆核。', sourceHash: 'source-fixture', sourceClaims: [{ timestamp: 12.75, quote: 'Keep the subject and replace the background.' }] }] },
};
const idle: LearningResponse = { status: 'idle', progress: { stage: 'idle', completed: 0, total: 0, message: '' }, analysis: null, error: null };
const running: LearningResponse = { ...idle, status: 'running', progress: { stage: 'extracting', completed: 1, total: 2, message: '正在核對來源。' } };
const complete: LearningResponse = { ...idle, status: 'complete', progress: { stage: 'complete', completed: 2, total: 2, message: '處理完成。' }, analysis };
const code = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'components/LearningAnalysisPanel.tsx'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function elements(node: unknown): View[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const view = node as View;
  return [view, ...elements(view.props?.children)];
}
function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text((node as View).props?.children);
}
function find(tree: View, type: string, label: string) {
  const found = elements(tree).find(item => item.type === type && text(item) === label);
  assert.ok(found, `${type}: ${label}`); return found;
}
async function flush() { for (let n = 0; n < 18; n++) await Promise.resolve(); }
type Request = { url: string; method: string; body: Record<string, unknown> | null; signal: AbortSignal };
function harness(name = 'default', initial: unknown[] = [], respond: (request: Request) => Promise<{ ok: boolean; result: unknown }> = async () => ({ ok: true, result: idle })) {
  const states = [...initial];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const refs: { current: any }[] = [];
  const requests: Request[] = [], timers = new Map<number, () => Promise<void>>();
  let stateIndex = 0, refIndex = 0, effects: Effect[] = [], timerId = 0;
  const exports: Record<string, (props: unknown) => View> = {};
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  vm.runInNewContext(code, { exports, AbortController, AbortSignal, Error, Date, encodeURIComponent,
    setTimeout(run: () => Promise<void>) { const id = ++timerId; timers.set(id, run); return id; }, clearTimeout(id: number) { timers.delete(id); },
    async fetch(url: string, options: { method?: string; body?: string; signal: AbortSignal }) {
      const request = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, signal: options.signal };
      requests.push(request); const response = await respond(request); return { ok: response.ok, json: async () => response.result };
    },
    require(module: string) {
      if (module === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
      if (module === 'react') return {
        useState(value: unknown) { const index = stateIndex++; if (!(index in states)) states[index] = typeof value === 'function' ? value() : value; return [states[index], (next: unknown) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
        useRef(value: unknown) { const index = refIndex++; return refs[index] ||= { current: value }; },
        useEffect(run: Effect['run'], deps: unknown[]) { effects.push({ run, deps }); },
      };
      throw Error('Unexpected runtime dependency ' + module);
    },
  });
  return { states, requests, timers, exports,
    render(props: unknown) { stateIndex = 0; refIndex = 0; effects = []; return exports[name](props); },
    readEffect() { const effect = effects.find(item => item.deps?.length === 2); assert.ok(effect); return effect.run(); },
    async tick() { const item = timers.entries().next().value; assert.ok(item); timers.delete(item[0]); await item[1](); await flush(); },
  };
}

test('opening old data only GETs and explicitly says not analyzed; generation is disabled without consent', async () => {
  const ui = harness(); const props = { id: 'fixture', onSeek() {} };
  ui.render(props); const cleanup = ui.readEffect(); await flush(); const tree = ui.render(props);
  assert.deepEqual(ui.requests.map(request => request.method), ['GET']);
  assert.equal(ui.requests[0].url, '/api/summaries/fixture/learning');
  assert.match(text(tree), /尚未分析[\s\S]*不會自動啟動模型/);
  assert.equal(find(tree, 'button', '開始本機學習分析').props.disabled, true);
  assert.equal(ui.timers.size, 0); cleanup?.();
});

test('manual consent sends one generate POST; polling only GETs until terminal state', async () => {
  let reads = 0;
  const ui = harness('default', [], async request => ({ ok: true, result: request.method === 'POST' ? running : reads++ === 0 ? idle : reads === 2 ? running : complete }));
  const props = { id: 'fixture', onSeek() {} };
  ui.render(props); const firstCleanup = ui.readEffect(); await flush(); let tree = ui.render(props);
  elements(tree).find(item => item.type === 'input' && item.props.type === 'checkbox')!.props.onChange({ target: { checked: true } });
  tree = ui.render(props);
  const start = find(tree, 'button', '開始本機學習分析');
  start.props.onClick(); start.props.onClick(); await flush();
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1);
  assert.deepEqual(ui.requests.find(request => request.method === 'POST')!.body, { action: 'generate', consent: true });
  firstCleanup?.(); ui.render(props); const cleanup = ui.readEffect(); await flush();
  assert.equal(ui.timers.size, 1);
  await ui.tick(); tree = ui.render(props);
  assert.match(text(tree), /本次分析已完成/); assert.equal(ui.timers.size, 0);
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 1); cleanup?.();
});

test('read failure never automatically retries inference and preserves previously saved analysis', async () => {
  const ui = harness('default', [complete], async () => ({ ok: false, result: { error: 'synthetic offline' } }));
  const props = { id: 'fixture', onSeek() {} };
  ui.render(props); const cleanup = ui.readEffect(); await flush(); const tree = ui.render(props);
  assert.match(text(tree), /synthetic offline/);
  assert.ok(find(tree, 'button', '重新查詢狀態（不重跑）'));
  assert.equal(ui.states[0], complete); assert.equal(ui.requests.length, 1); assert.equal(ui.timers.size, 0);
  cleanup?.();
});

test('cancellation is an explicit POST without consent or generation; cancelled state offers manual retry', async () => {
  const ui = harness('default', [running, false], async () => ({ ok: true, result: { ...complete, status: 'cancelled' } }));
  const props = { id: 'fixture', onSeek() {} }; let tree = ui.render(props);
  find(tree, 'button', '取消本次分析').props.onClick(); await flush(); tree = ui.render(props);
  assert.deepEqual(ui.requests[0].body, { action: 'cancel' });
  assert.match(text(tree), /本次分析已取消/);
  assert.equal(find(tree, 'button', '重試／接續本機分析').props.disabled, true);
});

test('unmount aborts polling and prevents a late GET from replacing the last saved state', async () => {
  let resolve!: (value: { ok: boolean; result: unknown }) => void;
  const ui = harness('default', [complete], () => new Promise(done => { resolve = done; }));
  ui.render({ id: 'fixture', onSeek() {} }); const cleanup = ui.readEffect();
  cleanup?.(); assert.equal(ui.requests[0].signal.aborted, true);
  resolve({ ok: true, result: running }); await flush(); assert.equal(ui.states[0], complete);
});

test('private view shows evidence layers, five concrete reasons and fractional timestamp seeks', () => {
  const seeks: number[] = [];
  const ui = harness('LearningPointReview');
  const tree = ui.render({ point, sourceHash: analysis.sourceHash, index: 0, disabled: false, onSeek: (value: number) => seeks.push(value), onSave: async () => {} });
  const words = text(tree);
  assert.match(words, /01 原片觀點與證據/); assert.match(words, /02 模型分析，不是原作者結論/); assert.match(words, /03 給允雷的用途/);
  assert.match(words, /模型整理，待覆核/);
  assert.match(words, /目前分類：保留備用/); assert.doesNotMatch(words, /已保存：/);
  assert.match(words, /初始分類與理由為模型／助理建議；你可修改並儲存自己的判斷。/);
  assert.match(words, /Keep the subject and replace the background\./);
  assert.match(words, /PRIVATE_DECISION/); assert.match(words, /五問檢查：看理由，不打分/);
  assert.equal((words.match(/來源展示單一案例/g) || []).length, 5);
  find(tree, 'button', '0:12 · 回原片核對').props.onClick(); assert.deepEqual(seeks, [12.75]);
});

test('draft disposition is not saved until explicit PATCH action and only mutable private fields are submitted', async () => {
  const patches: LearningPatchPayload[] = [];
  const ui = harness('LearningPointReview');
  const props = { point, sourceHash: analysis.sourceHash, index: 0, disabled: false, onSeek() {}, onSave: async (payload: LearningPatchPayload) => { patches.push(payload); } };
  let tree = ui.render(props);
  elements(tree).find(item => item.type === 'input' && item.props.type === 'radio' && item.props.value === 'now')!.props.onChange();
  elements(tree).find(item => item.type === 'textarea' && item.props.id?.endsWith('-reason'))!.props.onChange({ target: { value: '先用一個有對照素材的小實驗確認。' } });
  tree = ui.render(props); assert.equal(patches.length, 0);
  find(tree, 'button', '儲存分類與理由').props.onClick(); await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ sourceHash: 'source-fixture', pointId: 'point-one', disposition: 'now', reason: '先用一個有對照素材的小實驗確認。' }]);
  assert.equal(point.disposition, 'later');
});

test('implementation notes require actual action/result/time and remain in the private patch only', async () => {
  const patches: LearningPatchPayload[] = [];
  const ui = harness('LearningPointReview');
  const props = { point, sourceHash: analysis.sourceHash, index: 0, disabled: false, onSeek() {}, onSave: async (payload: LearningPatchPayload) => { patches.push(payload); } };
  let tree = ui.render(props);
  find(tree, 'button', '儲存私人實作紀錄').props.onClick(); await flush(); tree = ui.render(props);
  assert.match(text(tree), /請填寫實際採取的動作/); assert.equal(patches.length, 0);
  const textareas = elements(tree).filter(item => item.type === 'textarea');
  textareas[1].props.onChange({ target: { value: ' 測試同一主體的兩種遮罩。 ' } });
  textareas[2].props.onChange({ target: { value: ' 邊緣沒有改善，記錄失敗結果。 ' } });
  elements(tree).find(item => item.type === 'input' && item.props.type === 'datetime-local')!.props.onChange({ target: { value: '2026-09-07T10:30' } });
  tree = ui.render(props); find(tree, 'button', '儲存私人實作紀錄').props.onClick(); await flush();
  assert.equal(patches.length, 1);
  assert.equal(patches[0].implementation?.action, '測試同一主體的兩種遮罩。');
  assert.equal(patches[0].implementation?.result, '邊緣沒有改善，記錄失敗結果。');
  assert.match(patches[0].implementation!.observedAt, /^2026-09-07T.*Z$/);
  assert.deepEqual(Object.keys(patches[0]).sort(), ['implementation', 'pointId', 'sourceHash']);
});

test('use-current-time is explicit, uses local date fields, and never invents completed practice', async () => {
  const patches: LearningPatchPayload[] = [];
  const ui = harness('LearningPointReview');
  const props = { point, sourceHash: analysis.sourceHash, index: 0, disabled: false, onSeek() {}, onSave: async (payload: LearningPatchPayload) => { patches.push(payload); } };
  let tree = ui.render(props);
  assert.equal(elements(tree).find(item => item.type === 'input' && item.props.type === 'datetime-local')!.props.value, '');
  const localParts = { getFullYear: () => 2026, getMonth: () => 8, getDate: () => 7, getHours: () => 9, getMinutes: () => 8,
    toISOString: () => { throw new Error('must not use UTC formatting'); } };
  assert.equal(ui.exports.localDatetimeValue(localParts), '2026-09-07T09:08');
  find(tree, 'button', '使用現在時間').props.onClick(); tree = ui.render(props);
  assert.match(elements(tree).find(item => item.type === 'input' && item.props.type === 'datetime-local')!.props.value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(ui.requests.length, 0); assert.equal(patches.length, 0);
  find(tree, 'button', '儲存私人實作紀錄').props.onClick(); await flush(); tree = ui.render(props);
  assert.match(text(tree), /請填寫實際採取的動作/); assert.equal(patches.length, 0);
  assert.equal(find(ui.render({ ...props, disabled: true }), 'button', '使用現在時間').props.disabled, true);
});

test('public view receives only source projection: profile, application and private notes never enter its rendered tree', () => {
  const ui = harness('default', [complete, false]);
  const props = { id: 'fixture', onSeek() {} }; let tree = ui.render(props);
  assert.match(JSON.stringify(tree), /PRIVATE_PROFILE_GOAL/);
  find(tree, 'button', '公開 Carousel 草稿').props.onClick(); tree = ui.render(props);
  assert.doesNotMatch(JSON.stringify(tree), /PRIVATE_/);
  const preview = elements(tree).find(item => item.type === ui.exports.LearningPublicPreview)!;
  assert.deepEqual(Object.keys(preview.props).sort(), ['onSeek', 'publicCards', 'reviewed']);
  assert.equal(preview.props.reviewed, false);
  const publicUi = harness('LearningPublicPreview');
  const publicTree = publicUi.render(preview.props);
  assert.match(text(publicTree), /來源觀點草稿 · 待語意覆核/);
  assert.match(text(publicTree), /模型整理，待覆核/);
  assert.match(text(publicTree), /證據不足時不湊滿 20 頁/);
  assert.doesNotMatch(text(publicTree), /PRIVATE_/);
  assert.equal(elements(publicTree).some(item => item.type === 'button' && /發布|套用|匯出/.test(text(item))), false);
});

test('ordinary model results never acquire an assistant-review badge or reviewed point labels', () => {
  const ui = harness('default', [complete, false]);
  const tree = ui.render({ id: 'fixture', onSeek() {} });
  assert.doesNotMatch(text(tree), /助理對照原文校訂示範/);
  assert.equal(elements(tree).find(item => item.type === ui.exports.LearningPointReview)!.props.reviewed, false);
  assert.equal(analysis.editorialReview, undefined); assert.equal(ui.requests.length, 0);
});

test('assistant-edited sample is prominently disclosed with counts and private-only review notes', () => {
  const edited: LearningAnalysis = { ...analysis, editorialReview: { kind: 'assistant-source-review', reviewedAt: '2026-09-07T03:00:00.000Z', originalPointCount: 7, retainedPointCount: 3, scope: 'transcript-only', notes: ['PRIVATE_EDITORIAL_NOTE：移除無法由來源支持的泛化建議。'] } };
  const ui = harness('default', [{ ...complete, analysis: edited }, false]); const props = { id: 'fixture', onSeek() {} };
  let tree = ui.render(props);
  assert.match(text(tree), /助理對照原文校訂示範｜未獨立查證／未驗證實作效益/);
  assert.match(text(tree), /原模型草稿 7 個；本次重新選題、校訂示範 3 個/);
  assert.match(text(tree), /助理校訂示範已保存/); assert.doesNotMatch(text(tree), /本次分析已完成/);
  assert.match(text(tree), /原模型處理範圍（非校訂後的全片驗證率）/);
  assert.match(text(tree), /不是本機模型原樣輸出，也不是人類查證結果/);
  assert.match(text(tree), /PRIVATE_EDITORIAL_NOTE/);
  assert.equal(elements(tree).find(item => item.type === 'time')!.props.dateTime, edited.editorialReview!.reviewedAt);
  assert.equal(elements(tree).find(item => item.type === ui.exports.LearningPointReview)!.props.reviewed, true);
  find(tree, 'button', '公開 Carousel 草稿').props.onClick(); tree = ui.render(props);
  assert.doesNotMatch(JSON.stringify(tree), /PRIVATE_/);
  assert.match(text(tree), /助理對照原文校訂示範/);
  const preview = elements(tree).find(item => item.type === ui.exports.LearningPublicPreview)!;
  assert.deepEqual(Object.keys(preview.props).sort(), ['onSeek', 'publicCards', 'reviewed']); assert.equal(preview.props.reviewed, true);
  const publicUi = harness('LearningPublicPreview'); const publicTree = publicUi.render(preview.props);
  assert.match(text(publicTree), /助理校訂，未獨立查證/); assert.doesNotMatch(text(publicTree), /模型整理，待覆核|模型忠實譯述/);
  assert.equal(ui.requests.length, 0);
});

test('reviewed point labels identify assistant edits without claiming human or model verification', () => {
  const ui = harness('LearningPointReview');
  const tree = ui.render({ point, sourceHash: analysis.sourceHash, index: 0, reviewed: true, disabled: false, onSeek() {}, onSave: async () => {} });
  const words = text(tree);
  assert.match(words, /助理校訂，未獨立查證/); assert.match(words, /助理校訂轉述：/); assert.match(words, /來源對照說明：/);
  assert.match(words, /02 助理校訂分析，不是原作者結論/);
  assert.match(words, /不是人類覆核或獨立事實查證/);
  assert.doesNotMatch(words, /模型轉述：|模型來源語意覆核：|02 模型分析|回答與理由由模型提出/);
  assert.match(words, /初始分類與理由為模型／助理建議/);
});

test('failed private saves retain user input and never alter source evidence or public cards', async () => {
  const ui = harness('LearningPointReview');
  const props = { point, sourceHash: analysis.sourceHash, index: 0, disabled: false, onSeek() {}, onSave: async () => { throw Error('source changed; reload required'); } };
  let tree = ui.render(props);
  elements(tree).find(item => item.type === 'textarea' && item.props.id?.endsWith('-reason'))!.props.onChange({ target: { value: '保留我的未存草稿。' } });
  tree = ui.render(props); find(tree, 'button', '儲存分類與理由').props.onClick(); await flush(); tree = ui.render(props);
  assert.match(text(tree), /source changed; reload required/);
  assert.equal(elements(tree).find(item => item.type === 'textarea' && item.props.id?.endsWith('-reason'))!.props.value, '保留我的未存草稿。');
  assert.equal(point.reason, 'PRIVATE_ADOPTION_REASON');
});
