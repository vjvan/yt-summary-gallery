import { WatchError } from '../watch/errors';
import type { LiveChunkInput, LiveReplyInput, LiveStopInput, LiveStopReason, LiveTone } from './types';

export const LIVE_ID = /^[A-Za-z0-9_-]{8,80}$/;
export const LIVE_AUDIO_BYTES = 2 * 1024 * 1024;
const MAX_BODY_BYTES = LIVE_AUDIO_BYTES + 16 * 1024;
const MAX_SECONDS = Number.MAX_SAFE_INTEGER / 96000; // Numeric sample-clock safety, not a session duration quota.
export function canonicalDiscordUrl(input: string): string {
  let url: URL;
  try { if (typeof input !== 'string' || input.length > 2048) throw new Error(); url = new URL(input); }
  catch { throw new WatchError('LIVE_INVALID_URL', '請提供 Discord 網頁版頻道網址。'); }
  if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port || url.username || url.password || url.search || url.hash
    || !/^\/channels\/(?:@me|[1-9][0-9]{16,19})\/[1-9][0-9]{16,19}\/?$/.test(url.pathname)) {
    throw new WatchError('LIVE_INVALID_URL', '只接受 https://discord.com/channels/伺服器或@me/頻道 的網址，不接受其他網站或邀請連結。');
  }
  return `https://discord.com${url.pathname.replace(/\/$/, '')}`;
}
export function validateLiveId(id: string): void { if (typeof id !== 'string' || !LIVE_ID.test(id)) throw new WatchError('LIVE_INVALID_ID', '直播工作編號無效。'); }

/** Confirm a standalone PCM16 mono WAV and actual sample duration, not client timestamps alone. */
export function validateLiveChunk(input: LiveChunkInput): void {
  validateLiveId(input.sessionId);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || input.sequence > 1_000_000_000) throw new WatchError('LIVE_INVALID_SEQUENCE', '音訊片段序號必須為有效的非負整數。');
  if (![input.start, input.end].every(Number.isFinite) || input.start < 0 || input.end > MAX_SECONDS || input.end <= input.start
    || input.end - input.start < 0.2 || input.end - input.start > 15.001) throw new WatchError('LIVE_INVALID_TIME', '每段音訊須為 0.2 至 15 秒，使用擷取音訊的樣本時鐘，不是影片時間。');
  if (input.gapReason !== undefined && !['silence', 'overload', 'capture-gap'].includes(input.gapReason)) throw new WatchError('LIVE_INVALID_GAP', '音訊空白原因無效。');
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length < 44 || input.bytes.length > LIVE_AUDIO_BYTES) throw new WatchError('LIVE_TOO_LARGE', 'WAV 音訊不可空白或超過 2 MB。', 413);
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const invalid = () => new WatchError('LIVE_AUDIO_FORMAT', '只接受完整的單聲道 PCM16 WAV 音訊。', 415);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
  let sampleRate = 0, dataBytes = 0, fmtCount = 0, dataCount = 0, offset = 12;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString('ascii', offset, offset + 4); const size = bytes.readUInt32LE(offset + 4); const from = offset + 8;
    if (size > bytes.length - from) throw invalid();
    if (name === 'fmt ') {
      fmtCount++;
      if (size < 16 || bytes.readUInt16LE(from) !== 1 || bytes.readUInt16LE(from + 2) !== 1 || bytes.readUInt16LE(from + 14) !== 16 || bytes.readUInt16LE(from + 12) !== 2) throw invalid();
      sampleRate = bytes.readUInt32LE(from + 4);
      if (sampleRate < 8000 || sampleRate > 96000 || bytes.readUInt32LE(from + 8) !== sampleRate * 2) throw invalid();
    }
    if (name === 'data') { dataCount++; dataBytes = size; }
    offset = from + size + (size % 2);
  }
  if (offset !== bytes.length || fmtCount !== 1 || dataCount !== 1 || !dataBytes || dataBytes % 2) throw invalid();
  const duration = dataBytes / (sampleRate * 2);
  if (duration < 0.2 || duration > 15.001 || Math.abs(duration - (input.end - input.start)) > Math.max(0.002, 2 / sampleRate)) {
    throw new WatchError('LIVE_SAMPLE_CLOCK', 'WAV 樣本長度與音訊時鐘不一致；本次音訊未送交模型。', 422);
  }
}

