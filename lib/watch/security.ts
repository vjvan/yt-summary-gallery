import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WatchError } from './errors';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
function originFor(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get('host') || url.host;
  let hostUrl: URL;
  // Next production normalizes request.url to localhost even when the browser
  // reached 127.0.0.1. Both must be loopback and on the same port, but the browser
  // origin must come from the strictly validated Host, not Next's internal alias.
  if (!['http:', 'https:'].includes(url.protocol) || !/^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i.test(host)) {
    throw new WatchError('LOCAL_ONLY', '此功能只允許本機存取。', 403);
  }
  try { hostUrl = new URL(`${url.protocol}//${host}`); } catch { throw new WatchError('LOCAL_ONLY', '此功能只允許本機存取。', 403); }
  if (!LOOPBACK.has(url.hostname) || !LOOPBACK.has(hostUrl.hostname) || hostUrl.port !== url.port) {
    throw new WatchError('LOCAL_ONLY', '此功能只允許本機存取。', 403);
  }
  return hostUrl.origin;
}

export function pairingToken(root = process.cwd()): string {
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.watch-pairing-token');
  try {
    fs.writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new WatchError('PAIRING_INVALID', '本機配對資料無效，請重新設定。', 500);
  return value;
}

export function assertPairingRequest(request: Request) {
  const own = originFor(request);
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  if ((origin && origin !== own) || (site && !['same-origin', 'none'].includes(site))) {
    throw new WatchError('PAIRING_ORIGIN', '請從本機「近即時字幕」頁面取得配對碼。', 403);
  }
}

function allowedOrigin(request: Request): string | null {
  const own = originFor(request);
  const origin = request.headers.get('origin');
  if (!origin) return null;
  if (origin === own || /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return origin;
  throw new WatchError('ORIGIN_DENIED', '不允許此網頁呼叫字幕服務。', 403);
}

export function assertWatchRequest(request: Request, token = pairingToken()) {
  allowedOrigin(request);
  const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  if (Buffer.byteLength(supplied) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
    throw new WatchError('UNAUTHORIZED', '請先在本機頁面取得配對碼。', 401);
  }
}

export function watchHeaders(request: Request): Headers {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin' });
  const origin = allowedOrigin(request);
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Prefer');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Max-Age', '600');
  return headers;
}

export async function readWatchJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new WatchError('CONTENT_TYPE', '請使用 JSON。', 415);
  if (Number(request.headers.get('content-length')) > 4096) throw new WatchError('TOO_LARGE', '請求過大。', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new WatchError('INVALID_BODY', '缺少請求內容。');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); throw new WatchError('TOO_LARGE', '請求過大。', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new WatchError('INVALID_BODY', 'JSON 格式不正確。'); }
}

export function watchErrorResponse(error: unknown, request?: Request): Response {
  let headers = new Headers({ 'Cache-Control': 'no-store' });
  if (request) { try { headers = watchHeaders(request); } catch { /* forbidden origin receives no CORS */ } }
  if (error instanceof WatchError) {
    if ([429, 503].includes(error.status)) headers.set('Retry-After', '3');
    return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return Response.json({ error: '工作已取消，可從目前位置重試。', code: 'CANCELLED' }, { status: 409, headers });
  }
  // Never return provider responses, shell stderr, signed caption URLs or credentials.
  return Response.json({ error: '字幕取得或翻譯未完成，請確認原文字幕可用並稍後重試。', code: 'WATCH_FAILED' }, { status: 502, headers });
}
