import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser } from 'playwright';
import { renderCard, resolveSocialCards, buildCardHtml, DEFAULT_CARD_STYLE } from '../lib/pipeline/render-card';
import type { Summary } from '../lib/pipeline/extract-summary';
import type { VideoMetadata } from '../lib/pipeline/fetch-transcript';

const summary = { video_genre: 'news', title_display: '合成測試', one_liner: '只有 mock 截圖。', tldr_paragraph: '', key_points: [], key_quote: '', action_items: [], highlights: [], pitfalls: [], recall_questions: [], tags: [] } as unknown as Summary;
const metadata = { video_id: 'fixture', channel: 'mock', duration_display: '0:02', title: 'mock', transcript_source: 'fixture' } as VideoMetadata;
function mockBrowser(fail?: 'newPage' | 'content' | 'evaluate' | 'screenshot' | 'empty' | 'close' | 'font') {
  let closed = 0, shots = 0;
  const contentTimeouts: number[] = [], screenshotTimeouts: number[] = [];
  const pageOptions: unknown[] = [], offlineValues: boolean[] = [], screenshots: unknown[] = [];
  let intercepted = 0;
  const browser = {
    async close() { closed++; if (fail === 'close') throw new Error('close failed'); },
    async newPage(options: unknown) {
      pageOptions.push(options);
      if (fail === 'newPage') throw new Error('newPage failed');
      return {
        async setContent(_html: string, options: { timeout: number }) { contentTimeouts.push(options.timeout); if (fail === 'content') throw new Error('setContent failed'); },
        async evaluate(_fn: unknown, arg: unknown) {
          if (fail === 'evaluate') throw new Error('evaluate failed');
          if (fail === 'font' && arg && typeof arg === 'object' && 'display' in arg) throw new Error('字型未載入，已停止出圖：Gekiran。');
        },
        context() { return { async setOffline(value: boolean) { offlineValues.push(value); } }; },
        async route() { intercepted++; },
        async waitForFunction() {},
        locator() { return { async boundingBox() { return { x: 20, y: 40 + shots * 1390, width: 1080, height: 1350 }; } }; },
        async screenshot(options: { path: string; timeout: number; clip: unknown; scale: string }) {
          const { path: output, timeout } = options;
          screenshots.push(options); screenshotTimeouts.push(timeout); shots++;
          if (fail === 'screenshot' && shots === 2) throw new Error('screenshot failed');
          fs.writeFileSync(output, fail === 'empty' ? '' : `synthetic screenshot ${shots}`);
        },
      };
    },
  } as unknown as Pick<Browser, 'newPage' | 'close'>;
  return { browser, closed: () => closed, shots: () => shots, contentTimeouts, screenshotTimeouts, pageOptions, offlineValues, intercepted: () => intercepted, screenshots };
}
async function withOutput(run: (output: string) => Promise<void>) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'render-card-mock-'));
  try { await run(output); } finally { fs.rmSync(output, { recursive: true, force: true }); }
}
test('all expected cards succeed in exact source order; browser closes and staging is removed', async () => {
  await withOutput(async output => {
    const mock = mockBrowser();
    const result = await renderCard(summary, metadata, output, undefined, false, { launch: async () => mock.browser });
    assert.deepEqual(result.map(file => path.basename(file)), Array.from({ length: 20 }, (_, index) => `slide-${index + 1}.png`));
    result.forEach((file, index) => assert.equal(fs.readFileSync(file, 'utf8'), `synthetic screenshot ${index + 1}`));
    assert.deepEqual(mock.contentTimeouts, [30_000]);
    assert.deepEqual(mock.screenshotTimeouts, Array(20).fill(25_000));
    assert.equal(mock.closed(), 1); assert.equal(fs.readdirSync(output).some(name => name.startsWith('.render-')), false);
  });
});
test('a failed middle screenshot throws rather than returning shifted/incomplete paths or replacing prior cards', async () => {
  await withOutput(async output => {
    fs.writeFileSync(path.join(output, 'slide-1.png'), 'previous complete card');
    const mock = mockBrowser('screenshot');
    await assert.rejects(() => renderCard(summary, metadata, output, undefined, false, { launch: async () => mock.browser }), /第 2 張.*social-02.*未發布/);
    assert.equal(mock.shots(), 2); assert.equal(mock.closed(), 1);
    assert.deepEqual(fs.readdirSync(output), ['slide-1.png']);
    assert.equal(fs.readFileSync(path.join(output, 'slide-1.png'), 'utf8'), 'previous complete card');
  });
});
test('legacy summaries deterministically expand to 20 non-empty social cards', () => {
  const cards = resolveSocialCards(summary);
  assert.equal(cards.length, 20);
  assert.equal(cards[0].role, 'hook');
  assert.equal(cards[19].role, 'closing');
  assert.ok(cards.every(card => card.title.trim() && card.body.trim()));
});
test('newPage, setContent and evaluate errors always close the browser and remove staging', async () => {
  for (const fail of ['newPage', 'content', 'evaluate'] as const) await withOutput(async output => {
    const mock = mockBrowser(fail);
    await assert.rejects(() => renderCard(summary, metadata, output, undefined, false, { launch: async () => mock.browser }));
    assert.equal(mock.closed(), 1, fail); assert.equal(mock.shots(), 0); assert.deepEqual(fs.readdirSync(output), []);
  });
});
test('launch failure and zero-byte cards cannot produce a completed empty result', async () => {
  await withOutput(async output => {
    await assert.rejects(() => renderCard(summary, metadata, output, undefined, false, { launch: async () => { throw new Error('launch blocked'); } }), /launch blocked/);
    assert.deepEqual(fs.readdirSync(output), []);
    const mock = mockBrowser('empty');
    await assert.rejects(() => renderCard(summary, metadata, output, undefined, false, { launch: async () => mock.browser }), /第 1 張/);
    assert.equal(mock.closed(), 1); assert.deepEqual(fs.readdirSync(output), []);
  });
});
test('close failure never leaves staging or reports successful rendering', async () => {
  await withOutput(async output => {
    const mock = mockBrowser('close');
    await assert.rejects(() => renderCard(summary, metadata, output, undefined, false, { launch: async () => mock.browser }), /close failed/);
    assert.equal(mock.closed(), 1); assert.equal(fs.readdirSync(output).some(name => name.startsWith('.render-')), false);
  });
});

