import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioWatchService } from '../lib/watch/audio-service';
import { AudioUsageStore } from '../lib/watch/audio-store';
import { localWhisperConfigured, parseLocalWhisperSegments, runLocalAudioProcess, transcribeLocalAudioChunk } from '../lib/watch/audio-local-transcribe';
import { WatchError } from '../lib/watch/errors';
import type { AudioChunkInput } from '../lib/watch/audio-types';

const url = 'https://www.youtube.com/watch?v=kfbWz9_bJoA';
const glossary = () => ({ no_translate_terms: [], term_map: [], style_rules: [] });
function wav() {
  const bytes = Buffer.alloc(44 + 32000);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(32000, 40); return bytes;
}
function input(audioSessionId = 'local-session', index = 0): AudioChunkInput {
  return { audioSessionId, chunkId: `chunk-${String(index).padStart(8, '0')}`, start: index, end: index + 1, bytes: wav(), mime: 'audio/wav', confirmAudio: true };
}
const fixture = () => ({ model: { multilingual: true }, params: { translate: false }, result: { language: 'en' },
  transcription: [{ offsets: { from: 100, to: 900 }, text: 'Use the mask.' }] });

test('whisper.cpp milliseconds become observed video timestamps; English auto-detection is required', () => {
  const cues = parseLocalWhisperSegments(fixture(), { start: 30, end: 31 }, 'fixture');
  assert.equal(cues[0].start, 30.1); assert.equal(cues[0].end, 30.9);
  const nonEnglish = { ...fixture(), result: { language: 'ja' } };
  assert.throws(() => parseLocalWhisperSegments(nonEnglish, { start: 30, end: 31 }, 'h'), { code: 'AUDIO_ENGLISH_ONLY' });
  assert.throws(() => parseLocalWhisperSegments({ ...fixture(), model: { multilingual: false } }, { start: 0, end: 1 }, 'h'), { code: 'LOCAL_AUDIO_MODEL_LANGUAGE' });
  assert.throws(() => parseLocalWhisperSegments({ ...fixture(), params: { translate: true } }, { start: 0, end: 1 }, 'h'), { code: 'LOCAL_AUDIO_FORMAT' });
  for (const offsets of [{ from: 0, to: 9000 }, { from: NaN, to: 900 }, { from: 0, to: -1 }, { from: '0', to: '900' }]) {
    assert.throws(() => parseLocalWhisperSegments({ ...fixture(), transcription: [{ offsets, text: 'No.' }] }, { start: 0, end: 1 }, 'h'));
  }
  assert.deepEqual(parseLocalWhisperSegments({ ...fixture(), transcription: [] }, { start: 0, end: 1 }, 'h'), []);
  assert.deepEqual(parseLocalWhisperSegments({ ...fixture(), transcription: [{ offsets: { from: 0, to: 900 }, text: '[BLANK_AUDIO]' }] }, { start: 0, end: 1 }, 'h'), []);
});

