/** Explicit local fixture only. Never captures Discord, joins a channel, or sends a message. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveService } from '../lib/live/service';
import { draftLiveReply } from '../lib/live/reply';
import { DEFAULT_GLOSSARY } from '../lib/glossary-defaults';
import { watchProviderInfo, watchProviderStatus } from '../lib/watch/provider';
import { probeAudio } from '../lib/watch/audio-transcribe';
import { transcribeLocalAudioChunk } from '../lib/watch/audio-local-transcribe';
import { translateWatchWindow } from '../lib/watch/translator';

async function main() {
  assert(process.argv.includes('--run-local'), 'Requires explicit --run-local.');
  process.env.WATCH_PROCESSING_MODE = 'local';
  const realFetch = globalThis.fetch;
  let localRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, 'http://127.0.0.1:11434', 'External network forbidden in this fixture test.');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    localRequests++;
    return realFetch(input, init);
  };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'live-fixture-'));
  const service = new LiveService({ provider: watchProviderInfo, readiness: watchProviderStatus, probe: probeAudio,
    transcribe: transcribeLocalAudioChunk, translate: translateWatchWindow, reply: draftLiveReply, glossary: () => structuredClone(DEFAULT_GLOSSARY) });
  let sessionId = '';
  try {
    const file = path.join(directory, 'fixture.wav');
    const sample = process.env.WATCH_LOCAL_SMOKE_AUDIO || '/opt/homebrew/Cellar/whisper-cpp/1.9.2/share/whisper-cpp/jfk.wav';
    execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', sample, '-t', '8', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', file]);
    // A fabricated label only: LiveService must never fetch this URL.
    const session = await service.start({ url: 'https://discord.com/channels/123456789012345678/234567890123456789', title: 'PUBLIC JFK AUDIO FIXTURE — NOT A DISCORD CAPTURE', confirmAudio: true });
    sessionId = session.sessionId;
    const input = { sessionId, sequence: 0, start: 0, end: 8, bytes: new Uint8Array(readFileSync(file)) };
    const began = performance.now();
    const result = await service.chunk(input);
    assert.ok(result.cues.length > 0, 'Expected actual translated speech.');
    assert.ok(result.cues.every(cue => /[\u3400-\u9fff]/.test(cue.text)));
    console.log(JSON.stringify({ stage: 'live_local_whisper_and_translation', audioSeconds: 8,
      processingSeconds: +((performance.now() - began) / 1000).toFixed(2), cues: result.cues }, null, 2));
    const requestsBeforeReplay = localRequests;
    assert.equal((await service.chunk(input)).cached, true);
    assert.equal(localRequests, requestsBeforeReplay, 'Replay must not repeat inference.');
    const draftBegan = performance.now();
    const reply = await service.reply({ sessionId, text: '我想確認一下，這個遮罩要接到 Merge Alpha 節點，對嗎？', tone: 'natural' });
    assert.match(reply.english, /Merge Alpha/);
    console.log(JSON.stringify({ stage: 'live_local_english_reply_draft', processingSeconds: +((performance.now() - draftBegan) / 1000).toFixed(2),
      english: reply.english, localRequests, externalRequests: 0, replayWithoutInference: true, capturePerformed: false, messagesSent: 0 }, null, 2));
    assert.equal(service.stop(sessionId).status, 'stopped');
    await assert.rejects(service.chunk({ ...input, sequence: 1, start: 8, end: 16 }));
  } finally {
    if (sessionId) service.stop(sessionId);
    globalThis.fetch = realFetch;
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