test('2x offline rendering sets deviceScaleFactor and uses page screenshot clip, never element screenshot', async () => {
  await withOutput(async output => {
    const mock = mockBrowser();
    await renderCard(summary, metadata, output, DEFAULT_CARD_STYLE, false, { scale: 2, offline: true, launch: async () => mock.browser });
    assert.deepEqual(mock.pageOptions, [{ viewport: { width: 1120, height: 27840 }, deviceScaleFactor: 2 }]);
    assert.deepEqual(mock.offlineValues, [true]); assert.equal(mock.intercepted(), 1);
    assert.equal(mock.screenshots.length, 20);
    for (const shot of mock.screenshots as { clip: { width: number; height: number }; scale: string }[]) {
      assert.equal(shot.clip.width, 1080); assert.equal(shot.clip.height, 1350); assert.equal(shot.scale, 'device');
    }
  });
});
test('missing font stops before screenshots and preserves previous complete output', async () => {
  await withOutput(async output => {
    fs.writeFileSync(path.join(output, 'slide-1.png'), 'previous card');
    const mock = mockBrowser('font');
    await assert.rejects(() => renderCard(summary, metadata, output, { ...DEFAULT_CARD_STYLE, fontPreset: 'bold-statement' }, false, { launch: async () => mock.browser }), /字型未載入.*Gekiran/);
    assert.equal(mock.shots(), 0); assert.equal(mock.closed(), 1);
    assert.deepEqual(fs.readdirSync(output), ['slide-1.png']);
  });
});
test('generated HTML uses local-only fonts, independent background classes and style tokens', () => {
  const style = { palette: 'forest-cream', fontPreset: 'round-display', background: 'ink-dark' };
  const result = buildCardHtml(summary, metadata, style);
  assert.deepEqual(result.style, style);
  assert.equal(result.theme.id, style.palette);
  assert.match(result.html, /--card-bg: #17150F/);
  assert.match(result.html, /--social-display: "JiaoTangBuDing"/);
  assert.match(result.html, /social-card--hook bg-ink-dark/);
  assert.match(result.html, /local\("AaJiaoTangBuDing"\)/);
  assert.doesNotMatch(result.html, /@import|<script src=|src:\s*url\("https?:/);
  assert.doesNotMatch(result.html, /--social-display:\s*['"](?:DFKai-SB|BiauKai)/);
  assert.equal((result.html.match(/class="social-top-bar"/g) || []).length, 20);
});

test('source text in visible and legacy hidden cards never becomes HTML or a template directive', () => {
  const payload = '</pre><img src=x onerror="alert(1)"><script>alert(1)</script>{{font_face_css}}$&';
  const unsafeSummary = { ...summary, title_display: payload, one_liner: payload, key_quote: payload,
    key_points: [{ label: payload, content: payload }], action_items: [{ action: payload, time_estimate: payload, expected_outcome: payload }],
    pitfalls: [{ warn: payload, why: payload }], highlights: [{ timestamp: 1, label: payload, description: payload }],
    tags: [payload], recall_questions: [payload] } as Summary;
  const result = buildCardHtml(unsafeSummary, { ...metadata, channel: payload, title: payload, transcript_source: payload });
  assert.doesNotMatch(result.html, /<img src=x|<script>alert/);
  assert.match(result.html, /&lt;img src=x/);
  assert.match(result.html, /\{\{font_face_css\}\}/);
});
test('long paragraphs always use body font even on hook and bold statement pages', () => {
  const result = buildCardHtml(summary, metadata, { ...DEFAULT_CARD_STYLE, fontPreset: 'bold-statement' });
  assert.match(result.html, /font: var\(--social-body-weight\) var\(--social-body-size\)\/1.62 var\(--social-serif\)/);
  assert.match(result.html, /--social-heading-font: var\(--social-display\)/);
});