async function withLocalConfig(operation: (directory: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-local-test-'));
  const previousModel = process.env.WATCH_LOCAL_WHISPER_MODEL, previousBin = process.env.WATCH_LOCAL_WHISPER_BIN;
  process.env.WATCH_LOCAL_WHISPER_MODEL = path.join(directory, 'fixture-model.bin');
  process.env.WATCH_LOCAL_WHISPER_BIN = process.execPath;
  fs.writeFileSync(process.env.WATCH_LOCAL_WHISPER_MODEL, 'not a real model', { mode: 0o600 });
  try { await operation(directory); }
  finally {
    if (previousModel === undefined) delete process.env.WATCH_LOCAL_WHISPER_MODEL; else process.env.WATCH_LOCAL_WHISPER_MODEL = previousModel;
    if (previousBin === undefined) delete process.env.WATCH_LOCAL_WHISPER_BIN; else process.env.WATCH_LOCAL_WHISPER_BIN = previousBin;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('local adapter really converts synthetic WAV, uses private temp files, and never calls a network provider', async () => {
  await withLocalConfig(async directory => {
    assert.equal(localWhisperConfigured(), true);
    let calls = 0, workdir = '';
    const cues = await transcribeLocalAudioChunk(input(), 'h', undefined, { tempRoot: directory,
      run: async (executable, args, options) => {
        calls++; workdir = options.cwd!;
        assert.equal(fs.statSync(workdir).mode & 0o777, 0o700);
        if (executable === 'ffmpeg') {
          assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'pipe');
          assert.equal(args[args.indexOf('-ar') + 1], '16000');
          assert.equal(args[args.indexOf('-ac') + 1], '1');
          await runLocalAudioProcess(executable, args, options);
        } else {
          assert.equal(executable, process.execPath);
          assert.equal(args[args.indexOf('-l') + 1], 'auto'); assert(args.includes('-oj')); assert(!args.includes('-tr'));
          assert.equal(fs.statSync(args[args.indexOf('-f') + 1]).mode & 0o777, 0o600);
          fs.writeFileSync(`${args[args.indexOf('-of') + 1]}.json`, JSON.stringify(fixture()));
        }
      },
    });
    assert.equal(calls, 2); assert.equal(cues[0].text, 'Use the mask.'); assert.equal(fs.existsSync(workdir), false);
  });
});

test('local failures remove temporary artifacts and missing configuration never falls back', async () => {
  await withLocalConfig(async directory => {
    let workdir = '';
    await assert.rejects(() => transcribeLocalAudioChunk(input(), 'h', undefined, { tempRoot: directory,
      run: async (_exe, _args, options) => { workdir = options.cwd!; throw new WatchError('LOCAL_AUDIO_PROCESS_FAILED', 'fixture', 502); },
    }), { code: 'LOCAL_AUDIO_PROCESS_FAILED' });
    assert.equal(fs.existsSync(workdir), false);
    process.env.WATCH_LOCAL_WHISPER_MODEL = path.join(directory, 'missing.bin');
    assert.equal(localWhisperConfigured(), false);
    await assert.rejects(() => transcribeLocalAudioChunk(input(), 'h'), { code: 'LOCAL_AUDIO_NOT_CONFIGURED' });
  });
});

test('local subprocess has bounded timeout/output and abort waits for process termination', async () => {
  await assert.rejects(() => runLocalAudioProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 40 }), { code: 'LOCAL_AUDIO_TIMEOUT' });
  const controller = new AbortController();
  const running = runLocalAudioProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 5000, signal: controller.signal });
  const checked = assert.rejects(running, { code: 'CANCELLED' });
  controller.abort(); await checked;
  await assert.rejects(() => runLocalAudioProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(600000));setInterval(()=>{},1000)'], { timeoutMs: 5000 }), { code: 'LOCAL_AUDIO_OUTPUT_LIMIT' });
  await assert.rejects(() => runLocalAudioProcess('/nonexistent/whisper-cli', [], { timeoutMs: 5000 }), { code: 'LOCAL_AUDIO_PROCESS_FAILED' });
});

