import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AudioWatchService } from '../lib/watch/audio-service';
import { AudioUsageStore } from '../lib/watch/audio-store';
import { parseWhisperSegments, probeAudio, transcribeAudioChunk } from '../lib/watch/audio-transcribe';
import { readAudioMultipart, validateAudioChunk, MAX_AUDIO_BODY_BYTES } from '../lib/watch/audio-upload';
import { WatchError } from '../lib/watch/errors';
import type { AudioChunkInput } from '../lib/watch/audio-types';

const url = 'https://www.youtube.com/watch?v=kfbWz9_bJoA';
const glossary = () => ({ no_translate_terms: ['Weave'], term_map: [['mask', '遮罩']] as [string, string][], style_rules: [] });
function wav(duration = 1): Uint8Array {
  const sampleRate = 16000, dataSize = Math.round(duration * sampleRate) * 2;
  const result = Buffer.alloc(44 + dataSize);
  result.write('RIFF', 0); result.writeUInt32LE(36 + dataSize, 4); result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16); result.writeUInt16LE(1, 20); result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * 2, 28); result.writeUInt16LE(2, 32); result.writeUInt16LE(16, 34);
  result.write('data', 36); result.writeUInt32LE(dataSize, 40);
  return result;
}
function input(audioSessionId = 'session-1234', chunkId = 'chunk-12345', start = 0, end = 1): AudioChunkInput {
  return { audioSessionId, chunkId, start, end, confirmAudio: true, mime: 'audio/wav', bytes: wav(end - start) };
}
function request(chunk: AudioChunkInput) {
  const form = new FormData();
  for (const key of ['audioSessionId', 'chunkId', 'start', 'end'] as const) form.set(key, String(chunk[key]));
  form.set('confirmAudio', String(chunk.confirmAudio));
  form.set('file', new Blob([Uint8Array.from(chunk.bytes)], { type: chunk.mime }), 'chunk.wav');
  return new Request('http://127.0.0.1:3000/api/watch/audio/chunk', { method: 'POST', body: form });
}
function setup(options: { session?: number; daily?: number; fail?: boolean; silent?: boolean } = {}) {
  const store = new AudioUsageStore(':memory:'); let calls = 0, translations = 0;
  const contexts: string[][] = [];
  const service = new AudioWatchService({ store, probe: async () => ({ duration: 1 }),
    transcribe: async chunk => { calls++; if (options.fail) throw new WatchError('AUDIO_TRANSCRIPTION_FAILED', 'mock failure', 502); return options.silent ? [] : [{ id: `cue-${chunk.start}`, start: chunk.start, end: chunk.end, text: 'Use the mask.' }]; },
    translate: async ({ targets, before }) => { translations++; contexts.push(before.map(cue => cue.id)); return targets.map(cue => ({ ...cue, originalText: cue.text, text: '使用遮罩。' })); },
    glossary, enabled: () => true, limits: () => ({ sessionChunks: options.session || 10, dailyChunks: options.daily || 40 }),
  });
  const start = () => service.start({ url, title: 'Weave tutorial', confirmAudio: true, maxChunks: 10 });
  return { service, store, start, calls: () => calls, translations: () => translations, contexts };
}

