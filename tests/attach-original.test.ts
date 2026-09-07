import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import Database from 'better-sqlite3';
import { attachOriginalVideo, attachmentErrorResponse, assertAttachmentRequest, probeAttachedMp4, type ProbedVideo } from '../lib/pipeline/attach-original';
import { acquireMediaOperation, activeMediaOperation, releaseMediaOperation } from '../lib/pipeline/media-operation';
import { canBurnSubtitleTrack } from '../lib/media-export-client';

function bytes() { const b = Buffer.alloc(64); b.writeUInt32BE(24); b.write('ftypisom', 4); b.write('isommp42', 16); return b; }
const validProbe: ProbedVideo = { duration: 3, videoDuration: 3, start: 0, videoStart: 0 };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-original-'));
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE summaries (
    id TEXT PRIMARY KEY, video_id TEXT UNIQUE, url TEXT, source TEXT, title TEXT,
    duration REAL, status TEXT, subtitle_status TEXT, is_video INTEGER, video_url TEXT,
    burn_status TEXT, burn_error TEXT, burned_video_url TEXT, auto_burn TEXT,
    transcript TEXT, transcript_zh TEXT, segments TEXT, segments_zh TEXT, summary TEXT,
    error TEXT, pipeline_stage TEXT, srt_en_path TEXT, srt_zh_path TEXT, srt_bi_path TEXT, card_paths TEXT
  )`);
  const en = JSON.stringify([{ start: 0, end: 1, text: 'OpenArt & Higgsfield' }, { start: 1, end: 2.9, text: 'Keep the entire source.' }]);
  const zh = JSON.stringify([{ start: 0, end: 1, text: 'OpenArt 和 Higgsfield' }, { start: 1, end: 2.9, text: '保留完整原文。' }]);
  db.prepare(`INSERT INTO summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'row_123', 'video_123', 'https://www.youtube.com/watch?v=abcdefghijk', 'youtube', '原摘要標題', 3,
    'done', 'complete', 0, null, null, 'preserve burn error', null, 'bi',
    'original transcript', '完整中譯', en, zh, '{"summary":"KEEP ALL"}', 'download-video: previous failure', 'done',
    '/burned/fixture.en.srt', '/burned/fixture.zh.srt', '/burned/fixture.bi.srt', '["/cards/fixture.png"]');
  fs.mkdirSync(path.join(root, 'public', 'burned'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'burned', 'fixture.bi.srt'), 'do not regenerate subtitles');
  fs.writeFileSync(path.join(root, 'data', 'translation-cache.fixture'), 'do not modify successful cache');
  return { root, db, row: () => db.prepare('SELECT * FROM summaries').get() as Record<string, unknown>,
    close() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
function request(body: Uint8Array | ReadableStream<Uint8Array> = bytes(), headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request('http://127.0.0.1:3000/api/summaries/row_123/attach-video', {
    method: 'POST', headers: { origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin', 'content-type': 'video/mp4',
      'x-confirm-rights': 'true', 'x-confirm-same-timeline': 'true', 'x-file-size': String(body instanceof Uint8Array ? body.byteLength : 64), ...headers },
    body: body as BodyInit, signal, ...((body instanceof ReadableStream) ? { duplex: 'half' } : {}),
  });
}
async function errorCode(work: () => Promise<unknown>, expected: string) {
  await assert.rejects(work, (error: unknown) => { assert.equal((error as { code: string }).code, expected); return true; });
}
function assertClean(f: ReturnType<typeof fixture>) {
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM summary_media_operations').get() && (f.db.prepare('SELECT count(*) AS n FROM summary_media_operations').get() as { n: number }).n, 0);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM summary_video_attachments').get() as { n: number }).n, 0);
  for (const directory of ['public/videos', 'data/tmp/attached-originals']) {
    const full = path.join(f.root, directory); if (fs.existsSync(full)) assert.deepEqual(fs.readdirSync(full), []);
  }
}

