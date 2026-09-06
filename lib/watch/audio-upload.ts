import { WatchError } from './errors';
import type { AudioChunkInput } from './audio-types';
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const MAX_AUDIO_BODY_BYTES = MAX_AUDIO_BYTES + 16 * 1024;
export const AUDIO_ID = /^[A-Za-z0-9_-]{8,80}$/;

export function validateAudioChunk(input: AudioChunkInput) {
  if (!AUDIO_ID.test(input.audioSessionId) || !AUDIO_ID.test(input.chunkId)) throw new WatchError('AUDIO_INVALID_ID', '音訊工作或片段編號無效。');
  if (input.confirmAudio !== true) throw new WatchError('AUDIO_CONSENT_REQUIRED', '請先同意將分頁音訊送交辨識與翻譯模型。', 403);
  if (!Number.isFinite(input.start) || !Number.isFinite(input.end) || input.start < 0 || input.end <= input.start
    || input.end > 6 * 3600 || input.end - input.start > 15.001 || input.end - input.start < 0.2) {
    throw new WatchError('AUDIO_INVALID_TIME', '音訊片段須為 0.2 至 15 秒，並使用有效的影片時間。');
  }
  if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > MAX_AUDIO_BYTES) throw new WatchError('AUDIO_TOO_LARGE', '單段音訊不可空白或超過 2 MB。', 413);
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const wav = bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  const webm = bytes.length >= 8 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if ((input.mime === 'audio/wav' && !wav) || (input.mime === 'audio/webm' && !webm) || !['audio/wav', 'audio/webm'].includes(input.mime)) {
    throw new WatchError('AUDIO_FORMAT', '只接受獨立、完整的 WAV 或 WebM 音訊片段。', 415);
  }
}

/** Read the complete multipart envelope under a byte cap before invoking the parser. */
export async function readAudioMultipart(request: Request): Promise<AudioChunkInput> {
  const type = request.headers.get('content-type') || '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(type) || type.length > 250) throw new WatchError('AUDIO_CONTENT_TYPE', '請使用 multipart/form-data 傳送音訊。', 415);
  if (Number(request.headers.get('content-length')) > MAX_AUDIO_BODY_BYTES) throw new WatchError('AUDIO_TOO_LARGE', '音訊請求超過大小限制。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new WatchError('AUDIO_INVALID_BODY', '缺少音訊請求內容。');
  const buffers: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 10_000);
  try {
    while (true) {
      request.signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (timedOut) throw new WatchError('AUDIO_UPLOAD_TIMEOUT', '音訊上傳逾時，尚未送交模型。', 408);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_AUDIO_BODY_BYTES) { await reader.cancel(); throw new WatchError('AUDIO_TOO_LARGE', '音訊請求超過大小限制。', 413); }
      buffers.push(value);
    }
  } finally { clearTimeout(timeout); reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(buffers), { headers: { 'content-type': type } }).formData(); }
  catch { throw new WatchError('AUDIO_INVALID_BODY', '音訊 multipart 格式不正確。'); }
  const keys = ['audioSessionId', 'chunkId', 'start', 'end', 'confirmAudio', 'file'];
  const actual = Array.from(form.keys());
  if (actual.length !== keys.length || keys.some(key => form.getAll(key).length !== 1) || actual.some(key => !keys.includes(key))) throw new WatchError('AUDIO_INVALID_BODY', '音訊欄位缺少、重複或不受支援。');
  const field = (name: string) => {
    const value = form.get(name);
    if (typeof value !== 'string' || value.length > 100) throw new WatchError('AUDIO_INVALID_BODY', '音訊欄位格式不正確。');
    return value;
  };
  const file = form.get('file');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function' || file.size > MAX_AUDIO_BYTES) throw new WatchError('AUDIO_TOO_LARGE', '單段音訊不可超過 2 MB。', 413);
  const mime = file.type.toLowerCase().split(';')[0];
  if (!['audio/webm', 'audio/wav', 'audio/x-wav', 'audio/wave'].includes(mime)) throw new WatchError('AUDIO_FORMAT', '只接受 WAV 或 WebM 音訊。', 415);
  const start = field('start'), end = field('end');
  if (!/^\d+(?:\.\d{1,6})?$/.test(start) || !/^\d+(?:\.\d{1,6})?$/.test(end)) throw new WatchError('AUDIO_INVALID_TIME', '音訊時間格式不正確。');
  const input: AudioChunkInput = {
    audioSessionId: field('audioSessionId'), chunkId: field('chunkId'), start: Number(start), end: Number(end),
    confirmAudio: field('confirmAudio') === 'true', bytes: new Uint8Array(await file.arrayBuffer()), mime: mime === 'audio/webm' ? 'audio/webm' : 'audio/wav',
  };
  validateAudioChunk(input);
  return input;
}
