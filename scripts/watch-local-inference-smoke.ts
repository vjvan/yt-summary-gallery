// Explicit opt-in smoke: only public/local fixture audio and loopback inference.
// Does not capture a browser tab or use any cloud API/key/database.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { translateWatchWindow } from '../lib/watch/translator';
import { transcribeLocalAudioChunk } from '../lib/watch/audio-local-transcribe';
import { watchProviderInfo } from '../lib/watch/provider';
import type { WatchCue, WatchSource } from '../lib/watch/types';

async function main() {
  assert(process.argv.includes('--run-local'), 'This script requires explicit --run-local.');
  process.env.WATCH_PROCESSING_MODE = 'local';
  assert.equal(watchProviderInfo().processingMode, 'local');
  const realFetch = globalThis.fetch;
  let localRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.origin, 'http://127.0.0.1:11434', 'External network forbidden in local smoke.');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    localRequests++;
    return realFetch(input, init);
  };
  const glossary = { no_translate_terms: ['Figma', 'Weave', 'Compositor', 'Merge Alpha', 'Matte Grow / Shrink', 'MCP'],
    term_map: [['node', '節點'], ['mask', '遮罩'], ['layer', '圖層']] as [string, string][],
    style_rules: ['使用自然的台灣繁體中文，不自行補充資訊。'] };
  const sentences = [
    'Keep the person and replace only the background.',
    'Connect the mask to the Merge Alpha node.',
    'Place the studio image in the background layer.',
    'Then put the cutout person on the layer above it.',
    'Use Matte Grow / Shrink to refine the edges.',
    'We can run this workflow from an AI agent with MCP.',
    'The timeline keeps the captions synchronized with the video.',
    'Pause the video while the first translation is being prepared.',
  ];
  const targets: WatchCue[] = sentences.map((text, index) => ({ id: `fixture-${index}`, start: index * 4, end: index * 4 + 4, text }));
  const source: WatchSource = { videoId: 'localfixture', title: 'Local Figma Weave studio subtitle test', language: 'en', sourceKind: 'manual', trackId: 'local-fixture', cues: targets };
  try {
    const start = performance.now();
    const translated = await translateWatchWindow({ source, targets, before: [], after: [], glossary });
    assert.equal(translated.length, 8);
    console.log(JSON.stringify({ stage: 'local_translation_8_cues', seconds: +((performance.now() - start) / 1000).toFixed(2), model: watchProviderInfo().translationModel, cues: translated }, null, 2));
    const sample = process.env.WATCH_LOCAL_SMOKE_AUDIO || '/opt/homebrew/Cellar/whisper-cpp/1.9.2/share/whisper-cpp/jfk.wav';
    const wav = execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-i', sample, '-t', '10.9', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'], { maxBuffer: 2 * 1024 * 1024 });
    const asrStart = performance.now();
    const original = await transcribeLocalAudioChunk({ audioSessionId: 'local-smoke', chunkId: 'local-smoke', start: 0, end: 10.9,
      confirmAudio: true, bytes: wav, mime: 'audio/wav' }, 'local-smoke');
    assert.ok(original.length > 0);
    console.log(JSON.stringify({ stage: 'local_whisper_10_9_seconds', seconds: +((performance.now() - asrStart) / 1000).toFixed(2), original }, null, 2));
    const translationStart = performance.now();
    const speechTranslated = await translateWatchWindow({ source: { ...source, title: 'Public domain JFK inaugural speech', cues: original }, targets: original, before: [], after: [], glossary });
    console.log(JSON.stringify({ stage: 'local_asr_translation', seconds: +((performance.now() - translationStart) / 1000).toFixed(2), cues: speechTranslated, localRequests, externalRequests: 0 }, null, 2));
  } finally { globalThis.fetch = realFetch; }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
