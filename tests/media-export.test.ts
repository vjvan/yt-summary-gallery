import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { startBurn } from '../lib/pipeline/start-burn';
import type { SummaryRow } from '../lib/db';
import { segmentsToSrt, segmentsToVtt } from '../lib/pipeline/generate-srt';
import { buildBilingualSegments, subtitleFontFamily, writeSubtitleFiles } from '../lib/pipeline/burn-bilingual';
import { canBurnSubtitleTrack, mediaFailureMessage, mediaResponse, pollMediaTask } from '../lib/media-export-client';

const source = [{ start: 59.9996, end: 3600.001, text: ' OpenArt & Higgsfield — Figma Weave. ' }];
const target = [{ ...source[0], text: ' 以 OpenArt 和 Higgsfield 操作 Figma Weave。 ' }];
test('SRT/VTT millisecond carry is valid and full whitespace/names are preserved', () => {
  assert.equal(segmentsToSrt(source), '1\n00:01:00,000 --> 01:00:00,001\n OpenArt & Higgsfield — Figma Weave. \n');
  assert.match(segmentsToVtt(source), /00:01:00\.000 --> 01:00:00\.001/);
  assert.throws(() => segmentsToSrt([{ ...source[0], end: NaN }]));
  assert.throws(() => segmentsToVtt([{ start: 0, end: 0.00001, text: 'too short' }]));
});
test('bilingual export places Traditional Chinese above English without truncating or mistiming cues', () => {
  assert.deepEqual(buildBilingualSegments(source, target), [{ ...source[0], text: `${target[0].text}\n${source[0].text}` }]);
  assert.throws(() => buildBilingualSegments(source, []), /不一致/);
  assert.throws(() => buildBilingualSegments(source, [target[0], target[0]]), /不一致/);
  assert.throws(() => buildBilingualSegments(source, [{ ...target[0], start: 1 }]), /不一致/);
});
test('complete subtitle files are exported; partial translation writes no misleading outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-srt-test-'));
  try {
    const bad = path.join(dir, 'partial');
    assert.throws(() => writeSubtitleFiles({ segments: source, segmentsZh: [], wasTranslated: true, outputDir: bad, contentId: 'fixture' }));
    assert.equal(fs.existsSync(bad), false);
    const files = writeSubtitleFiles({ segments: source, segmentsZh: target, wasTranslated: true, outputDir: dir, contentId: 'fixture' });
    assert.ok(fs.readFileSync(files.srtBiPath, 'utf8').includes(`${target[0].text}\n${source[0].text}`));
    assert.ok(fs.readFileSync(files.srtBiPath.replace('.srt', '.vtt'), 'utf8').includes(`${target[0].text}\n${source[0].text}`));
    assert.equal(fs.readFileSync(files.srtEnPath!, 'utf8'), segmentsToSrt(source));
    assert.equal(fs.readFileSync(files.srtZhPath!, 'utf8'), segmentsToSrt(target));
    const onlyNames = writeSubtitleFiles({ segments: [{ start: 0, end: 1, text: 'OpenArt, Higgsfield.' }], segmentsZh: [{ start: 0, end: 1, text: 'OpenArt, Higgsfield.' }], wasTranslated: true, outputDir: dir, contentId: 'names' });
    assert.match(fs.readFileSync(onlyNames.srtBiPath, 'utf8'), /OpenArt, Higgsfield\.\nOpenArt, Higgsfield\./);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('multiline bilingual SRT/VTT keep all Chinese lines above all English lines and preserve cue times', () => {
  const english = [{ start: 2.25, end: 6.5, text: 'First source line.\nSecond source line.' }];
  const chinese = [{ start: 2.25, end: 6.5, text: '第一行繁體中文。\n第二行繁體中文。' }];
  const paired = buildBilingualSegments(english, chinese);
  const ordered = `${chinese[0].text}\n${english[0].text}`;
  assert.deepEqual(paired, [{ start: 2.25, end: 6.5, text: ordered }]);
  assert.equal(segmentsToSrt(paired), `1\n00:00:02,250 --> 00:00:06,500\n${ordered}\n`);
  assert.equal(segmentsToVtt(paired), `WEBVTT\n\n00:00:02.250 --> 00:00:06.500\n${ordered}\n`);
  assert.deepEqual(english, [{ start: 2.25, end: 6.5, text: 'First source line.\nSecond source line.' }]);
  assert.deepEqual(chinese, [{ start: 2.25, end: 6.5, text: '第一行繁體中文。\n第二行繁體中文。' }]);
});

test('HTTP failures never look successful, and error display does not leak command/URL details', async () => {
  await assert.rejects(() => mediaResponse(Response.json({ error: 'Source video missing: /private/file' }, { status: 410 }), 'burn'), /找不到本機原始影片/);
  await assert.rejects(() => mediaResponse(Response.json({ error: '403 https://host/?token=secret' }, { status: 403 }), 'download'), /不會繞過/);
  assert.doesNotMatch(mediaFailureMessage('yt-dlp --token=secret https://secret', 'download'), /secret|https:/);
  assert.equal((await mediaResponse(Response.json({ status: 'burning' }, { status: 202 }), 'burn')).status, 'burning');
});
test('download polling stops on server failure immediately, not ten minutes later', async () => {
  let reads = 0, delays = 0;
  await assert.rejects(() => pollMediaTask({ action: 'download', signal: new AbortController().signal,
    read: async () => { reads++; return { id: 'test', error: 'download-video: HTTP 403 forbidden' }; }, onUpdate() {}, delay: async () => { delays++; },
  }), /403/);
  assert.equal(reads, 1); assert.equal(delays, 0);
});
test('poll uses one request at a time, ends on success, and is elapsed-time bounded', async () => {
  let active = 0, peak = 0, reads = 0, time = 0;
  const result = await pollMediaTask({ action: 'download', signal: new AbortController().signal,
    read: async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return ++reads === 3 ? { video_url: '/videos/test.mp4' } : {}; },
    onUpdate() {}, now: () => time, delay: async ms => { time += ms; },
  });
  assert.equal(peak, 1); assert.equal(reads, 3); assert.equal(result.video_url, '/videos/test.mp4');
  time = 0; reads = 0;
  await assert.rejects(() => pollMediaTask({ action: 'download', signal: new AbortController().signal, read: async () => { reads++; return {}; }, onUpdate() {}, now: () => time, timeoutMs: 4000, delay: async ms => { time += ms; } }), /逾時/);
  assert.equal(reads, 1);
});
test('cancelled or unmounted poll never applies a late result; burn error is visible', async () => {
  const controller = new AbortController(); let updates = 0;
  await assert.rejects(() => pollMediaTask({ action: 'download', signal: controller.signal, read: async () => { controller.abort(); return { video_url: '/late.mp4' }; }, onUpdate() { updates++; } }), /aborted/);
  assert.equal(updates, 0);
  await assert.rejects(() => pollMediaTask({ action: 'burn', signal: new AbortController().signal, read: async () => ({ burn_status: 'error', burn_error: 'No such filter: subtitles libass' }), onUpdate() {} }), /libass/);
});

