import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { WatchError } from './errors';
import { normalizeCaptionSegments } from './cues';
import type { WatchCue } from './types';
import type { AudioChunkInput } from './audio-types';

export interface AudioProbe { duration: number }
/** Probe a bounded upload through stdin only; no raw audio files are created. */
export async function probeAudio(input: AudioChunkInput, signal?: AbortSignal): Promise<AudioProbe> {
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn('ffprobe', ['-v', 'error', '-protocol_whitelist', 'pipe', '-show_entries', 'stream=codec_type,duration:format=duration:packet=pts_time,duration_time', '-show_packets', '-of', 'json', '-i', 'pipe:0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = []; let size = 0, settled = false;
    const finish = (error?: Error, text?: string) => {
      if (settled) return; settled = true; clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(text || '');
    };
    const abort = () => finish(new WatchError('CANCELLED', '音訊工作已取消。', 409));
    const timeout = setTimeout(() => finish(new WatchError('AUDIO_PROBE_FAILED', '無法在時限內驗證音訊，尚未送交模型。', 422)), 8_000);
    child.on('error', () => finish(new WatchError('AUDIO_PROBE_FAILED', '無法啟動 ffprobe 驗證音訊，請確認本機已安裝 FFmpeg。', 503)));
    child.stdout.on('data', (buffer: Buffer) => { size += buffer.length; if (size > 512 * 1024) finish(new WatchError('AUDIO_PROBE_FAILED', '音訊結構超過驗證上限。', 422)); else output.push(buffer); });
    child.stderr.resume(); // Never surface provider/media stderr or filenames to the caller.
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => { if (code === 0) finish(undefined, Buffer.concat(output).toString('utf8')); else finish(new WatchError('AUDIO_PROBE_FAILED', '無法解碼音訊；每段須為獨立完整的 WAV 或 WebM 檔。', 422)); });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else child.stdin.end(input.bytes);
  });
  let data: { streams?: { codec_type?: unknown; duration?: unknown }[]; format?: { duration?: unknown }; packets?: { pts_time?: unknown; duration_time?: unknown }[] };
  try { data = JSON.parse(raw); } catch { throw new WatchError('AUDIO_PROBE_FAILED', '音訊時間資訊無效。', 422); }
  if (data.streams?.length !== 1 || data.streams.some(stream => stream.codec_type !== 'audio')) throw new WatchError('AUDIO_FORMAT', '只接受音訊，不接受包含影像的檔案。', 415);
  const durations = [Number(data.format?.duration), ...data.streams.map(stream => Number(stream.duration))].filter(n => Number.isFinite(n) && n > 0);
  const packets = (data.packets || []).map(packet => ({ start: Number(packet.pts_time), duration: Number(packet.duration_time) })).filter(packet => Number.isFinite(packet.start) && Number.isFinite(packet.duration) && packet.duration > 0);
  if (packets.length) durations.push(Math.max(...packets.map(packet => packet.start + packet.duration)) - Math.min(...packets.map(packet => packet.start)));
  const duration = Math.max(0, ...durations);
  if (!Number.isFinite(duration) || duration < 0.2 || duration > 15.2) throw new WatchError('AUDIO_DURATION', '音訊實際長度須為 0.2 至 15 秒。', 422);
  if (Math.abs(duration - (input.end - input.start)) > Math.max(0.5, duration * 0.08)) throw new WatchError('AUDIO_PLAYBACK_RATE', '音訊長度與影片時間不一致；此版只支援 1 倍速、不中斷的片段。', 422);
  return { duration };
}

