import { execFile } from 'node:child_process';
import { WatchError } from './errors';
import { createHash } from 'node:crypto';
import { parseJson3Captions, parseVttCaptions } from './cues';
import type { WatchSource } from './types';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PAGE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
const TIMEDTEXT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const MAX_SUBTITLE_BYTES = 4 * 1024 * 1024;

export function canonicalYouTubeUrl(input: string): { videoId: string; url: string } {
  if (typeof input !== 'string' || input.length > 2048 || input !== input.trim() || /[\u0000-\u0020\u007f]/.test(input)) throw new WatchError('INVALID_URL', '請提供有效的 YouTube 影片網址。');
  let url: URL;
  try { url = new URL(input); } catch { throw new WatchError('INVALID_URL', '請提供完整的 YouTube 影片網址。'); }
  if (!['https:', 'http:'].includes(url.protocol) || !PAGE_HOSTS.has(url.hostname)
    || url.username || url.password || url.port) throw new WatchError('INVALID_URL', '只接受沒有帳密或自訂連接埠的 YouTube 影片網址。');
  let videoId: string | null = null;
  if (url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') {
    const match = url.pathname.match(/^\/([A-Za-z0-9_-]{11})\/?$/);
    videoId = match?.[1] || null;
  } else if (url.pathname === '/watch') {
    if (url.searchParams.getAll('v').length === 1) videoId = url.searchParams.get('v');
  } else {
    const match = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})\/?$/);
    videoId = match?.[1] || null;
  }
  if (!videoId || !VIDEO_ID.test(videoId)) throw new WatchError('INVALID_URL', '找不到有效的 YouTube 影片 ID；請勿使用播放清單或頻道網址。');
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

export interface SubtitleTrack { url: string; ext: 'json3' | 'vtt'; language: string; sourceKind: 'manual' | 'automatic' }
interface Metadata {
  id?: unknown; title?: unknown; duration?: unknown; language?: unknown;
  is_live?: unknown; live_status?: unknown;
  subtitles?: unknown; automatic_captions?: unknown;
}

function primaryLanguage(value: string): string { return value.toLowerCase().split('-')[0]; }

/** Reject translated timedtext and non-YouTube endpoints before any server-side fetch. */
export function validatedCaptionUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new WatchError('INVALID_CAPTION_URL', '字幕來源網址無效。'); }
  if (url.protocol !== 'https:' || !TIMEDTEXT_HOSTS.has(url.hostname) || url.port
    || url.username || url.password || url.pathname !== '/api/timedtext'
    || url.searchParams.has('tlang')) throw new WatchError('INVALID_CAPTION_URL', '字幕來源不是可接受的原文 YouTube 字幕。');
  return url;
}

export function chooseSubtitleTrack(metadata: Metadata, language = 'en'): SubtitleTrack {
  if (!/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(language)) throw new WatchError('INVALID_LANGUAGE', '字幕語言代碼無效。');
  if (metadata.is_live === true || ['is_live', 'is_upcoming', 'post_live'].includes(String(metadata.live_status))) {
    throw new WatchError('LIVE_UNSUPPORTED', '第一版僅支援已上架影片；直播或尚未處理完成的直播回放暫不支援。');
  }
  if (typeof metadata.language === 'string' && metadata.language
    && primaryLanguage(metadata.language) !== primaryLanguage(language)) {
    throw new WatchError('ENGLISH_ONLY', `這支影片的原語言是 ${metadata.language}，不是所選的 ${language}；不會使用機器翻譯字幕充當原文。`);
  }
  for (const [kind, tracks] of [['manual', metadata.subtitles], ['automatic', metadata.automatic_captions]] as const) {
    if (!tracks || typeof tracks !== 'object' || Array.isArray(tracks)) continue;
    const entries = Object.entries(tracks).filter(([key]) => primaryLanguage(key) === primaryLanguage(language));
    entries.sort(([a], [b]) => {
      const rank = (key: string) => kind === 'automatic'
        ? (key === `${language}-orig` ? 0 : key === language ? 1 : 2)
        : (key === language ? 0 : key === `${language}-orig` ? 1 : 2);
      return rank(a) - rank(b) || a.localeCompare(b);
    });
    for (const [trackLanguage, formats] of entries) {
      if (!Array.isArray(formats)) continue;
      for (const ext of ['json3', 'vtt'] as const) {
        for (const entry of formats) {
          if (!entry || typeof entry !== 'object') continue;
          const track = entry as { ext?: unknown; url?: unknown; name?: unknown };
          if (track.ext !== ext || typeof track.url !== 'string') continue;
          if (typeof track.name === 'string' && /translated|翻譯|翻译/i.test(track.name)) continue;
          let url: URL;
          try { url = validatedCaptionUrl(track.url); } catch { continue; }
          const originalLanguage = url.searchParams.get('lang');
          if (!originalLanguage || primaryLanguage(originalLanguage) !== primaryLanguage(language)) continue;
          // The automatic dictionary includes translations; only ASR/original tracks qualify.
          if (kind === 'automatic' && url.searchParams.get('kind') !== 'asr' && !trackLanguage.endsWith('-orig')) continue;
          return { url: url.toString(), ext, language: originalLanguage, sourceKind: kind };
        }
      }
    }
  }
  throw new WatchError('NO_CAPTIONS', `找不到可用的 ${language} 原文字幕。第一版不會下載音訊或自動付費轉錄；請改選有原文字幕的影片。`);
}