function setup() {
  const store = new AudioUsageStore(':memory:'); let localCalls = 0, cloudCalls = 0; let mode: 'local' | 'cloud' = 'local';
  const service = new AudioWatchService({ store, mode: () => mode, enabled: () => true,
    limits: () => ({ sessionChunks: 2, dailyChunks: 2 }), glossary, probe: async () => ({ duration: 1 }),
    transcribe: async () => { cloudCalls++; throw Error('Cloud must not be reached'); },
    transcribeLocal: async chunk => { localCalls++; return [{ id: `cue-${chunk.start}`, start: chunk.start, end: chunk.end, text: 'Use the mask.' }]; },
    translate: async ({ targets }) => targets.map(cue => ({ ...cue, originalText: cue.text, text: '使用遮罩。' })),
  });
  return { service, store, localCalls: () => localCalls, cloudCalls: () => cloudCalls, setMode: (value: 'local' | 'cloud') => { mode = value; } };
}
test('local maxChunks=0 is unlimited past 40/100, with bounded memory and no cloud quota deductions', async () => {
  const h = setup();
  try {
    h.store.reserve(2); h.store.reserve(2); // Cloud daily budget is already exhausted.
    const s = h.service.start({ url, confirmAudio: true, maxChunks: 0 });
    assert.equal(s.unlimited, true); assert.equal(s.processingMode, 'local');
    assert.deepEqual(s.limits, { sessionChunks: null, dailyChunks: null, maxChunkSeconds: 15 });
    for (let i = 0; i < 130; i++) {
      const result = await h.service.chunk(input(s.audioSessionId, i));
      assert.equal(result.usage.sessionChunks, i + 1); assert.equal(result.usage.dailyChunks, i + 1);
    }
    assert.equal(h.localCalls(), 130); assert.equal(h.cloudCalls(), 0); assert.equal(h.store.used(), 2);
    const internal = h.service as unknown as { sessions: Map<string, { records: Map<string, unknown>; fingerprints: Map<string, unknown> }> };
    const state = internal.sessions.get(s.audioSessionId)!;
    assert(state.records.size <= 96); assert(state.fingerprints.size <= 96);
    assert.equal((await h.service.chunk(input(s.audioSessionId, 129))).cached, true);
    assert.equal(h.localCalls(), 130);
    h.service.stop(s.audioSessionId);
    await assert.rejects(() => h.service.chunk(input(s.audioSessionId, 130)), { code: 'AUDIO_SESSION_EXPIRED' });
  } finally { h.store.close(); }
});

test('local explicit segment limits/consent remain enforced; changing provider never silently uses cloud', async () => {
  const h = setup();
  try {
    assert.throws(() => h.service.start({ url, confirmAudio: false, maxChunks: 0 }), { code: 'AUDIO_CONSENT_REQUIRED' });
    const s = h.service.start({ url, confirmAudio: true, maxChunks: 2 });
    assert.equal(s.unlimited, false); assert.equal(s.limits.sessionChunks, 2);
    await h.service.chunk(input(s.audioSessionId, 0)); await h.service.chunk(input(s.audioSessionId, 1));
    await assert.rejects(() => h.service.chunk(input(s.audioSessionId, 2)), { code: 'AUDIO_SESSION_LIMIT' });
    const unlimited = h.service.start({ url, confirmAudio: true, maxChunks: 0 });
    h.setMode('cloud');
    await assert.rejects(() => h.service.chunk(input(unlimited.audioSessionId)), { code: 'AUDIO_PROVIDER_CHANGED' });
    assert.throws(() => h.service.start({ url, confirmAudio: true, maxChunks: 0 }), { code: 'AUDIO_INVALID_LIMIT' });
    assert.equal(h.cloudCalls(), 0); assert.equal(h.store.used(), 0);
  } finally { h.store.close(); }
});

test('local translation receives 90s while the whole audio pipeline remains bounded at 110s', async (context) => {
  const translationDeadlines: number[] = [], pipelineDeadlines: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  context.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    translationDeadlines.push(milliseconds); return new AbortController().signal;
  });
  context.mock.method(globalThis, 'setTimeout', ((callback: () => void, milliseconds: number) => {
    pipelineDeadlines.push(milliseconds); return originalSetTimeout(callback, milliseconds);
  }) as typeof setTimeout);
  const h = setup();
  try {
    const s = h.service.start({ url, confirmAudio: true, maxChunks: 0 });
    await h.service.chunk(input(s.audioSessionId));
    assert.deepEqual(translationDeadlines, [90_000]);
    assert.deepEqual(pipelineDeadlines, [110_000]);
    assert(!translationDeadlines.includes(45_000));
  } finally { h.store.close(); }
});