test('successful attachment preserves content/subtitles/cache, clears only resolved download error, and never auto-burns', async () => {
  const f = fixture(); const before = f.row(); let probes = 0;
  try {
    const result = await attachOriginalVideo(request(), 'row_123', { ...f, probe: async () => { probes++; return validProbe; } });
    assert.equal(result.status, 'done'); assert.equal(result.attachment.timeline, 'user-confirmed-same-version'); assert.equal(probes, 1);
    assert.deepEqual(f.row(), { ...before, is_video: 1, video_url: result.video_url, error: null });
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'public', result.video_url)), bytes());
    assert.equal(fs.readFileSync(path.join(f.root, 'public/burned/fixture.bi.srt'), 'utf8'), 'do not regenerate subtitles');
    assert.equal(fs.readFileSync(path.join(f.root, 'data/translation-cache.fixture'), 'utf8'), 'do not modify successful cache');
    assert.equal(f.row().burn_status, null); assert.equal(f.row().auto_burn, 'bi');
    assert.equal(activeMediaOperation(f.db, 'row_123'), null);
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'data/tmp/attached-originals')), []);
    const audit = f.db.prepare('SELECT * FROM summary_video_attachments').get() as Record<string, unknown>;
    assert.equal(audit.rights_confirmed, 1); assert.equal(audit.timeline_confirmation, 'user-confirmed-same-version');
  } finally { f.close(); }
});

test('same-version and rights confirmations are mandatory, independent of equal duration', async () => {
  for (const [headers, code] of [[{ 'x-confirm-rights': 'false' }, 'RIGHTS_REQUIRED'], [{ 'x-confirm-same-timeline': 'false' }, 'TIMELINE_CONFIRMATION_REQUIRED']] as const) {
    const f = fixture(); const before = f.row(); let probes = 0;
    try {
      await errorCode(() => attachOriginalVideo(request(bytes(), headers), 'row_123', { ...f, probe: async () => { probes++; return validProbe; } }), code);
      assert.equal(probes, 0); assert.deepEqual(f.row(), before); assert.equal(fs.existsSync(path.join(f.root, 'public/videos')), false);
    } finally { f.close(); }
  }
});

test('write access rejects remote Host/Origin, cross-site requests and extension origins without touching storage', () => {
  const rejected = [request(bytes(), { origin: 'https://evil.example' }), request(bytes(), { host: 'evil.example:3000' }), request(bytes(), { 'sec-fetch-site': 'cross-site' }), request(bytes(), { origin: `chrome-extension://${'a'.repeat(32)}` })];
  for (const req of rejected) assert.throws(() => assertAttachmentRequest(req));
  assert.doesNotThrow(() => assertAttachmentRequest(request()));
  const mapped = attachmentErrorResponse(new Error('/private/secret?token=confidential'));
  assert.equal(mapped.status, 500);
});

test('ffprobe validation rejects garbage, renamed non-MP4, and audio-only MP4, not merely MIME', async () => {
  const f = fixture(); const before = f.row();
  try {
    await errorCode(() => attachOriginalVideo(request(Buffer.from('not a video file'.repeat(4))), 'row_123', { ...f, probe: async () => { throw new Error('must reject header first'); } }), 'INVALID_VIDEO');
    assertClean(f); assert.deepEqual(f.row(), before);
    await errorCode(() => attachOriginalVideo(request(), 'row_123', f), 'INVALID_VIDEO');
    assertClean(f);
    const audio = path.join(f.root, 'audio.mp4');
    execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc', '-t', '3', '-c:a', 'aac', audio]);
    await errorCode(() => attachOriginalVideo(request(fs.readFileSync(audio)), 'row_123', f), 'INVALID_VIDEO');
    assertClean(f);
  } finally { f.close(); }
});

test('actual small H.264 MP4 passes ffprobe and is attached without an ASR/translation dependency', async () => {
  const f = fixture();
  try {
    const video = path.join(f.root, 'fixture.mp4');
    execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=10', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    const metadata = await probeAttachedMp4(video, new AbortController().signal);
    assert.equal(metadata.duration, 3); assert.equal(metadata.videoDuration, 3);
    const result = await attachOriginalVideo(request(fs.readFileSync(video)), 'row_123', f);
    assert.equal(result.status, 'done'); assert.equal(f.row().transcript, 'original transcript');
  } finally { f.close(); }
});