let activeReaders = 0;
export async function readLiveMultipart(request: Request): Promise<LiveChunkInput> {
  if (activeReaders >= 2) throw new WatchError('LIVE_BUSY', '音訊上傳忙碌，請等待上一段完成。', 503);
  activeReaders++;
  try {
    const type = request.headers.get('content-type') || '';
    if (!/^multipart\/form-data;\s*boundary=/i.test(type) || type.length > 250) throw new WatchError('LIVE_CONTENT_TYPE', '音訊需以 multipart/form-data 傳送。', 415);
    if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new WatchError('LIVE_TOO_LARGE', '音訊請求過大。', 413);
    const reader = request.body?.getReader(); if (!reader) throw new WatchError('LIVE_INVALID_BODY', '缺少音訊內容。');
    const parts: Uint8Array[] = []; let size = 0; let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 10_000);
    const abort = () => { void reader.cancel().catch(() => {}); };
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        request.signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (timedOut) throw new WatchError('LIVE_UPLOAD_TIMEOUT', '音訊上傳逾時，未送交模型。', 408);
        request.signal.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new WatchError('LIVE_TOO_LARGE', '音訊請求過大。', 413); }
        parts.push(value);
      }
    } finally { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); reader.releaseLock(); }
    let form: FormData;
    try { form = await new Response(Buffer.concat(parts), { headers: { 'content-type': type } }).formData(); }
    catch { throw new WatchError('LIVE_INVALID_BODY', '音訊欄位格式無效。'); }
    const required = ['sessionId', 'sequence', 'start', 'end', 'audio']; const allowed = [...required, 'gapReason'];
    if (required.some(key => form.getAll(key).length !== 1) || form.getAll('gapReason').length > 1 || Array.from(form.keys()).some(key => !allowed.includes(key))) throw new WatchError('LIVE_INVALID_BODY', '音訊欄位缺少、重複或不受支援。');
    const field = (key: string): string => { const value = form.get(key); if (typeof value !== 'string' || value.length > 100) throw new WatchError('LIVE_INVALID_BODY', '音訊欄位格式無效。'); return value; };
    const sequence = field('sequence'), start = field('start'), end = field('end');
    if (!/^(?:0|[1-9][0-9]{0,9})$/.test(sequence) || !/^\d+(?:\.\d{1,6})?$/.test(start) || !/^\d+(?:\.\d{1,6})?$/.test(end)) throw new WatchError('LIVE_INVALID_TIME', '序號或音訊時鐘格式無效。');
    const file = form.get('audio');
    if (!file || typeof file === 'string' || !['audio/wav', 'audio/wave', 'audio/x-wav'].includes(file.type.toLowerCase()) || file.size > LIVE_AUDIO_BYTES) throw new WatchError('LIVE_AUDIO_FORMAT', '請上傳小於 2 MB 的 WAV 音訊。', 415);
    const input: LiveChunkInput = { sessionId: field('sessionId'), sequence: Number(sequence), start: Number(start), end: Number(end), bytes: new Uint8Array(await file.arrayBuffer()), ...(form.has('gapReason') ? { gapReason: field('gapReason') as LiveChunkInput['gapReason'] } : {}) };
    validateLiveChunk(input); return input;
  } finally { activeReaders--; }
}

export function validateReplyInput(input: LiveReplyInput): LiveTone {
  validateLiveId(input.sessionId);
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1200 || !/[\u3400-\u9fff]/.test(input.text)) throw new WatchError('LIVE_REPLY_INPUT', '請輸入 1 至 1200 字、包含中文的回覆內容。');
  if (input.tone !== undefined && !['natural', 'polite', 'concise'].includes(input.tone)) throw new WatchError('LIVE_REPLY_TONE', '回覆語氣須為自然、禮貌或精簡。');
  return input.tone || 'natural';
}
export function validateStopInput(input: LiveStopInput): void {
  const reasons: LiveStopReason[] = ['user', 'source-closed', 'queue-overflow', 'permission-revoked', 'capture-error', 'server-unavailable', 'mode-changed'];
  if (input.reason !== undefined && !reasons.includes(input.reason)) throw new WatchError('LIVE_INVALID_STOP', '停止原因無效。');
  if (input.unprocessedSeconds !== undefined && (!Number.isFinite(input.unprocessedSeconds) || input.unprocessedSeconds < 0 || input.unprocessedSeconds > MAX_SECONDS)) throw new WatchError('LIVE_INVALID_STOP', '未處理音訊長度無效。');
}
