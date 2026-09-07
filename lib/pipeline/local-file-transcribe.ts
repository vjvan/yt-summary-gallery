/** whisper.cpp for uploaded/local media. Segment timestamps only; no invented word timing. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { localWhisperConfigured, runLocalAudioProcess } from '../watch/audio-local-transcribe';
import type { TranscribeOptions, TranscribeResult } from './transcribe';
const execFileAsync = promisify(execFile);
export function parseLocalFileWhisper(value: unknown, offset = 0): TranscribeResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本機 Whisper 回傳格式錯誤。');
  const data = value as { transcription?: unknown; params?: { translate?: unknown } };
  if (!Array.isArray(data.transcription) || data.params?.translate === true) throw new Error('本機 Whisper 未提供原語言逐字稿。');
  const segments = data.transcription.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('本機 Whisper 字幕資料錯誤。');
    const cue = raw as { offsets?: { from?: unknown; to?: unknown }; text?: unknown };
    if (!Number.isFinite(cue.offsets?.from) || !Number.isFinite(cue.offsets?.to) || typeof cue.text !== 'string') throw new Error('本機 Whisper 未提供有效片段時間。');
    const start = Number(cue.offsets!.from) / 1000, end = Number(cue.offsets!.to) / 1000;
    if (start < 0 || end <= start) throw new Error('本機 Whisper 字幕時間軸無效。');
    return { start: start + offset, end: end + offset, text: cue.text.trim() };
  }).filter(cue => cue.text && !/^\[(?:BLANK_AUDIO|SILENCE|MUSIC|NO SPEECH)\]$/i.test(cue.text));
  return { text: segments.map(cue => cue.text).join(' '), segments, words: [] };
}
export async function transcribeLocalFile(audioPath: string, options: TranscribeOptions): Promise<TranscribeResult> {
  if (options.wordTimestamps) throw new Error('本機 Whisper 目前提供段落時間戳，不提供逐字剪輯時間；一般字幕/燒錄可用，口播自動剪接請另行選擇支援逐字時間的處理模式。沒有改送雲端。');
  if (!localWhisperConfigured()) throw new Error('尚未設定本機 Whisper 模型或執行檔，請完成本機設定後重試；沒有呼叫付費辨識。');
  const input = path.resolve(audioPath);
  if (!(await fs.stat(input)).isFile()) throw new Error('找不到要辨識的本機媒體檔案。');
  if (options.language && !/^[a-z]{2,3}$/.test(options.language)) throw new Error('本機辨識語言代碼無效。');
  await fs.mkdir(options.tmpDir, { recursive: true });
  const temp = await fs.mkdtemp(path.join(options.tmpDir, 'local-asr-'));
  try {
    await runLocalAudioProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', input,
      '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', '60', '-reset_timestamps', '1', path.join(temp, 'chunk-%04d.wav')], { timeoutMs: 600_000 });
    const files = (await fs.readdir(temp)).filter(file => /^chunk-\d+\.wav$/.test(file)).sort();
    if (!files.length) throw new Error('媒體沒有可辨識的音軌。');
    const result: TranscribeResult = { text: '', segments: [], words: [] }; let offset = 0;
    for (let i = 0; i < files.length; i++) {
      const wav = path.join(temp, files[i]), output = path.join(temp, `result-${i}`);
      const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', wav], { timeout: 15_000 });
      const duration = Number(stdout.trim()); if (!Number.isFinite(duration) || duration <= 0) throw new Error('無法確認音訊片段長度。');
      await runLocalAudioProcess(process.env.WATCH_LOCAL_WHISPER_BIN || '/opt/homebrew/bin/whisper-cli',
        ['-m', process.env.WATCH_LOCAL_WHISPER_MODEL!, '-f', wav, '-l', options.language || 'auto', '-oj', '-of', output, '-np', '-sns', '-t', '4', '-ng'], { timeoutMs: 180_000 });
      const raw = await fs.readFile(`${output}.json`, 'utf8');
      if (raw.length > 4 * 1024 * 1024) throw new Error('本機辨識結果過大。');
      const parsed = parseLocalFileWhisper(JSON.parse(raw), offset); result.segments.push(...parsed.segments);
      offset += duration;
    }
    result.text = result.segments.map(cue => cue.text).join(' ');
    if (!result.segments.length) throw new Error('本機 Whisper 未辨識出語音，請確認音軌後重試。');
    return result;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