test('duration, subtitle coverage and zero-based start are independently checked; failures leave no metadata or files', async () => {
  for (const [probe, code] of [
    [{ ...validProbe, duration: 2, videoDuration: 2 }, 'VIDEO_TOO_SHORT'],
    [{ ...validProbe, duration: 8, videoDuration: 8 }, 'DURATION_MISMATCH'],
    [{ ...validProbe, start: 2 }, 'VIDEO_START_OFFSET'],
    [{ ...validProbe, videoStart: 2 }, 'VIDEO_START_OFFSET'],
    [{ ...validProbe, videoDuration: NaN }, 'INVALID_VIDEO'],
  ] as const) {
    const f = fixture(); const before = f.row();
    try {
      await errorCode(() => attachOriginalVideo(request(), 'row_123', { ...f, probe: async () => probe }), code);
      assert.deepEqual(f.row(), before); assertClean(f);
    } finally { f.close(); }
  }
});

test('declared size and measured stream cap reject oversize/truncated uploads without full-body buffering', async () => {
  for (const [body, headers, maxBytes, code] of [
    [bytes(), { 'x-file-size': String(2 * 1024 ** 3 + 1) }, undefined, 'VIDEO_TOO_LARGE'],
    [bytes(), {}, 32, 'VIDEO_TOO_LARGE'],
    [bytes(), { 'x-file-size': '100' }, undefined, 'SIZE_MISMATCH'],
    [new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes()); controller.enqueue(bytes()); controller.close(); } }), {}, undefined, 'VIDEO_TOO_LARGE'],
  ] as [Uint8Array | ReadableStream<Uint8Array>, Record<string, string>, number | undefined, string][]) {
    const f = fixture(); const before = f.row();
    try {
      await errorCode(() => attachOriginalVideo(request(body, headers), 'row_123', { ...f, maxBytes, probe: async () => validProbe }), code);
      assert.deepEqual(f.row(), before);
      if (fs.existsSync(path.join(f.root, 'data/tmp'))) assertClean(f);
    } finally { f.close(); }
  }
});

test('disk reserve failure cleans lease and keeps summary and cache unchanged', async () => {
  const f = fixture(); const before = f.row();
  try {
    await errorCode(() => attachOriginalVideo(request(), 'row_123', { ...f, diskAvailable: async () => 1024 }), 'INSUFFICIENT_DISK');
    assertClean(f); assert.deepEqual(f.row(), before);
  } finally { f.close(); }
});

test('already-attached, burning, processing and unsafe row/request IDs are rejected before a write', async () => {
  for (const [sql, id, code] of [
    ["UPDATE summaries SET video_url='/videos/existing.mp4'", 'row_123', 'VIDEO_EXISTS'],
    ["UPDATE summaries SET burn_status='burning'", 'row_123', 'MEDIA_BUSY'],
    ["UPDATE summaries SET subtitle_status='processing'", 'row_123', 'SUMMARY_BUSY'],
    ["UPDATE summaries SET video_id='../escape'", 'row_123', 'INVALID_ID'],
    ['', '../escape', 'INVALID_ID'],
    ["UPDATE summaries SET duration=0", 'row_123', 'UNKNOWN_SOURCE_DURATION'],
  ]) {
    const f = fixture(); if (sql) f.db.exec(sql); const before = f.row();
    try {
      await errorCode(() => attachOriginalVideo(request(), id, { ...f, probe: async () => validProbe }), code);
      assert.deepEqual(f.row(), before); assert.equal(fs.existsSync(path.join(f.root, 'public/videos')), false);
    } finally { f.close(); }
  }
});