test('new partial/processing records cannot burn incomplete Chinese; English and historical files remain usable', () => {
  for (const status of ['partial', 'processing', 'error']) {
    assert.equal(canBurnSubtitleTrack(status, 'bi'), false);
    assert.equal(canBurnSubtitleTrack(status, 'zh'), false);
    assert.equal(canBurnSubtitleTrack(status, 'en'), true);
  }
  for (const status of [undefined, null, 'complete']) for (const track of ['bi', 'zh', 'en'] as const) assert.equal(canBurnSubtitleTrack(status, track), true);
});

test('libass prefers installed readable Heiti TC over unavailable reserved PingFang', () => {
  assert.equal(subtitleFontFamily(file => file === '/System/Library/Fonts/STHeiti Medium.ttc'), 'Heiti TC');
  assert.equal(subtitleFontFamily(() => false), 'PingFang TC');
});

test('actual burn entry rejects incomplete zh/bi before launching FFmpeg or touching a database', () => {
  const row = { id: 'fixture', video_id: 'fixture', subtitle_status: 'partial' } as unknown as SummaryRow;
  assert.equal(startBurn(row, 'bi', true).status, 409);
  assert.equal(startBurn(row, 'zh', true).status, 409);
  // en reaches the unchanged source-video check; it is not rejected for partial Chinese.
  assert.equal(startBurn(row, 'en', true).status, 400);
});
test('unavailable hardware is explicit and never claims software fallback happened', () => {
  assert.match(mediaFailureMessage('h264_videotoolbox Cannot create compression session: -12903', 'burn'), /本人選擇.*libx264/);
});

test('actual download route has one in-flight task, sanitizes failure, and clears only prior download error on manual retry', async () => {
  const row: Record<string, unknown> = { id: 'row', video_id: 'fixture', url: 'https://www.youtube.com/watch?v=abcdefghijk', error: 'download-video: old failure' };
  let downloads = 0;
  let rejectDownload!: (error: Error) => void;
  let resolveDownload!: (result: { publicVideoUrl: string }) => void;
  const code = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'app/api/summaries/[id]/download-video/route.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exported: Record<string, (request: unknown, context: unknown) => Promise<Response>> = {};
  const context = vm.createContext({ exports: exported, Error, process: { cwd: () => '/mock-only' }, console: { error() {} },
    require(name: string) {
      if (name === 'next/server') return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
      if (name === '@/lib/media-export-client') return { mediaFailureMessage };
      if (name === '@/lib/pipeline/media-operation') return { acquireMediaOperation: () => 'fixture-lease', activeMediaOperation: () => null, releaseMediaOperation() {} };
      if (name === '@/lib/db') return { getDb: () => ({ prepare(sql: string) { return {
        get: () => row,
        run: (...args: unknown[]) => { if (sql.includes('error = NULL')) row.error = null; else if (sql.includes('video_url = ?')) row.video_url = args[0]; else if (sql.includes('error = ?')) row.error = args[0]; },
      }; } }) };
      if (name === '@/lib/pipeline/fetch-video-url') return { fetchVideoFromUrl: () => { downloads++; return new Promise((resolve, reject) => { resolveDownload = resolve; rejectDownload = reject; }); } };
      throw new Error('Unmocked dependency ' + name);
    },
  });
  vm.runInContext(code, context);
  const post = () => exported.POST({}, { params: Promise.resolve({ id: 'row' }) });
  assert.equal((await post()).status, 202); assert.equal(row.error, null);
  assert.equal((await post()).status, 202); assert.equal(downloads, 1);
  rejectDownload(new Error('403 forbidden URL https://private/?token=secret'));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(String(row.error), /^download-video:.*403/); assert.doesNotMatch(String(row.error), /secret|https:/);
  assert.equal((await post()).status, 202); assert.equal(row.error, null); assert.equal(downloads, 2);
  resolveDownload({ publicVideoUrl: '/videos/fixture.mp4' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await post()).status, 200); assert.equal(downloads, 2);
});