test('multipart bytes, fields, consent, magic and video timestamp bounds are enforced before model use', async () => {
  const good = input();
  assert.equal((await readAudioMultipart(request(good))).bytes.length, good.bytes.length);
  for (const bad of [
    { ...good, confirmAudio: false }, { ...good, start: NaN }, { ...good, end: 16 },
    { ...good, bytes: new Uint8Array(0) }, { ...good, bytes: new Uint8Array(2 * 1024 * 1024 + 1) },
    { ...good, bytes: new Uint8Array(100) }, { ...good, chunkId: '../../bad' },
  ]) assert.throws(() => validateAudioChunk(bad));
  const oversized = request(good); oversized.headers.set('content-length', String(MAX_AUDIO_BODY_BYTES + 1));
  await assert.rejects(() => readAudioMultipart(oversized), { code: 'AUDIO_TOO_LARGE' });
  const duplicate = await request(good).formData(); duplicate.append('start', '2');
  await assert.rejects(() => readAudioMultipart(new Request('http://localhost/', { method: 'POST', body: duplicate })), { code: 'AUDIO_INVALID_BODY' });
  const streaming = new Request('http://localhost/', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=fixture' }, body: new Uint8Array(MAX_AUDIO_BODY_BYTES + 1) });
  await assert.rejects(() => readAudioMultipart(streaming), { code: 'AUDIO_TOO_LARGE' });
});

test('real local ffprobe validates generated WAV duration without writing or uploading audio', async () => {
  assert.equal((await probeAudio(input())).duration, 1);
  await assert.rejects(() => probeAudio({ ...input(), end: 2 }), { code: 'AUDIO_PLAYBACK_RATE' });
  await assert.rejects(() => probeAudio({ ...input(), bytes: wav(16) }), { code: 'AUDIO_DURATION' });
});

test('Whisper timestamps are offset into video, silence removed, non-English and invalid timing rejected', () => {
  const result = parseWhisperSegments({ language: 'english', segments: [
    { start: 0, end: 1, text: 'Use the mask.', no_speech_prob: 0.1 },
    { start: 1, end: 2, text: 'Hallucinated silence.', no_speech_prob: 0.9 },
  ] }, { start: 30, end: 32 }, 'hash');
  assert.equal(result.length, 1); assert.equal(result[0].start, 30); assert.equal(result[0].end, 31);
  assert.deepEqual(parseWhisperSegments({ language: 'japanese', segments: [{ start: 0, end: 1, text: 'silence', no_speech_prob: 0.99 }] }, { start: 0, end: 1 }, 'h'), []);
  for (const data of [
    { language: 'japanese', segments: [{ start: 0, end: 1, text: 'こんにちは' }] },
    { language: 'english', segments: [{ start: -1, end: 1, text: 'No' }] },
    { language: 'english', segments: [{ start: 0, end: 99, text: 'No' }] },
    { language: 'english', segments: [{ start: NaN, end: 1, text: 'No' }] },
    { language: 'english', segments: [{ start: 0, end: 1, text: 'No', no_speech_prob: 1.5 }] },
  ]) assert.throws(() => parseWhisperSegments(data, { start: 0, end: 2 }, 'h'));
});

test('dense transcripts merge to <=8 target cues using only observed boundaries', () => {
  const segments = Array.from({ length: 16 }, (_, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4, text: `Sentence ${i}.` }));
  const cues = parseWhisperSegments({ language: 'en', segments }, { start: 10, end: 20 }, 'hash');
  assert(cues.length <= 8);
  for (const cue of cues) { assert(segments.some(s => s.start + 10 === cue.start)); assert(segments.some(s => s.end + 10 === cue.end)); }
});

test('chunk identity/content retry is cached, conflict rejected, context resets on seek', async () => {
  const h = setup();
  try {
    const s = h.start(); const chunk = input(s.audioSessionId);
    const first = await h.service.chunk(chunk); assert.equal(first.cached, false);
    assert.equal((await h.service.chunk(chunk)).cached, true);
    assert.equal((await h.service.chunk({ ...chunk, chunkId: 'alias-1234' })).cached, true);
    assert.equal(h.calls(), 1); assert.equal(h.store.used(), 1);
    await assert.rejects(() => h.service.chunk({ ...chunk, end: 2 }), { code: 'AUDIO_CHUNK_CONFLICT' });
    await assert.rejects(() => h.service.chunk({ ...chunk, chunkId: 'alias-1234', end: 2 }), { code: 'AUDIO_CHUNK_CONFLICT' });
    await h.service.chunk(input(s.audioSessionId, 'chunk-next', 1, 2));
    await h.service.chunk(input(s.audioSessionId, 'chunk-seek', 30, 31));
    assert.deepEqual(h.contexts, [[], ['cue-0'], []]);
    h.service.stop(s.audioSessionId);
    await assert.rejects(() => h.service.chunk(chunk), { code: 'AUDIO_SESSION_EXPIRED' });
  } finally { h.store.close(); }
});