test('simultaneous attachment and active download are excluded by a shared SQL lease', async () => {
  const f = fixture(); let resume!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const blocked = new Promise<void>(resolve => { resume = resolve; });
  try {
    const first = attachOriginalVideo(request(), 'row_123', { ...f, probe: async () => { entered(); await blocked; return validProbe; } });
    await started;
    await errorCode(() => attachOriginalVideo(request(), 'row_123', f), 'MEDIA_BUSY');
    assert.equal(acquireMediaOperation(f.db, 'row_123', 'download'), null);
    resume(); assert.equal((await first).status, 'done');
  } finally { resume?.(); f.close(); }
  const next = fixture();
  try {
    const token = acquireMediaOperation(next.db, 'row_123', 'download')!;
    await errorCode(() => attachOriginalVideo(request(), 'row_123', next), 'MEDIA_BUSY');
    assert.equal(activeMediaOperation(next.db, 'row_123'), 'download');
    releaseMediaOperation(next.db, 'row_123', token); assertClean(next);
  } finally { next.close(); }
});

test('row changes during ffprobe are rechecked in the commit transaction; no overwrite or orphan publish', async () => {
  const f = fixture();
  try {
    await errorCode(() => attachOriginalVideo(request(), 'row_123', { ...f, probe: async () => {
      f.db.prepare("UPDATE summaries SET video_url='/videos/winner.mp4', transcript='changed concurrently' WHERE id='row_123'").run(); return validProbe;
    } }), 'VIDEO_EXISTS');
    assert.equal(f.row().video_url, '/videos/winner.mp4'); assert.equal(f.row().transcript, 'changed concurrently'); assertClean(f);
  } finally { f.close(); }
});

test('an abort and stalled-upload timeout cancel the reader, clear temporary files, and release the lease', async () => {
  for (const cancelByUser of [true, false]) {
    const f = fixture(); const controller = new AbortController(); let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(output) { output.enqueue(bytes().subarray(0, 24)); }, cancel() { cancelled = true; } });
    try {
      const work = attachOriginalVideo(request(stream, {}, controller.signal), 'row_123', { ...f, timeoutMs: cancelByUser ? 1000 : 30 });
      if (cancelByUser) setTimeout(() => controller.abort(), 30);
      await errorCode(() => work, cancelByUser ? 'UPLOAD_CANCELLED' : 'UPLOAD_TIMEOUT');
      assert.equal(cancelled, true); assertClean(f); assert.equal(f.row().video_url, null);
    } finally { f.close(); }
  }
});

test('symlinked public or scratch paths never escape the artifact roots', async () => {
  for (const directory of ['public/videos', 'data/tmp']) {
    const f = fixture(); const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-outside-'));
    try {
      fs.symlinkSync(outside, path.join(f.root, directory));
      await errorCode(() => attachOriginalVideo(request(), 'row_123', { ...f, probe: async () => validProbe }), 'UNSAFE_STORAGE');
      assert.deepEqual(await fsp.readdir(outside), []); assert.equal(f.row().video_url, null); assert.equal(activeMediaOperation(f.db, 'row_123'), null);
    } finally { f.close(); fs.rmSync(outside, { recursive: true, force: true }); }
  }
});


test('partial translated subtitles remain partial and Chinese/bilingual burning remains blocked after attachment', async () => {
  const f = fixture();
  f.db.exec("UPDATE summaries SET subtitle_status='partial', error='keep non-download failure', srt_bi_path=NULL, srt_zh_path=NULL");
  f.db.prepare('UPDATE summaries SET segments_zh=?').run(JSON.stringify([{ start: 0, end: 1, text: '已有成功中譯' }]));
  const before = f.row();
  try {
    const result = await attachOriginalVideo(request(), 'row_123', { ...f, probe: async () => validProbe });
    assert.deepEqual(f.row(), { ...before, video_url: result.video_url, is_video: 1 });
    assert.equal(canBurnSubtitleTrack(String(f.row().subtitle_status), 'zh'), false);
    assert.equal(canBurnSubtitleTrack(String(f.row().subtitle_status), 'bi'), false);
    assert.equal(canBurnSubtitleTrack(String(f.row().subtitle_status), 'en'), true);
  } finally { f.close(); }
});

