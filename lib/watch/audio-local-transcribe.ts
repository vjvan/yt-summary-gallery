import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WatchError } from './errors';
import { parseWhisperSegments } from './audio-transcribe';
import { validateAudioChunk } from './audio-upload';
import type { AudioChunkInput } from './audio-types';
import type { WatchCue } from './types';

interface LocalWhisperConfiguration { model: string; whisperBin: string }
function configuration(): LocalWhisperConfiguration {
  const model = process.env.WATCH_LOCAL_WHISPER_MODEL || '';
  const whisperBin = process.env.WATCH_LOCAL_WHISPER_BIN || '/opt/homebrew/bin/whisper-cli';
  try {
    if (!path.isAbsolute(model) || !path.isAbsolute(whisperBin) || !statSync(model).isFile() || !statSync(whisperBin).isFile()) throw Error('invalid local file');
    accessSync(model, constants.R_OK); accessSync(whisperBin, constants.X_OK);
  } catch {
    throw new WatchError('LOCAL_AUDIO_NOT_CONFIGURED', '尚未設定可用的本機 Whisper 模型或執行檔；不會改用雲端辨識。', 503);
  }
  return { model, whisperBin };
}

/** Configuration only, not an inference or a network health check. */
export function localWhisperConfigured(): boolean {
  try { configuration(); return true; } catch { return false; }
}

interface ProcessOptions { input?: Uint8Array; signal?: AbortSignal; timeoutMs: number; cwd?: string }
/** Spawn without a shell. Wait for process exit after cancellation before removing temp files. */
export async function runLocalAudioProcess(executable: string, args: string[], options: ProcessOptions): Promise<void> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
      // Local ASR does not need cloud credentials in its child environment.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: process.env.NODE_ENV || 'development' },
    });
    let settled = false; let failure: Error | undefined; let outputBytes = 0;
    const finish = (error?: Error) => {
      if (settled) return; settled = true;
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const kill = (error: Error) => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => kill(new WatchError('CANCELLED', '本機音訊工作已取消，沒有雲端 API 費用。', 409));
    const timeout = setTimeout(() => kill(new WatchError('LOCAL_AUDIO_TIMEOUT', '本機音訊處理逾時；請換較小模型或稍後重試，不會改送雲端。', 504)), options.timeoutMs);
    child.once('error', () => finish(new WatchError('LOCAL_AUDIO_PROCESS_FAILED', '無法啟動本機音訊工具；請檢查 Whisper 與 FFmpeg 安裝。', 503)));
    const drain = (buffer: Buffer) => {
      outputBytes += buffer.length;
      if (outputBytes > 512 * 1024) kill(new WatchError('LOCAL_AUDIO_OUTPUT_LIMIT', '本機音訊工具輸出超過安全上限。', 502));
    };
    child.stdout.on('data', drain); child.stderr.on('data', drain);
    child.stdin.on('error', () => undefined);
    child.once('close', (code) => finish(failure || (code === 0 ? undefined : new WatchError('LOCAL_AUDIO_PROCESS_FAILED', '本機音訊工具未能完成處理；不會改用雲端。', 502))));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    else child.stdin.end(options.input);
  });
}

/** whisper.cpp -oj: result.language and transcription[].offsets are milliseconds. */
export function parseLocalWhisperSegments(data: unknown, input: Pick<AudioChunkInput, 'start' | 'end'>, fingerprint: string): WatchCue[] {
  if (!data || typeof data !== 'object') throw new WatchError('LOCAL_AUDIO_FORMAT', '本機 Whisper 未回傳有效 JSON。', 502);
  const value = data as { result?: { language?: unknown }; transcription?: unknown; model?: { multilingual?: unknown }; params?: { translate?: unknown } };
  if (value.model?.multilingual === false) throw new WatchError('LOCAL_AUDIO_MODEL_LANGUAGE', '請使用可自動偵測語言的多語 Whisper 模型，而非 .en 專用模型。', 503);
  if (value.params?.translate === true || !Array.isArray(value.transcription) || value.transcription.length > 200) throw new WatchError('LOCAL_AUDIO_FORMAT', '本機 Whisper 沒有提供有效原文與時間戳。', 502);
  const segments = value.transcription.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new WatchError('LOCAL_AUDIO_FORMAT', '本機 Whisper 字幕片段無效。', 502);
    const segment = raw as { offsets?: { from?: unknown; to?: unknown }; text?: unknown };
    if (typeof segment.offsets?.from !== 'number' || typeof segment.offsets?.to !== 'number' || typeof segment.text !== 'string') throw new WatchError('LOCAL_AUDIO_FORMAT', '本機 Whisper 字幕缺少數值時間戳。', 502);
    return { start: segment.offsets.from / 1000, end: segment.offsets.to / 1000,
      text: /^\s*\[(?:BLANK_AUDIO|SILENCE|MUSIC|NO SPEECH)\]\s*$/i.test(segment.text) ? '' : segment.text };
  });
  return parseWhisperSegments({ language: value.result?.language, segments }, input, fingerprint);
}

interface LocalTranscribeOptions { run?: typeof runLocalAudioProcess; tempRoot?: string }
export async function transcribeLocalAudioChunk(input: AudioChunkInput, fingerprint: string, signal?: AbortSignal, options: LocalTranscribeOptions = {}): Promise<WatchCue[]> {
  validateAudioChunk(input);
  signal?.throwIfAborted();
  const { model, whisperBin } = configuration();
  const run = options.run || runLocalAudioProcess;
  const directory = await mkdtemp(path.join(options.tempRoot || os.tmpdir(), 'yt-watch-local-audio-'));
  try {
    await chmod(directory, 0o700);
    const wav = path.join(directory, 'audio.wav');
    const output = path.join(directory, 'transcript');
    // Input is stdin with only the pipe protocol; no media-supplied URL/file may be opened.
    // Force the allowed container, convert to mono PCM and bound the output size/duration.
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'pipe',
      '-f', input.mime === 'audio/webm' ? 'matroska' : 'wav', '-i', 'pipe:0', '-map', '0:a:0', '-vn',
      '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-t', '15.1', '-fs', '600000', '-f', 'wav', wav],
    { input: input.bytes, signal, timeoutMs: 8_000, cwd: directory });
    signal?.throwIfAborted();
    await chmod(wav, 0o600);
    await run(whisperBin, ['-m', model, '-f', wav, '-l', 'auto', '-oj', '-of', output, '-np', '-sns', '-t', '4'],
      { signal, timeoutMs: 60_000, cwd: directory });
    signal?.throwIfAborted();
    const json = `${output}.json`;
    if ((await stat(json)).size > 256 * 1024) throw new WatchError('LOCAL_AUDIO_OUTPUT_LIMIT', '本機 Whisper 字幕輸出超過安全上限。', 502);
    await chmod(json, 0o600);
    let result: unknown;
    try { result = JSON.parse(await readFile(json, 'utf8')); }
    catch { throw new WatchError('LOCAL_AUDIO_FORMAT', '本機 Whisper 回傳 JSON 無效。', 502); }
    return parseLocalWhisperSegments(result, input, fingerprint);
  } catch (error) {
    if (signal?.aborted) throw new WatchError('CANCELLED', '本機音訊工作已取消，沒有雲端 API 費用。', 409);
    if (error instanceof WatchError) throw error;
    throw new WatchError('LOCAL_AUDIO_FAILED', '本機音訊辨識未完成；不會改用雲端。', 502);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