export function parseWhisperSegments(data: unknown, input: Pick<AudioChunkInput, 'start' | 'end'>, fingerprint: string): WatchCue[] {
  if (!data || typeof data !== 'object') throw new WatchError('AUDIO_TRANSCRIPTION_FAILED', '辨識回傳格式不正確。', 502);
  const result = data as { language?: unknown; segments?: unknown; duration?: unknown };
  if (!Array.isArray(result.segments) || result.segments.length > 200) throw new WatchError('AUDIO_TRANSCRIPTION_FAILED', '辨識沒有提供可驗證的字幕時間。', 502);
  if (!result.segments.length) return [];
  const duration = input.end - input.start;
  const segments: { start: number; end: number; text: string }[] = [];
  for (const raw of result.segments) {
    if (!raw || typeof raw !== 'object') throw new WatchError('AUDIO_TRANSCRIPTION_FAILED', '辨識片段格式不正確。', 502);
    const segment = raw as { start?: unknown; end?: unknown; text?: unknown; no_speech_prob?: unknown };
    if (typeof segment.start !== 'number' || typeof segment.end !== 'number' || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
      || segment.start < 0 || segment.end <= segment.start || segment.end > duration + 0.2 || typeof segment.text !== 'string' || segment.text.length > 4000
      || (segment.no_speech_prob !== undefined && (typeof segment.no_speech_prob !== 'number' || !Number.isFinite(segment.no_speech_prob) || segment.no_speech_prob < 0 || segment.no_speech_prob > 1))) {
      throw new WatchError('AUDIO_TRANSCRIPTION_FAILED', '辨識片段時間或內容超出本段音訊範圍。', 502);
    }
    if (typeof segment.no_speech_prob === 'number' && segment.no_speech_prob >= 0.6) continue;
    if (!segment.text.trim()) continue;
    segments.push({ start: input.start + segment.start, end: Math.min(input.end, input.start + segment.end), text: segment.text.trim() });
  }
  if (segments.length && (typeof result.language !== 'string' || !['en', 'english'].includes(result.language.toLowerCase()))) throw new WatchError('AUDIO_ENGLISH_ONLY', '辨識到的原語言不是英文；目前音訊版只支援英文。', 422);
  let cues = normalizeCaptionSegments(segments);
  if (cues.length > 8) {
    const groupSize = Math.ceil(cues.length / 8);
    const groups = [];
    for (let index = 0; index < cues.length; index += groupSize) {
      const group = cues.slice(index, index + groupSize);
      groups.push({ start: group[0].start, end: group[group.length - 1].end, text: group.map(cue => cue.text).join(' ') });
    }
    cues = normalizeCaptionSegments(groups);
  }
  if (cues.some(cue => cue.text.length > 4000)) throw new WatchError('AUDIO_TRANSCRIPTION_FAILED', '音訊辨識文字異常過長。', 502);
  return cues.map(cue => ({ ...cue, id: `audio_${createHash('sha256').update(`${fingerprint}:${cue.id}`).digest('hex').slice(0, 20)}` }));
}

export async function transcribeAudioChunk(input: AudioChunkInput, fingerprint: string, signal?: AbortSignal): Promise<WatchCue[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new WatchError('MODEL_NOT_CONFIGURED', '伺服器尚未設定音訊辨識與翻譯金鑰。', 503);
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000);
  const form = new FormData();
  form.set('file', new Blob([Uint8Array.from(input.bytes)], { type: input.mime }), input.mime === 'audio/webm' ? 'chunk.webm' : 'chunk.wav');
  form.set('model', 'whisper-1'); form.set('response_format', 'verbose_json'); form.set('temperature', '0');
  // Do not force language=en: detect and reject non-English instead of silently mistranscribing it.
  try {
    abort.throwIfAborted();
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: abort, redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new WatchError('AUDIO_TRANSCRIPTION_FAILED', `音訊辨識服務暫時失敗（HTTP ${response.status}）；本段仍保守計入使用量。`, 502);
    const text = await response.text();
    if (text.length > 256 * 1024) throw new WatchError('AUDIO_TRANSCRIPTION_FAILED', '辨識回傳內容超過上限。', 502);
    let result: unknown; try { result = JSON.parse(text); } catch { throw new WatchError('AUDIO_TRANSCRIPTION_FAILED', '辨識回傳內容格式錯誤。', 502); }
    return parseWhisperSegments(result, input, fingerprint);
  } catch (error) {
    if (error instanceof WatchError) throw error;
    if (signal?.aborted) throw new WatchError('CANCELLED', '音訊工作已取消；已送出的請求仍可能計費。', 409);
    throw new WatchError('AUDIO_TRANSCRIPTION_FAILED', '音訊辨識連線失敗或逾時；本段仍保守計入使用量。', 502);
  }
}