test('actual route contract authenticates before opening DB and returns sanitized errors plus a successful raw-body result', async () => {
  const f = fixture(); let dbOpens = 0;
  const exported: Record<string, (req: Request, ctx: unknown) => Promise<Response>> = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'app/api/summaries/[id]/attach-video/route.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports: exported, Response, process: { cwd: () => f.root }, require(name: string) {
    if (name === '@/lib/db') return { getDb() { dbOpens++; return f.db; } };
    if (name === '@/lib/pipeline/attach-original') return { assertAttachmentRequest, attachmentErrorResponse,
      attachOriginalVideo: (req: Request, id: string, options: object) => attachOriginalVideo(req, id, { ...f, ...options, probe: async () => validProbe }) };
    throw new Error('Unmocked dependency: ' + name);
  } });
  const ctx = { params: Promise.resolve({ id: 'row_123' }) };
  try {
    const unauthorized = await exported.POST(request(bytes(), { 'x-confirm-rights': 'false' }), ctx);
    assert.equal(unauthorized.status, 403); assert.equal((await unauthorized.json()).code, 'RIGHTS_REQUIRED'); assert.equal(dbOpens, 0);
    assert.equal((await exported.POST(request(bytes(), { origin: 'https://evil.example' }), ctx)).status, 403); assert.equal(dbOpens, 0);
    const accepted = await exported.POST(request(), ctx); assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('cache-control'), 'no-store'); assert.equal((await accepted.json()).status, 'done'); assert.equal(dbOpens, 1);
    const duplicate = await exported.POST(request(), ctx); assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, 'VIDEO_EXISTS');
  } finally { f.close(); }
});

test('SQL publication failure rolls back summary metadata and removes the already-linked MP4', async () => {
  const f = fixture(); const before = f.row();
  try {
    // Initialize only the fixture schema, then fail inside the atomic publish transaction.
    const token = acquireMediaOperation(f.db, 'row_123', 'attach')!;
    releaseMediaOperation(f.db, 'row_123', token);
    f.db.exec("CREATE TRIGGER fail_attachment BEFORE INSERT ON summary_video_attachments BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END;");
    await assert.rejects(() => attachOriginalVideo(request(), 'row_123', { ...f, probe: async () => validProbe }), /fixture commit failure/);
    assert.deepEqual(f.row(), before); assertClean(f);
  } finally { f.close(); }
});

test('actual download route respects active attachment lease and holds a lease until its asynchronous work finishes', async () => {
  const f = fixture(); let downloads = 0; let complete!: (result: { publicVideoUrl: string }) => void;
  const exported: Record<string, (req: unknown, ctx: unknown) => Promise<Response>> = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(process.cwd(), 'app/api/summaries/[id]/download-video/route.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports: exported, Error, process: { cwd: () => f.root }, console: { error() {} }, require(name: string) {
    if (name === 'next/server') return { NextResponse: { json: (data: unknown, init?: ResponseInit) => Response.json(data, init) } };
    if (name === '@/lib/db') return { getDb: () => f.db };
    if (name === '@/lib/pipeline/media-operation') return { acquireMediaOperation, activeMediaOperation, releaseMediaOperation };
    if (name === '@/lib/media-export-client') return { mediaFailureMessage: () => 'fixture safe failure' };
    if (name === '@/lib/pipeline/fetch-video-url') return { fetchVideoFromUrl: () => { downloads++; return new Promise(resolve => { complete = resolve; }); } };
    throw new Error('Unmocked dependency: ' + name);
  } });
  const ctx = { params: Promise.resolve({ id: 'row_123' }) };
  try {
    const token = acquireMediaOperation(f.db, 'row_123', 'attach')!;
    const blocked = await exported.POST({}, ctx); assert.equal(blocked.status, 409); assert.equal(downloads, 0);
    releaseMediaOperation(f.db, 'row_123', token);
    assert.equal((await exported.POST({}, ctx)).status, 202); assert.equal(downloads, 1);
    assert.equal(activeMediaOperation(f.db, 'row_123'), 'download');
    await errorCode(() => attachOriginalVideo(request(), 'row_123', f), 'MEDIA_BUSY');
    complete({ publicVideoUrl: '/videos/downloaded-fixture.mp4' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(activeMediaOperation(f.db, 'row_123'), null); assert.equal(f.row().video_url, '/videos/downloaded-fixture.mp4');
  } finally { f.close(); }
});