test('session/day caps and provider failures conservatively count; silence does not translate', async () => {
  const failed = setup({ fail: true });
  try {
    const s = failed.start(); const chunk = input(s.audioSessionId);
    await assert.rejects(() => failed.service.chunk(chunk));
    await assert.rejects(() => failed.service.chunk(chunk));
    assert.equal(failed.calls(), 1); assert.equal(failed.store.used(), 1);
  } finally { failed.store.close(); }
  const silent = setup({ silent: true });
  try { const s = silent.start(); assert.deepEqual((await silent.service.chunk(input(s.audioSessionId))).cues, []); assert.equal(silent.translations(), 0); assert.equal(silent.store.used(), 1); } finally { silent.store.close(); }
  const limited = setup({ session: 2, daily: 3 });
  try {
    const s = limited.start(); await limited.service.chunk(input(s.audioSessionId)); await limited.service.chunk(input(s.audioSessionId, 'chunk-two2', 1, 2));
    await assert.rejects(() => limited.service.chunk(input(s.audioSessionId, 'chunk-over', 2, 3)), { code: 'AUDIO_SESSION_LIMIT' });
    const next = limited.start(); await limited.service.chunk(input(next.audioSessionId));
    await assert.rejects(() => limited.service.chunk(input(next.audioSessionId, 'chunk-over', 2, 3)), { code: 'AUDIO_DAILY_LIMIT' });
    assert.equal(limited.calls(), 3);
  } finally { limited.store.close(); }
});

test('daily counts persist independently across store reopen; no audio or transcript tables', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-audio-test-'));
  const file = path.join(folder, 'usage.db');
  try {
    const first = new AudioUsageStore(file); first.reserve(2); first.close();
    const reopened = new AudioUsageStore(file); assert.equal(reopened.used(), 1); reopened.reserve(2);
    assert.throws(() => reopened.reserve(2), { code: 'AUDIO_DAILY_LIMIT' }); reopened.close();
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('one inflight per session, two globally; stop aborts provider and never returns stale results', async () => {
  const store = new AudioUsageStore(':memory:'); let calls = 0;
  const service = new AudioWatchService({ store, probe: async () => ({ duration: 1 }),
    transcribe: async (_input, _hash, signal) => { calls++; return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('stop', 'AbortError')))); },
    translate: async () => [], glossary, enabled: () => true, limits: () => ({ sessionChunks: 10, dailyChunks: 40 }),
  });
  const a = service.start({ url, confirmAudio: true, maxChunks: 10 }); const b = service.start({ url, confirmAudio: true, maxChunks: 10 }); const c = service.start({ url, confirmAudio: true, maxChunks: 10 });
  try {
    const chunkA = input(a.audioSessionId); const pendingA = service.chunk(chunkA); const duplicate = service.chunk(chunkA);
    const pendingB = service.chunk(input(b.audioSessionId));
    const assertA = assert.rejects(pendingA, { code: 'CANCELLED' }), assertDuplicate = assert.rejects(duplicate, { code: 'CANCELLED' }), assertB = assert.rejects(pendingB, { code: 'CANCELLED' });
    await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(() => service.chunk(input(a.audioSessionId, 'other-one', 2, 3)), { code: 'AUDIO_BUSY' });
    await assert.rejects(() => service.chunk(input(c.audioSessionId)), { code: 'AUDIO_BUSY' });
    assert.equal(calls, 2); service.stop(a.audioSessionId); service.stop(b.audioSessionId);
    await Promise.all([assertA, assertDuplicate, assertB]); assert.equal(store.used(), 2);
  } finally { store.close(); }
});

test('Whisper provider adapter only calls mock fetch with verbose_json and no forced translation', async () => {
  const originalFetch = globalThis.fetch, key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'mock-audio-test-key';
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    const form = init!.body as FormData;
    assert.equal(form.get('model'), 'whisper-1'); assert.equal(form.get('response_format'), 'verbose_json'); assert.equal(form.has('language'), false);
    return new Response(JSON.stringify({ language: 'english', segments: [{ start: 0, end: 1, text: 'Use the mask.', no_speech_prob: 0.1 }] }));
  };
  try { assert.equal((await transcribeAudioChunk(input(), 'h')).length, 1); }
  finally { globalThis.fetch = originalFetch; if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key; }
});


test('streamable standalone WebM without seekable metadata is timed from packet PTS', async () => {
  const generated = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { timeout: 5000, maxBuffer: 1024 * 1024 });
  assert.equal(generated.status, 0);
  const chunk: AudioChunkInput = { ...input(), mime: 'audio/webm', bytes: generated.stdout };
  validateAudioChunk(chunk);
  const probe = await probeAudio(chunk);
  assert(probe.duration > 0.9 && probe.duration < 1.2);
});
