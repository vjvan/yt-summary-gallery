/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Node CommonJS tests for classic MV3 scripts. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const folder = path.join(__dirname, '..');
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(initial = {}) {
  const nodes = []; const messages = []; const intervals = []; const classes = new Set();
  const blobs = new Map(), downloads = [], windowEvents = {};
  class TestURL extends URL { static createObjectURL(blob) { const url = `blob:mock-${blobs.size}`; blobs.set(url, blob); return url; } static revokeObjectURL(url) { blobs.delete(url); } }
  class TestBlob { constructor(parts) { this.text = parts.join(''); } }
  let listener; let deferred = false; const deferredWindows = []; let now = Date.now();
  const config = { enabled: true, mode: 'bilingual', maxBatches: 10, ...initial };
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.events = {}; this.children = []; this.textContent = ''; this.parentElement = null; this.classList = { contains: value => classes.has(value) }; nodes.push(this); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    setAttribute() {}
    addEventListener(name, cb) { this.events[name] = cb; }
    removeEventListener(name) { delete this.events[name]; }
    attachShadow() { this.root = new Element('shadow'); return this.root; }
    querySelector() { return video; }
    emit(name) { this.events[name]?.({ type: name }); }
    click() { if (this.tag === 'a') downloads.push({ name: this.download, text: blobs.get(this.href)?.text }); else this.emit('click'); }
  }
  const player = new Element('player');
  const video = new Element('video'); Object.assign(video, { paused: true, ended: false, seeking: false, currentTime: 0 });
  const cues = initial.cues || Array.from({ length: initial.cueCount || 24 }, (_, index) => ({ id: `c${index}`, start: index * 2, end: index * 2 + 1.5, text: `Source ${index}` }));
  const location = { href: 'https://www.youtube.com/watch?v=kfbWz9_bJoA' };
  const document = { visibilityState: 'visible', getElementById() { return player; }, createElement(tag) { return new Element(tag); }, addEventListener() {} };
  const chrome = { runtime: { id: 'test-id', onMessage: { addListener(fn) { listener = fn; } }, async sendMessage(message) {
    messages.push(message);
    if (message.type === 'WATCH_CONFIG') return { ok: true, data: { ...config } };
    if (message.type === 'WATCH_SESSION') return { ok: true, data: { sessionId: 'session-1234', cues, cachedCues: initial.cachedCues, translationEnabled: true, translationModel: initial.translationModel || 'test-model:7b', processingMode: initial.local ? 'local' : 'cloud', unlimited: !!initial.local, limits: { sessionCalls: initial.local ? null : initial.serverLimit || 10 } } };
    if (message.type === 'WATCH_WINDOW') {
      const index = cues.findIndex(cue => cue.end > message.time); const key = String(Math.floor(index / 8));
      const data = { sessionId: message.sessionId, windowKey: key, cues: cues.slice(Number(key) * 8, (Number(key) + 1) * 8).map(cue => ({ ...cue, text: initial.translatedText?.(cue) ?? `翻譯 ${cue.id}`, originalText: cue.text })), callsUsed: initial.countCalls ? messages.filter(item => item.type === 'WATCH_WINDOW').length : 1, dailyCallsUsed: 1, cached: false };
      const reply = initial.windowReply?.({ message, key, data, attempt: messages.filter(item => item.type === 'WATCH_WINDOW').length }) || { ok: true, data };
      if (deferred) return new Promise(resolve => deferredWindows.push(() => resolve(reply)));
      return reply;
    }
    return { ok: true, data: {} };
  } } };
  const context = vm.createContext({ chrome, document, location, window: { addEventListener(name, handler) { windowEvents[name] = handler; } }, console, URL: TestURL, Blob: TestBlob, setTimeout(callback) { callback(); return 1; }, Date: class extends Date { static now() { return now; } }, setInterval(fn) { intervals.push(fn); return intervals.length; } });
  vm.runInContext(fs.readFileSync(path.join(folder, 'core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(folder, 'content.js'), 'utf8'), context);
  return { nodes, messages, video, player, classes, config, location, document, downloads,
    hidePage() { windowEvents.pagehide?.(); },
    advance(milliseconds) { now += milliseconds; },
    status() { return nodes.filter(node => node.className === 'status').at(-1)?.textContent || ''; },
    progress() { return nodes.filter(node => node.className === 'progress').at(-1)?.textContent || ''; },
    retryFailed() { return nodes.filter(node => node.className === 'retry-failed').at(-1); },
    download() { return nodes.filter(node => node.className === 'download').at(-1); },
    model() { return nodes.filter(node => node.className === 'model').at(-1)?.textContent || ''; },
    recovery() { return nodes.filter(node => node.className === 'recovery').at(-1); },
    retry() { return nodes.filter(node => node.className === 'retry').at(-1); },
    async tick() { intervals[0](); await settle(); },
    async updateConfig(patch) { Object.assign(config, patch); await new Promise(resolve => listener({ type: 'WATCH_STATE_CHANGED' }, { id: 'test-id' }, resolve)); },
    deferWindows() { deferred = true; }, async resolveWindows() { deferred = false; for (const resolve of deferredWindows.splice(0)) resolve(); await settle(); },
    translatedText() { return nodes.filter(node => node.className === 'line zh').at(-1)?.textContent || ''; },
    originalText() { return nodes.filter(node => node.className === 'line original').at(-1)?.textContent || ''; },
    pageStatus() { return nodes.filter(node => node.className === 'page-status').at(-1)?.textContent || ''; },
    overlay() { return player.children.find(node => node.root); },
  };
}

test('paused/disabled content never creates sessions or translation requests', async () => {
  const h = harness(); await settle(); for (let i = 0; i < 5; i++) await h.tick();
  assert.equal(h.messages.filter(message => message.type !== 'WATCH_CONFIG').length, 0);
  await h.updateConfig({ enabled: false }); h.video.paused = false; await h.tick();
  assert.equal(h.messages.filter(message => message.type === 'WATCH_SESSION').length, 0);
});
test('current batch plus near-next prefetch are deduplicated; cue end never leaks captions', async () => {
  const h = harness(); await settle(); h.video.paused = false;
  await h.tick(); await h.tick(); await h.tick();
  assert.equal(h.messages.filter(message => message.type === 'WATCH_SESSION').length, 1);
  assert.equal(h.messages.filter(message => message.type === 'WATCH_WINDOW').length, 2);
  assert.equal(h.translatedText(), '翻譯 c0');
  for (let i = 0; i < 20; i++) await h.tick();
  assert.equal(h.messages.filter(message => message.type === 'WATCH_WINDOW').length, 2);
  h.video.currentTime = 1.5; await h.tick(); assert.equal(h.translatedText(), '');
});
test('ad markers suppress both overlay and network; original mode never invokes translation', async () => {
  const h = harness({ mode: 'original' }); await settle(); h.video.paused = false;
  await h.tick(); await h.tick(); assert.equal(h.messages.filter(message => message.type === 'WATCH_WINDOW').length, 0);
  await h.updateConfig({ mode: 'bilingual' }); h.classes.add('ad-showing');
  const before = h.messages.length; await h.tick();
  assert.equal(h.overlay().hidden, true); assert.equal(h.messages.length, before);
});
test('disable clears captions and ignores delayed translation results', async () => {
  const h = harness(); await settle(); h.video.paused = false; await h.tick();
  h.deferWindows(); await h.tick();
  await h.updateConfig({ enabled: false }); await h.resolveWindows();
  assert.equal(h.translatedText(), ''); assert.equal(h.overlay().hidden, true);
  assert.ok(h.messages.some(message => message.type === 'WATCH_STOP'));
});
test('seeking cancels in-flight old-window requests instead of displaying stale captions', async () => {
  const h = harness(); await settle(); h.video.paused = false; await h.tick();
  h.deferWindows(); await h.tick();
  h.video.seeking = true; h.video.currentTime = 36; h.video.emit('seeking');
  assert.ok(h.messages.some(message => message.type === 'WATCH_CANCEL_WINDOW'));
  await h.resolveWindows(); assert.equal(h.translatedText(), '');
});


test('local content keeps requesting new 8-cue batches after 11/51 without per-tick duplicates', async () => {
  for (const maxBatches of [10, 50]) {
    const h = harness({ local: true, countCalls: true, cueCount: 8 * 55, maxBatches });
    await settle(); h.video.paused = false; await h.tick();
    for (let batch = 0; batch < 52; batch++) { h.video.currentTime = batch * 16; await h.tick(); await h.tick(); }
    const requests = h.messages.filter(message => message.type === 'WATCH_WINDOW');
    assert.ok(requests.length >= 52); assert.equal(new Set(requests.map(message => Math.floor((Math.floor(message.time / 2) + (message.time % 2 > 1.5 ? 1 : 0)) / 8))).size, requests.length);
    const before = requests.length;
    for (let i = 0; i < 100; i++) await h.tick();
    assert.equal(h.messages.filter(message => message.type === 'WATCH_WINDOW').length, before);
    h.video.currentTime = 0; h.video.emit('seeking'); await h.tick();
    assert.equal(h.messages.filter(message => message.type === 'WATCH_WINDOW').length, before);
  }
});
test('cloud content still halts at its 10/50 batch cap', async () => {
  for (const maxBatches of [10, 50]) {
    const h = harness({ countCalls: true, cueCount: 8 * 55, maxBatches, serverLimit: 100 });
    await settle(); h.video.paused = false; await h.tick();
    for (let batch = 0; batch < 53; batch++) { h.video.currentTime = batch * 16; await h.tick(); await h.tick(); }
    assert.equal(h.messages.filter(message => message.type === 'WATCH_WINDOW').length, maxBatches);
  }
});

test('long overlay captions page by source clock without data loss or extra translation requests', async () => {
  const core = require('../core.js');
  const original = 'This is the complete original explanation about OpenArt, Runway, Pixel Dance and Jimeng. Keep every detail, number and negative statement in the original order. '.repeat(2);
  const fullTranslation = '這是完整的影片比較說明，保留 OpenArt、Runway、Pixel Dance 與 Jimeng 平台名稱。所有數量、否定與細節都要依原文順序翻譯，不能只保留摘要。'.repeat(3);
  const source = Object.freeze({ id: 'long-482', start: 482, end: 506, text: original });
  const h = harness({ local: true, cues: Object.freeze([source]), translatedText: () => fullTranslation });
  await settle(); h.video.currentTime = 482; h.video.paused = false; await h.tick(); await h.tick();
  const pages = core.splitCaptionPages(fullTranslation), originals = core.splitCaptionPages(original);
  assert.ok(pages.length > 1); assert.equal(pages.map(page => page.text).join(''), fullTranslation);
  assert.equal(originals.map(page => page.text).join(''), original);
  let before = 0; const sum = pages.reduce((total, page) => total + page.weight, 0); const seen = [];
  for (const [index, page] of pages.entries()) {
    h.video.currentTime = source.start + (source.end - source.start) * (before + page.weight / 2) / sum;
    await h.tick(); assert.equal(h.translatedText(), page.text); seen.push(h.translatedText());
    assert.match(h.pageStatus(), new RegExp(`繁中 ${index + 1}/${pages.length}`));
    const expectedOriginal = core.selectCaptionPage(originals, { start: source.start, end: source.end, time: h.video.currentTime });
    assert.equal(h.originalText(), expectedOriginal.page.text); before += page.weight;
  }
  assert.equal(seen.join(''), fullTranslation); assert.equal(source.text, original);
  h.video.paused = true; h.video.emit('pause'); const paused = h.translatedText();
  for (let index = 0; index < 5; index++) await h.tick();
  assert.equal(h.translatedText(), paused);
  h.video.seeking = true; h.video.currentTime = 482; h.video.emit('seeking'); assert.equal(h.translatedText(), '');
  h.video.seeking = false; h.video.emit('seeked'); await h.tick(); assert.equal(h.translatedText(), pages[0].text);
  await h.updateConfig({ mode: 'original' }); assert.equal(h.translatedText(), ''); assert.equal(h.originalText(), originals[0].text);
  await h.updateConfig({ mode: 'translated' }); assert.equal(h.originalText(), ''); assert.equal(h.translatedText(), pages[0].text);
  assert.equal(h.messages.filter(message => message.type === 'WATCH_WINDOW').length, 1);
  h.video.currentTime = source.end; await h.tick(); assert.equal(h.translatedText(), ''); assert.equal(h.pageStatus(), '');
  await h.updateConfig({ enabled: false }); assert.equal(h.translatedText(), '');
});

test('narrow-player one-line page budgets recompute across the 360px resize boundary', async () => {
  const core = require('../core.js');
  const text = '甲'.repeat(100);
  const narrow = core.splitCaptionPages(text, { lineUnits: 17, pageUnits: 17, maxLines: 2 })[0].text;
  const wide = core.splitCaptionPages(text, { lineUnits: 17, pageUnits: 32, maxLines: 2 })[0].text;
  assert.ok(wide.length > narrow.length);
  const h = harness({ local: true, cues: [{ id: 'narrow', start: 0, end: 24, text: 'Full original text.' }], translatedText: () => text });
  h.player.clientWidth = 359; await settle(); h.video.paused = false; await h.tick(); await h.tick();
  assert.equal(h.translatedText(), narrow);
  h.player.clientWidth = 360; await h.tick(); assert.equal(h.translatedText(), wide);
  h.player.clientWidth = 359; await h.tick(); assert.equal(h.translatedText(), narrow);
  assert.equal(h.messages.filter(message => message.type === 'WATCH_WINDOW').length, 1);
});


const qualityFailure = () => ({ ok: false, code: 'LOCAL_TRANSLATION_QUALITY', status: 502, error: '00:16–00:31 本機譯文未保留指定專有名詞；這一批未寫入成功快取。' });
const windowCalls = h => h.messages.filter(message => message.type === 'WATCH_WINDOW');
async function playAndCreate(h) { await settle(); h.video.paused = false; await h.tick(); }

test('actual content scheduler isolates local quality rejection, keeps prior success, and resumes other windows without restarting', async () => {
  const h = harness({ local: true, translationModel: 'qwen2.5:7b', windowReply: ({ key }) => key === '1' ? qualityFailure() : null });
  await playAndCreate(h); await h.tick(); await h.tick();
  assert.equal(windowCalls(h).length, 2); // current success + next-window rejected prefetch
  assert.equal(h.translatedText(), '翻譯 c0');
  assert.equal(h.model(), '全本機模型：qwen2.5:7b');
  for (let i = 0; i < 100; i++) { h.advance(10000); await h.tick(); }
  assert.equal(windowCalls(h).length, 2); // no quality-error automatic repair loop
  h.video.currentTime = 16; await h.tick();
  assert.equal(h.translatedText(), ''); assert.equal(h.originalText(), 'Source 8');
  assert.equal(h.retry().hidden, false); assert.match(h.recovery().textContent, /本區段有未翻譯句子/);
  h.video.currentTime = 32; await h.tick(); await h.tick();
  assert.equal(h.translatedText(), '翻譯 c16'); assert.equal(windowCalls(h).length, 3);
  assert.equal(h.messages.filter(message => message.type === 'WATCH_SESSION').length, 1);
  assert.equal(h.messages.filter(message => message.type === 'WATCH_STOP').length, 0);
  h.video.currentTime = 0; await h.tick(); assert.equal(h.translatedText(), '翻譯 c0');
  h.video.currentTime = 16; await h.tick(); assert.equal(h.retry().hidden, false);
  assert.equal(windowCalls(h).length, 3); // failed is not ready and not silently retried
});

test('manual retry while paused queues exactly one request on play, retains failure until success, and never promotes English', async () => {
  let reject = true;
  const h = harness({ local: true, mode: 'translated', cueCount: 8, windowReply: () => reject ? qualityFailure() : null });
  await playAndCreate(h); await h.tick();
  assert.equal(h.translatedText(), ''); assert.equal(h.originalText(), 'Source 0');
  h.video.paused = true; h.video.emit('pause'); h.retry().emit('click'); h.retry().emit('click');
  for (let i = 0; i < 10; i++) await h.tick();
  assert.equal(windowCalls(h).length, 1); assert.equal(h.retry().disabled, true);
  assert.match(h.retry().textContent, /重試已排定/); assert.match(h.recovery().textContent, /未保留指定專有名詞/);
  h.video.paused = false; h.video.emit('play'); await settle();
  assert.equal(windowCalls(h).length, 2); assert.equal(h.retry().disabled, false); // still failed; a second click is required
  for (let i = 0; i < 10; i++) { h.advance(60000); await h.tick(); }
  assert.equal(windowCalls(h).length, 2); assert.equal(h.translatedText(), '');
  reject = false; h.retry().emit('click'); await settle();
  assert.equal(windowCalls(h).length, 3); assert.equal(h.translatedText(), '翻譯 c0');
  assert.equal(h.originalText(), ''); assert.equal(h.recovery().hidden, true); assert.equal(h.retry().hidden, true);
  for (let i = 0; i < 10; i++) await h.tick(); assert.equal(windowCalls(h).length, 3);
});

test('seek drops an unsent manual retry; returning to that failed window still requires a new click', async () => {
  const h = harness({ local: true, windowReply: ({ key }) => key === '0' ? qualityFailure() : null });
  await playAndCreate(h); await h.tick();
  h.video.paused = true; h.retry().emit('click');
  h.video.currentTime = 32; h.video.seeking = true; h.video.emit('seeking');
  h.video.seeking = false; h.video.emit('seeked');
  h.video.currentTime = 0; h.video.emit('seeked'); h.video.paused = false; await h.tick();
  assert.equal(windowCalls(h).length, 1); assert.equal(h.retry().disabled, false);
  assert.equal(h.retry().textContent, '重試目前區段');
});

test('cancelled retry result cannot mark old window successful or overwrite a new position', async () => {
  let reject = true;
  const h = harness({ local: true, windowReply: ({ key }) => key === '0' && reject ? qualityFailure() : null });
  await playAndCreate(h); await h.tick();
  reject = false; h.deferWindows(); h.retry().emit('click'); await settle();
  h.video.currentTime = 32; h.video.seeking = true; h.video.emit('seeking');
  assert.ok(h.messages.some(message => message.type === 'WATCH_CANCEL_WINDOW'));
  await h.resolveWindows(); h.advance(1000); h.video.seeking = false; await h.tick(); await h.tick();
  assert.equal(h.translatedText(), '翻譯 c16');
  h.video.currentTime = 0; await h.tick();
  assert.equal(h.translatedText(), ''); assert.equal(h.retry().hidden, false);
});

test('disabled state clears the pending recovery and ignores late rejected results', async () => {
  const h = harness({ local: true, windowReply: qualityFailure });
  await playAndCreate(h); h.deferWindows(); await h.tick();
  await h.updateConfig({ enabled: false }); await h.resolveWindows();
  assert.equal(h.overlay().hidden, true); assert.equal(h.recovery().hidden, true); assert.equal(h.retry().hidden, true);
  assert.equal(h.translatedText(), ''); assert.equal(h.originalText(), '');
});

test('special recovery cannot bypass cloud, auth, quota, timeout, or generic-model safety policies', async () => {
  for (const scenario of [
    { local: false, code: 'LOCAL_TRANSLATION_QUALITY', status: 502, attempts: 3 },
    { local: true, code: 'MODEL_FAILED', status: 502, attempts: 3 },
    { local: true, code: 'ABORTED', status: 408, attempts: 3 },
    { local: true, code: 'UNAUTHORIZED', status: 401, attempts: 1 },
    { local: true, code: 'LOCAL_TRANSLATION_QUALITY', status: 401, attempts: 1 },
    { local: false, code: 'EXTENSION_LIMIT', status: 429, attempts: 1 },
  ]) {
    const h = harness({ local: scenario.local, windowReply: () => ({ ok: false, code: scenario.code, status: scenario.status, error: '預期安全錯誤' }) });
    await playAndCreate(h);
    for (let i = 0; i < 10; i++) { h.advance(60000); await h.tick(); }
    assert.equal(windowCalls(h).length, scenario.attempts, scenario.code);
    assert.match(h.status(), /請在擴充功能重新啟用/);
    assert.equal(h.retry().hidden, true); assert.equal(h.recovery().hidden, true);
    h.video.currentTime = 32; h.advance(60000); await h.tick();
    assert.equal(windowCalls(h).length, scenario.attempts); // fatal remains a session-wide halt
  }
});

test('a manual retry alone authorizes bounded transient retries, pauses them, and clears permission on success', async () => {
  const h = harness({ local: true, cueCount: 8, windowReply: ({ attempt }) => attempt === 1 ? qualityFailure()
    : attempt === 2 ? { ok: false, code: 'NETWORK_ERROR', status: 503, error: '暫時連線中斷' }
      : attempt === 3 ? { ok: false, code: 'ABORTED', status: 408, error: '本次請求逾時' } : null });
  await playAndCreate(h); await h.tick();
  h.retry().emit('click'); await settle();
  assert.equal(windowCalls(h).length, 2); assert.equal(h.retry().disabled, true); assert.match(h.status(), /稍後重試（1\/3）/);
  for (let i = 0; i < 5; i++) await h.tick(); assert.equal(windowCalls(h).length, 2);
  h.video.paused = true; h.advance(60000); await h.tick(); assert.equal(windowCalls(h).length, 2);
  h.video.paused = false; await h.tick(); assert.equal(windowCalls(h).length, 3); assert.match(h.status(), /稍後重試（2\/3）/);
  h.advance(60000); await h.tick(); assert.equal(windowCalls(h).length, 4);
  assert.equal(h.translatedText(), '翻譯 c0'); assert.equal(h.retry().hidden, true); assert.equal(h.recovery().hidden, true);
  for (let i = 0; i < 20; i++) { h.advance(60000); await h.tick(); }
  assert.equal(windowCalls(h).length, 4);
});

test('manual recovery stops after three transient failures or immediate fatal, without claiming other windows continue', async () => {
  for (const scenario of [
    { code: 'NETWORK_ERROR', status: 503, total: 4 },
    { code: 'SESSION_PROVIDER_CHANGED', status: 409, total: 4 }, // unchanged bounded policy; backend rejects before model dispatch
    { code: 'UNAUTHORIZED', status: 401, total: 2 },
    { code: 'SESSION_LIMIT', status: 429, total: 2 },
  ]) {
    const h = harness({ local: true, windowReply: ({ attempt }) => attempt === 1 ? qualityFailure() : { ok: false, ...scenario, error: '預期安全停止' } });
    await playAndCreate(h); await h.tick(); h.retry().emit('click'); await settle();
    for (let i = 0; i < 10; i++) { h.advance(60000); await h.tick(); }
    assert.equal(windowCalls(h).length, scenario.total, scenario.code); assert.equal(h.retry().hidden, true);
    assert.match(h.recovery().textContent, /翻譯已停止/); assert.doesNotMatch(h.recovery().textContent, /其他區段仍可繼續/);
    h.video.currentTime = 32; await h.tick(); assert.equal(windowCalls(h).length, scenario.total);
    assert.equal(h.translatedText(), '');
  }
});

test('a new quality refusal revokes manual transient-retry permission instead of looping', async () => {
  let recover = false;
  const h = harness({ local: true, cueCount: 8, windowReply: ({ attempt }) => recover ? null
    : attempt === 2 ? { ok: false, code: 'NETWORK_ERROR', status: 503, error: '暫時連線中斷' } : qualityFailure() });
  await playAndCreate(h); await h.tick(); h.retry().emit('click'); await settle();
  h.advance(60000); await h.tick(); assert.equal(windowCalls(h).length, 3);
  assert.equal(h.retry().disabled, false); assert.match(h.retry().textContent, /重試目前區段/);
  for (let i = 0; i < 30; i++) { h.advance(60000); await h.tick(); } assert.equal(windowCalls(h).length, 3);
  recover = true; h.retry().emit('click'); await settle(); assert.equal(windowCalls(h).length, 4); assert.equal(h.translatedText(), '翻譯 c0');
});

test('seek, natural window advance, and stop revoke an authorized delayed retry without making failed text ready', async () => {
  for (const action of ['seek-same-window', 'next-window', 'stop']) {
    const h = harness({ local: true, windowReply: ({ key, attempt }) => key !== '0' ? null : attempt === 1 ? qualityFailure()
      : { ok: false, code: 'NETWORK_ERROR', status: 503, error: '暫時連線中斷' } });
    await playAndCreate(h); await h.tick(); h.retry().emit('click'); await settle();
    assert.equal(windowCalls(h).length, 2);
    if (action === 'stop') {
      await h.updateConfig({ enabled: false }); h.advance(60000); await h.tick();
      assert.equal(h.overlay().hidden, true); assert.equal(h.recovery().hidden, true);
    } else {
      if (action === 'seek-same-window') { h.video.seeking = true; h.video.currentTime = 2; h.video.emit('seeking'); h.video.seeking = false; h.video.emit('seeked'); }
      else { h.video.currentTime = 32; await h.tick(); h.video.currentTime = 0; }
      h.advance(60000); await h.tick(); assert.equal(h.retry().disabled, false); assert.equal(h.translatedText(), '');
    }
    assert.equal(windowCalls(h).length, 2, action);
  }
});

test('consented local full prefetch starts paused, sweeps to final short batch, and does no per-tick requests after completion', async () => {
  const h = harness({ local: true, localFullPrefetch: true, cueCount: 19 });
  await settle(); // session creation is automatic even though player was never played
  assert.equal(h.video.paused, true); assert.equal(h.messages.filter(m => m.type === 'WATCH_SESSION').length, 1);
  for (let i = 0; i < 6; i++) await h.tick();
  assert.deepEqual(windowCalls(h).map(r => r.time), [0, 16, 32]);
  assert.match(h.progress(), /全片預譯完成 · 已就緒 19\/19 句 · 失敗 0 句/);
  assert.equal(h.download().hidden, false);
  for (let i = 0; i < 100; i++) await h.tick(); assert.equal(windowCalls(h).length, 3);
});

test('full prefetch keeps an in-flight window across seek and prioritizes the newest playhead at the next boundary', async () => {
  const h = harness({ local: true, localFullPrefetch: true, cueCount: 32 }); await settle();
  h.deferWindows(); await h.tick(); assert.equal(windowCalls(h).length, 1);
  h.video.currentTime = 48; h.video.seeking = true; h.video.emit('seeking');
  for (let i = 0; i < 10; i++) await h.tick();
  assert.equal(windowCalls(h).length, 1); assert.equal(h.messages.some(m => m.type === 'WATCH_CANCEL_WINDOW'), false);
  await h.resolveWindows(); h.video.seeking = false; await h.tick();
  assert.deepEqual(windowCalls(h).map(r => r.time), [0, 48]); assert.equal(h.translatedText(), '翻譯 c24');
  await h.tick(); await h.tick(); assert.deepEqual(windowCalls(h).map(r => r.time), [0, 48, 16, 32]);
  assert.match(h.progress(), /已就緒 32\/32/);
});

test('session cache is counted by exact cue IDs, skips ready windows, and all-cache completes without model-window requests', async () => {
  const source = Array.from({ length: 19 }, (_, i) => ({ id: `c${i}`, start: i * 2, end: i * 2 + 1.5, text: `Source ${i}` }));
  const cached = source.map(cue => ({ ...cue, text: `快取 ${cue.id}`, originalText: cue.text }));
  for (const count of [10, 19]) {
    const h = harness({ local: true, localFullPrefetch: true, cues: source, cachedCues: cached.slice(0, count) }); await settle();
    assert.match(h.progress(), new RegExp(`已就緒 ${count}/19`));
    for (let i = 0; i < 5; i++) await h.tick();
    assert.deepEqual(windowCalls(h).map(r => r.time), count === 19 ? [] : [16, 32]);
    assert.match(h.progress(), /全片預譯完成 · 已就緒 19\/19/);
    if (count === 19) assert.match(h.status(), /完整字幕快取已載入/);
  }
});

test('partial result keeps seven good captions, falls back only failed cue, continues full sweep, and retries missing cache once', async () => {
  let repaired = false;
  const h = harness({ local: true, localFullPrefetch: true, mode: 'translated', cueCount: 17,
    windowReply: ({ key, data }) => {
      if (key !== '0' || repaired) return null;
      const failed = data.cues[3];
      return { ok: true, data: { ...data, complete: false, cached: false, cues: data.cues.filter(cue => cue.id !== failed.id), failedCues: [{ id: failed.id, start: failed.start, end: failed.end, code: 'LOCAL_TRANSLATION_QUALITY', message: '這一句未保留指定名稱。' }] } };
    } }); await settle(); await h.tick();
  assert.match(h.progress(), /已就緒 7\/17 句 · 失敗 1 句（1 批）/);
  assert.equal(h.translatedText(), '翻譯 c0'); assert.equal(h.originalText(), '');
  h.video.currentTime = 6; await h.tick(); assert.equal(h.translatedText(), ''); assert.equal(h.originalText(), 'Source 3');
  await h.tick(); await h.tick();
  assert.match(h.progress(), /預譯仍有失敗句 · 已就緒 16\/17/); assert.equal(h.download().hidden, true);
  assert.equal(windowCalls(h).length, 3);
  for (let i = 0; i < 20; i++) await h.tick(); assert.equal(windowCalls(h).length, 3);
  h.video.currentTime = 32; await h.tick(); assert.equal(h.translatedText(), '翻譯 c16');
  repaired = true; h.retryFailed().emit('click'); await settle();
  assert.equal(h.video.paused, true); assert.equal(windowCalls(h).length, 4);
  assert.equal(windowCalls(h).at(-1).time, 0); assert.match(h.progress(), /全片預譯完成 · 已就緒 17\/17/);
  assert.equal(h.download().hidden, false); assert.equal(h.retryFailed().hidden, true);
  h.video.currentTime = 6; await h.tick(); assert.equal(h.translatedText(), '翻譯 c3'); assert.equal(h.originalText(), '');
});

test('opaque quality errors also isolate unfinished cues and complete the rest without automatic retry', async () => {
  const h = harness({ local: true, localFullPrefetch: true, cueCount: 17, windowReply: ({ key }) => key === '0' ? qualityFailure() : null });
  await settle(); for (let i = 0; i < 10; i++) await h.tick();
  assert.equal(windowCalls(h).length, 3); assert.match(h.progress(), /已就緒 9\/17 句 · 失敗 8 句（1 批）/);
  assert.doesNotMatch(h.progress(), /全片預譯完成/); assert.equal(h.download().hidden, true);
});

test('original mode and revoke/stop cancel full prefetch and ignore late success; hidden local full can continue while cloud cannot', async () => {
  for (const action of ['original', 'disable']) {
    const h = harness({ local: true, localFullPrefetch: true }); await settle(); h.deferWindows(); await h.tick();
    await h.updateConfig(action === 'original' ? { mode: 'original' } : { enabled: false });
    assert.ok(h.messages.some(m => m.type === (action === 'original' ? 'WATCH_CANCEL_WINDOW' : 'WATCH_STOP')));
    await h.resolveWindows(); h.advance(1000);
    for (let i = 0; i < 10; i++) await h.tick();
    assert.equal(windowCalls(h).length, 1); assert.equal(h.translatedText(), '');
    if (action === 'original') assert.match(h.progress(), /已就緒 0\/24/);
  }
  const local = harness({ local: true, localFullPrefetch: true }); await settle(); local.document.visibilityState = 'hidden'; await local.tick();
  assert.equal(windowCalls(local).length, 1);
  const cloud = harness({ local: false, localFullPrefetch: true }); await settle();
  for (let i = 0; i < 5; i++) await cloud.tick(); assert.equal(windowCalls(cloud).length, 0);
  cloud.video.paused = false; cloud.document.visibilityState = 'hidden'; await cloud.tick(); assert.equal(windowCalls(cloud).length, 0);
});

test('forged partial timing, duplicate IDs, missing coverage and foreign cached source fail closed without progress', async () => {
  const variants = [
    ({ data }) => ({ ...data, cues: data.cues.slice(1), failedCues: [], complete: false }),
    ({ data }) => ({ ...data, cues: data.cues.map(c => ({ ...c, originalText: 'wrong source' })) }),
    ({ data }) => ({ ...data, cues: data.cues.slice(1), failedCues: [{ id: 'c0', start: 999, end: 1000, code: 'LOCAL_TRANSLATION_QUALITY', message: 'bad' }], complete: false }),
    ({ data }) => ({ ...data, cues: [data.cues[0], ...data.cues.slice(0, 7)] }),
  ];
  for (const variant of variants) {
    const h = harness({ local: true, localFullPrefetch: true, windowReply: args => ({ ok: true, data: variant(args) }) });
    await settle(); await h.tick(); assert.match(h.progress(), /已就緒 0\/24/); assert.equal(h.translatedText(), ''); assert.equal(h.download().hidden, true);
  }
  const h = harness({ local: true, localFullPrefetch: true, cachedCues: [{ id: 'c0', start: 0, end: 1.5, text: '錯快取', originalText: '別部影片' }] });
  await settle(); assert.equal(h.translatedText(), ''); assert.match(h.status(), /快取與這支影片/); assert.equal(h.progress(), ''); assert.equal(windowCalls(h).length, 0);
});

test('1279-cue cached session larger than 1MB remains complete without any WATCH_WINDOW request', async () => {
  const cues = Array.from({ length: 1279 }, (_, i) => ({ id: `large-${i}`, start: i * 2, end: i * 2 + 1.5, text: `Original ${i} ` + 'full source details '.repeat(24) }));
  const cache = cues.map(cue => ({ ...cue, text: '完整譯文與所有細節。'.repeat(30), originalText: cue.text }));
  assert.ok(Buffer.byteLength(JSON.stringify({ cues, cachedCues: cache })) > 1024 * 1024);
  const h = harness({ local: true, localFullPrefetch: true, cues, cachedCues: cache }); await settle();
  for (let i = 0; i < 5; i++) await h.tick();
  assert.match(h.progress(), /全片預譯完成 · 已就緒 1279\/1279 句 · 失敗 0 句/);
  assert.equal(windowCalls(h).length, 0); assert.equal(h.download().hidden, false);
});


test('full SRT download requires a user click after completion and includes every source/translation with exact times', async () => {
  const h = harness({ local: true, localFullPrefetch: true, cueCount: 9 }); await settle();
  h.download().emit('click'); assert.equal(h.downloads.length, 0);
  for (let i = 0; i < 4; i++) await h.tick(); assert.equal(h.downloads.length, 0);
  h.download().emit('click'); assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].name, 'yt-summary-kfbWz9_bJoA-zh-TW-bilingual.srt');
  for (let i = 0; i < 9; i++) { assert.ok(h.downloads[0].text.includes(`翻譯 c${i}`)); assert.ok(h.downloads[0].text.includes(`Source ${i}`)); }
  assert.match(h.downloads[0].text, /9\n00:00:16,000 --> 00:00:17,500/);
});

test('page unload cancels pending local full prefetch and cannot accept its delayed success', async () => {
  const h = harness({ local: true, localFullPrefetch: true }); await settle(); h.deferWindows(); await h.tick();
  h.hidePage(); await h.resolveWindows();
  for (let i = 0; i < 5; i++) await h.tick();
  assert.equal(windowCalls(h).length, 1); assert.ok(h.messages.some(message => message.type === 'WATCH_STOP'));
  assert.equal(h.translatedText(), ''); assert.equal(h.originalText(), ''); assert.equal(h.download().hidden, true);
});