async function metadataFor(url: string, signal?: AbortSignal): Promise<Metadata> {
  const raw = await new Promise<string>((resolve, reject) => {
    execFile('yt-dlp', [
      '--ignore-config', '--no-plugin-dirs', '--no-playlist', '--skip-download', '--dump-single-json',
      '--no-warnings', '--no-cache-dir', '--socket-timeout', '15', '--retries', '1', '--extractor-retries', '1', '--', url,
    ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 12 * 1024 * 1024, signal }, (error, stdout) => {
      if (error) {
        if (signal?.aborted) reject(signal.reason || new WatchError('CANCELLED', '已取消字幕取得。'));
        else if ('code' in error && error.code === 'ENOENT') reject(new WatchError('YTDLP_UNAVAILABLE', '本機尚未安裝 yt-dlp，無法取得原文字幕。'));
        else reject(new WatchError('CAPTION_FETCH_FAILED', '無法取得 YouTube 字幕資訊，可能需要登入、受到流量限制或 yt-dlp 需要更新。沒有下載音訊，也沒有開始付費翻譯。'));
        return;
      }
      resolve(stdout);
    });
  });
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new WatchError('INVALID_METADATA', 'YouTube 影片資訊格式無效。'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new WatchError('INVALID_METADATA', 'YouTube 影片資訊格式無效。');
  return parsed as Metadata;
}

async function boundedCaptionFetch(url: string, signal?: AbortSignal): Promise<string> {
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000);
  const response = await fetch(validatedCaptionUrl(url), { signal: combined, redirect: 'error', cache: 'no-store' });
  if (!response.ok || !response.body) throw new WatchError('CAPTION_FETCH_FAILED', `無法下載原文字幕（HTTP ${response.status}）；尚未開始付費翻譯。`);
  if (Number(response.headers.get('content-length')) > MAX_SUBTITLE_BYTES) {
    await response.body.cancel();
    throw new WatchError('CAPTION_LIMIT', '字幕檔超過第一版 4 MB 上限。');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SUBTITLE_BYTES) throw new WatchError('CAPTION_LIMIT', '字幕檔超過第一版 4 MB 上限。');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function fetchWatchSource(input: string, language = 'en', signal?: AbortSignal): Promise<WatchSource> {
  const canonical = canonicalYouTubeUrl(input);
  try {
    signal?.throwIfAborted();
    const metadata = await metadataFor(canonical.url, signal);
    if (metadata.id !== canonical.videoId) throw new WatchError('INVALID_METADATA', '影片資訊與要求的影片不符。');
    if (typeof metadata.duration === 'number' && metadata.duration > 6 * 3600) throw new WatchError('CAPTION_LIMIT', '第一版僅支援 6 小時以內的影片。');
    const track = chooseSubtitleTrack(metadata, language);
    const raw = await boundedCaptionFetch(track.url, signal);
    const cues = track.ext === 'json3' ? parseJson3Captions(raw) : parseVttCaptions(raw);
    if (!cues.length) throw new WatchError('NO_CAPTIONS', '原文字幕沒有可用的時間軸片段，尚未開始付費翻譯。');
    if (cues.length > 25_000 || cues.some((cue) => cue.end > 6 * 3600 || cue.text.length > 4000)) {
      throw new WatchError('CAPTION_LIMIT', '字幕內容超過第一版的時間或大小上限。');
    }
    // Signed caption URLs expire; the content hash is stable across those URL changes.
    const trackId = createHash('sha256').update(JSON.stringify([canonical.videoId, track.language, track.sourceKind, cues])).digest('hex').slice(0, 24);
    return {
      videoId: canonical.videoId,
      title: typeof metadata.title === 'string' ? metadata.title.slice(0, 300) : canonical.videoId,
      language: track.language, sourceKind: track.sourceKind, trackId, cues,
    };
  } catch (error) {
    if (error instanceof WatchError) throw error;
    if (signal?.aborted) throw new WatchError('CANCELLED', '已取消字幕取得。', 499);
    throw new WatchError('CAPTION_FETCH_FAILED', '原文字幕取得失敗或逾時，請稍後重試；尚未開始付費翻譯。', 502);
  }
}
