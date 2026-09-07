/** Serve runtime-created public artifacts without depending on Next's startup file list. */
import path from 'node:path';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';

const MEDIA_TYPES = {
  cards: { '.png': 'image/png' },
  burned: { '.srt': 'application/x-subrip; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.mp4': 'video/mp4' },
  // Match the existing upload allowlist; these routes do not enable new upload formats.
  videos: { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo' },
  audio: { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac', '.flac': 'audio/flac' },
} as const;
export type GeneratedMediaKind = keyof typeof MEDIA_TYPES;

const inside = (root: string, file: string) => file.startsWith(root + path.sep);
const safeParts = (parts: unknown): parts is string[] => Array.isArray(parts) && parts.length > 0 && parts.length <= 8
  && parts.every(part => typeof part === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/.test(part) && !part.includes('..'))
  && parts.join('/').length <= 1024;

/** Single byte ranges only; malformed, multiple, or unsatisfiable ranges are rejected. */
export function generatedMediaRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null;
  if (first === null) return last && last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : null;
  if (first >= size || (last !== null && last < first)) return null;
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}

/** All directory components and the final file must be real, non-symlink artifacts. */
async function openArtifact(kind: GeneratedMediaKind, parts: string[], projectRoot: string) {
  const publicDir = path.resolve(projectRoot, 'public');
  const root = path.join(publicDir, kind);
  const snapshots = new Map<string, Stats>();
  for (const directory of [publicDir, root]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Not an artifact directory');
    snapshots.set(directory, info);
  }
  const publicReal = await realpath(publicDir), rootReal = await realpath(root);
  if (publicReal !== path.join(await realpath(projectRoot), 'public') || rootReal !== path.join(publicReal, kind)) throw new Error('Outside public artifacts');
  let file = root;
  for (let index = 0; index < parts.length; index++) {
    file = path.join(file, parts[index]);
    const info = await lstat(file);
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) throw new Error('Not an artifact');
    snapshots.set(file, info);
  }
  const expectedFile = path.join(rootReal, ...parts);
  if (!inside(rootReal, expectedFile) || await realpath(file) !== expectedFile) throw new Error('Outside artifact directory');
  const before = snapshots.get(file)!;
  // NONBLOCK avoids a FIFO replacement blocking open; NOFOLLOW rejects a final symlink race.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('Artifact changed while opening');
    // Revalidate the directory chain after opening; never stream a raced symlink escape.
    for (const [component, original] of snapshots) {
      const current = await lstat(component);
      if (current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino) throw new Error('Artifact changed');
    }
    if (await realpath(file) !== expectedFile) throw new Error('Outside artifact directory');
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}

/** Only the four fixed public roots are exposed. No database, model, or other filesystem reads. */
export async function serveGeneratedMedia(request: Request, kind: GeneratedMediaKind, parts: unknown, projectRoot = process.cwd()): Promise<Response> {
  const failure = (status: number, headers?: HeadersInit) => new Response(null, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405, { Allow: 'GET, HEAD' });
  if (!Object.hasOwn(MEDIA_TYPES, kind) || !safeParts(parts)) return failure(404);
  const ext = path.extname(parts[parts.length - 1]).toLowerCase();
  const mime = (MEDIA_TYPES[kind] as Record<string, string>)[ext];
  if (!mime) return failure(404);
  let handle: FileHandle | undefined;
  try {
    if (request.signal.aborted) return failure(499);
    const opened = await openArtifact(kind, parts, projectRoot);
    handle = opened.handle;
    const { stat } = opened;
    const headers = new Headers({
      'Content-Type': mime, 'Content-Length': String(stat.size), 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Accept-Ranges': 'bytes', 'Last-Modified': stat.mtime.toUTCString(),
    });
    if (ext === '.srt') headers.set('Content-Disposition', `attachment; filename="${parts[parts.length - 1]}"`);
    // HEAD describes the complete representation; Range is defined for GET only.
    const rangeHeader = request.method === 'GET' ? request.headers.get('range') : null;
    const ifRange = request.headers.get('if-range');
    const useRange = rangeHeader && (!ifRange || ifRange === stat.mtime.toUTCString());
    const range = useRange ? generatedMediaRange(rangeHeader, stat.size) : null;
    if (useRange && !range) return failure(416, { 'Content-Range': `bytes */${stat.size}`, 'Accept-Ranges': 'bytes' });
    if (range) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      headers.set('Content-Length', String(range.end - range.start + 1));
    }
    if (request.method === 'HEAD' || stat.size === 0) return new Response(null, { status: 200, headers });
    if (request.signal.aborted) return failure(499);
    const stream = handle.createReadStream({ start: range?.start ?? 0, end: range?.end ?? stat.size - 1, autoClose: true });
    handle = undefined; // The stream now owns and closes the descriptor, including cancel/error.
    const abort = () => stream.destroy(new Error('Media request cancelled'));
    request.signal.addEventListener('abort', abort, { once: true });
    stream.once('close', () => request.signal.removeEventListener('abort', abort));
    if (request.signal.aborted) abort();
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  } catch {
    // Never include local paths, filenames from errors, or filesystem diagnostics.
    return failure(request.signal.aborted ? 499 : 404);
  } finally { await handle?.close(); }
}
