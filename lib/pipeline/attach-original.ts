/** Attach a user-owned, same-timeline MP4 without invoking any model or subtitle writer. */
import fs, { constants, type Stats } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import type { SummaryRow } from '../db';
import { assertPairingRequest, assertWatchRequest } from '../watch/security';
import { WatchError } from '../watch/errors';
import { acquireMediaOperation, ownsMediaOperation, releaseMediaOperation } from './media-operation';

export const MAX_ATTACHED_VIDEO_BYTES = 2 * 1024 ** 3;
const DISK_RESERVE = 256 * 1024 ** 2;
const UPLOAD_TIMEOUT = 15 * 60 * 1000;
const execFileAsync = promisify(execFile);
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
export class AttachmentError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = 'AttachmentError'; }
}
function fail(code: string, message: string, status = 400): never { throw new AttachmentError(code, message, status); }
type AttachmentRow = SummaryRow & { subtitle_status?: string };
export interface ProbedVideo { duration: number; videoDuration: number; start: number; videoStart: number; }
interface AttachmentOptions {
  db: Database.Database;
  root: string;
  // Injectable only for isolated fixtures; the production route always uses actual ffprobe.
  probe?: (file: string, signal: AbortSignal) => Promise<ProbedVideo>;
  maxBytes?: number;
  timeoutMs?: number;
  diskAvailable?: (directory: string) => Promise<number>;
}

/** This write endpoint is same-origin loopback only; a supplied pairing token is also validated. */
export function assertAttachmentRequest(request: Request) {
  assertPairingRequest(request);
  if (request.headers.has('authorization')) assertWatchRequest(request);
  // Custom consent/size headers prevent a cross-site simple form submission even without Origin.
  if (request.headers.get('x-confirm-rights') !== 'true') fail('RIGHTS_REQUIRED', '請先確認你有權使用並附加這份原片。', 403);
  if (request.headers.get('x-confirm-same-timeline') !== 'true') fail('TIMELINE_CONFIRMATION_REQUIRED', '請確認原片是同一版本、未剪輯、未加片頭，且與現有字幕從同一起點計時；片長相同不代表時間軸一致。', 422);
}

function sourceTimeline(row: AttachmentRow) {
  if (row.video_url) fail('VIDEO_EXISTS', '此摘要已有原片，不會覆寫；請使用既有影片。', 409);
  if (row.burn_status === 'burning') fail('MEDIA_BUSY', '字幕燒錄仍在進行，請完成後再附加原片。', 409);
  if (row.status !== 'done' || row.subtitle_status === 'processing') fail('SUMMARY_BUSY', '摘要或字幕工作仍在進行，請先等它完成或暫停後再附加原片。', 409);
  if (!SAFE_ID.test(row.id) || !SAFE_ID.test(row.video_id)) fail('INVALID_ID', '摘要編號格式不安全，無法附加原片。');
  let end = 0;
  for (const [index, raw] of [row.segments, row.segments_zh].entries()) {
    if (!raw && index === 1) continue;
    let cues: unknown;
    try { cues = JSON.parse(raw || 'null'); } catch { fail('INVALID_SUBTITLE_TIMELINE', '現有字幕時間軸無效，請先修復字幕。', 422); }
    if (!Array.isArray(cues) || (index === 0 && !cues.length)) fail('INVALID_SUBTITLE_TIMELINE', '缺少可驗證的原文字幕時間軸；不會另跑 Whisper。', 422);
    for (const cue of cues) {
      if (!cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || typeof cue.text !== 'string') fail('INVALID_SUBTITLE_TIMELINE', '現有字幕包含無效時間，未附加原片。', 422);
      end = Math.max(end, cue.end);
    }
  }
  if (!Number.isFinite(row.duration) || row.duration <= 0) fail('UNKNOWN_SOURCE_DURATION', '缺少來源片長，無法安全比對同版本原片。', 422);
  return { end, duration: row.duration };
}

export function validateAttachmentTimeline(row: AttachmentRow, probe: ProbedVideo) {
  const source = sourceTimeline(row);
  if (![probe.duration, probe.videoDuration, probe.start, probe.videoStart].every(Number.isFinite)
    || probe.duration <= 0 || probe.videoDuration <= 0) fail('INVALID_VIDEO', '無法確認 MP4 影片的有效長度。', 415);
  if (Math.abs(probe.start) > 0.1 || Math.abs(probe.videoStart) > 0.1) fail('VIDEO_START_OFFSET', '原片不是從 0 秒開始計時，可能與現有字幕錯位；請提供同起點 MP4。', 422);
  // Allow at most 250 ms of muxer/subtitle rounding, not missing sections.
  if (Math.min(probe.duration, probe.videoDuration) + 0.25 < source.end) fail('VIDEO_TOO_SHORT', `原片長度未涵蓋最後字幕（${source.end.toFixed(2)} 秒），請選擇完整同版本影片。`, 422);
  const tolerance = Math.max(2, Math.min(10, source.duration * 0.01));
  if (Math.abs(probe.duration - source.duration) > tolerance || Math.abs(probe.videoDuration - source.duration) > tolerance) fail('DURATION_MISMATCH', `原片與來源片長（${source.duration.toFixed(2)} 秒）差異過大；允許的封裝誤差為 ${tolerance.toFixed(2)} 秒。請勿使用剪輯或加片頭版本。`, 422);
  return source;
}

export async function probeAttachedMp4(file: string, signal: AbortSignal): Promise<ProbedVideo> {
  const binary = process.env.FFPROBE_BIN || (fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync(binary, ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-enable_drefs', '0', '-use_absolute_path', '0',
      '-show_entries', 'format=format_name,duration,start_time:stream=codec_type,codec_name,width,height,duration,start_time,nb_frames', '-of', 'json', file],
    { timeout: 45_000, maxBuffer: 128 * 1024, signal }));
  } catch (error) {
    if (signal.aborted) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('PROBE_UNAVAILABLE', '找不到本機 ffprobe；未附加影片，請先安裝 FFmpeg。', 503);
    fail('INVALID_VIDEO', 'ffprobe 無法讀取有效 MP4；請選擇完整、可播放的原片，不要只更改副檔名。', 415);
  }
  let data: { format?: { format_name?: string; duration?: string; start_time?: string }; streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; start_time?: string; nb_frames?: string }[] };
  try { data = JSON.parse(output!); } catch { fail('INVALID_VIDEO', '無法驗證 MP4 內容。', 415); }
  const videos = data.streams?.filter(stream => stream.codec_type === 'video');
  const video = videos?.[0];
  if (!data.format?.format_name?.split(',').includes('mp4') || !video || videos?.length !== 1 || !['h264', 'hevc', 'av1', 'mpeg4', 'vp9'].includes(video.codec_name || '')
    || !(video.width && video.width > 0) || !(video.height && video.height > 0) || (video.nb_frames && Number(video.nb_frames) < 2)) fail('INVALID_VIDEO', '只接受含單一有效影片軌的 MP4 原片（不是音訊、圖片或播放清單）。', 415);
  return { duration: Number(data.format.duration), videoDuration: Number(video.duration), start: Number(data.format.start_time ?? 0), videoStart: Number(video.start_time ?? 0) };
}

/** Check every owned directory, not merely a string-prefix traversal check. */
async function safeDirectories(root: string, components: string[]) {
  const actualRoot = await fsp.realpath(root);
  let directory = actualRoot;
  const snapshots = new Map<string, Stats>();
  snapshots.set(directory, await fsp.lstat(directory));
  for (const part of components) {
    directory = path.join(directory, part);
    try { await fsp.mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fsp.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fsp.realpath(directory) !== directory) fail('UNSAFE_STORAGE', '影片儲存目錄不是安全的本機目錄，未寫入原片。', 409);
    snapshots.set(directory, stat);
  }
  return { directory, snapshots };
}
async function unchangedDirectories(snapshots: Map<string, Stats>) {
  for (const [directory, before] of snapshots) {
    const now = await fsp.lstat(directory);
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== before.dev || now.ino !== before.ino || await fsp.realpath(directory) !== directory) fail('UNSAFE_STORAGE', '上傳期間儲存目錄有變動，未附加原片。', 409);
  }
}
async function availableDisk(directory: string) { const stat = await fsp.statfs(directory); return stat.bavail * stat.bsize; }
async function verifyMp4Header(handle: FileHandle, bytes: number) {
  const header = Buffer.alloc(256); const read = await handle.read(header, 0, header.length, 0);
  const boxSize = header.readUInt32BE(0);
  if (read.bytesRead < 20 || header.toString('ascii', 4, 8) !== 'ftyp' || boxSize < 20 || boxSize > bytes || boxSize > 256 || boxSize % 4 !== 0) fail('INVALID_VIDEO', '檔案沒有有效 MP4 容器標頭；請勿僅改副檔名。', 415);
  const brands: string[] = [];
  for (let offset = 8; offset + 4 <= Math.min(boxSize, read.bytesRead); offset += 4) if (offset !== 12) brands.push(header.toString('ascii', offset, offset + 4));
  if (!brands.some(brand => /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V )$/.test(brand)) || brands[0] === 'qt  ') fail('INVALID_VIDEO', '目前僅接受 MP4，不接受 MOV 或其他改名格式。', 415);
}

export async function attachOriginalVideo(request: Request, id: string, options: AttachmentOptions) {
  assertAttachmentRequest(request);
  if (!SAFE_ID.test(id)) fail('INVALID_ID', '摘要編號格式不正確。');
  const maxBytes = Math.min(options.maxBytes ?? MAX_ATTACHED_VIDEO_BYTES, MAX_ATTACHED_VIDEO_BYTES);
  if (request.headers.get('content-type')?.split(';')[0].toLowerCase() !== 'video/mp4') fail('CONTENT_TYPE', '目前請以 video/mp4 傳送完整 MP4 原片。', 415);
  const sizeHeader = request.headers.get('x-file-size') || '';
  if (!/^[1-9]\d{0,15}$/.test(sizeHeader)) fail('INVALID_SIZE', '缺少有效的原片大小。');
  const expectedSize = Number(sizeHeader);
  if (!Number.isSafeInteger(expectedSize) || expectedSize > maxBytes) fail('VIDEO_TOO_LARGE', '原片不可超過 2 GiB，請選擇較小的同版本 MP4。', 413);
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) !== expectedSize)) fail('SIZE_MISMATCH', '原片大小與上傳內容不一致，請重新選取檔案。');
  if (!request.body) fail('EMPTY_VIDEO', '請選擇要附加的 MP4 原片。');
  const { db } = options;
  let row = db.prepare('SELECT * FROM summaries WHERE id=? OR video_id=?').get(id, id) as AttachmentRow | undefined;
  if (!row) fail('NOT_FOUND', '找不到這份摘要。', 404);
  sourceTimeline(row);
  const token = acquireMediaOperation(db, row.id, 'attach');
  if (!token) fail('MEDIA_BUSY', '原片下載或附加仍在進行，請勿同時操作。', 409);
  const rowId = row.id;
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? UPLOAD_TIMEOUT);
  let handle: FileHandle | undefined;
  let tempDirectory: string | undefined, target: string | undefined, published: Stats | undefined;
  let committed = false;
  let cleanupSnapshots: Map<string, Stats> | undefined;
  try {
    controller.signal.throwIfAborted();
    // A second read under the lease closes the initial row-check / claim race.
    row = db.prepare('SELECT * FROM summaries WHERE id=?').get(rowId) as AttachmentRow | undefined;
    if (!row) fail('NOT_FOUND', '摘要已移除，未附加原片。', 404);
    sourceTimeline(row);
    const scratch = await safeDirectories(options.root, ['data', 'tmp', 'attached-originals']);
    const dest = await safeDirectories(options.root, ['public', 'videos']);
    const checkDisk = async (needed: number) => { if (await (options.diskAvailable || availableDisk)(scratch.directory) < needed + DISK_RESERVE) fail('INSUFFICIENT_DISK', '本機可用空間不足；需保留至少 256 MiB，未附加原片。', 507); };
    await checkDisk(expectedSize);
    tempDirectory = await fsp.mkdtemp(path.join(scratch.directory, 'upload-'));
    const tempStat = await fsp.lstat(tempDirectory);
    scratch.snapshots.set(tempDirectory, tempStat);
    cleanupSnapshots = scratch.snapshots;
    const tempFile = path.join(tempDirectory, 'original.part');
    handle = await fsp.open(tempFile, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await unchangedDirectories(scratch.snapshots);
    const reader = request.body!.getReader();
    const cancel = () => { void reader.cancel().catch(() => undefined); };
    controller.signal.addEventListener('abort', cancel, { once: true });
    let bytes = 0, diskCheckedAt = 0;
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const { done, value } = await reader.read();
        controller.signal.throwIfAborted();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes || bytes > expectedSize) fail('VIDEO_TOO_LARGE', '實際上傳超出允許大小，已取消並清除暫存。', 413);
        if (bytes - diskCheckedAt >= 64 * 1024 ** 2) { await checkDisk(expectedSize - bytes); diskCheckedAt = bytes; }
        let written = 0;
        while (written < value.byteLength) written += (await handle.write(value, written, value.byteLength - written)).bytesWritten;
      }
    } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
    finally { controller.signal.removeEventListener('abort', cancel); reader.releaseLock(); }
    if (bytes !== expectedSize) fail('SIZE_MISMATCH', '上傳未完成或檔案大小不一致，未附加原片。');
    await handle.sync();
    await verifyMp4Header(handle, bytes);
    await unchangedDirectories(scratch.snapshots);
    const before = await handle.stat();
    const probe = await (options.probe || probeAttachedMp4)(tempFile, controller.signal);
    controller.signal.throwIfAborted();
    validateAttachmentTimeline(row, probe);
    await unchangedDirectories(scratch.snapshots);
    const after = await fsp.lstat(tempFile);
    if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('UNSAFE_STORAGE', '驗證期間原片有變動，未附加。', 409);
    await unchangedDirectories(dest.snapshots);
    const publicUrl = `/videos/attached-${rowId}-${randomUUID()}.mp4`;
    target = path.join(dest.directory, path.basename(publicUrl));
    // Hard-link atomically publishes a complete verified file and cannot overwrite an existing path.
    await fsp.link(tempFile, target);
    published = before;
    await unchangedDirectories(dest.snapshots);
    const linked = await fsp.lstat(target);
    if (!linked.isFile() || linked.ino !== before.ino || linked.dev !== before.dev) fail('UNSAFE_STORAGE', '原片發布失敗，未更新摘要。', 409);
    controller.signal.throwIfAborted();
    const source = db.transaction(() => {
      const current = db.prepare('SELECT * FROM summaries WHERE id=?').get(rowId) as AttachmentRow | undefined;
      if (!current) fail('NOT_FOUND', '摘要已移除，未附加原片。', 404);
      if (!ownsMediaOperation(db, rowId, token)) fail('MEDIA_BUSY', '原片工作狀態已變更，請稍後重試。', 409);
      const verified = validateAttachmentTimeline(current, probe);
      // Only video metadata and a resolved download-only error may change. Never rewrite transcript/translation/summary/SRT/cache/auto_burn.
      const result = db.prepare("UPDATE summaries SET video_url=?, is_video=1, error=CASE WHEN substr(error,1,15)='download-video:' THEN NULL ELSE error END WHERE id=? AND (video_url IS NULL OR video_url='') AND COALESCE(burn_status,'')!='burning'").run(publicUrl, rowId);
      if (result.changes !== 1) fail('MEDIA_BUSY', '摘要已有其他原片工作，未覆寫任何內容。', 409);
      db.prepare(`INSERT INTO summary_video_attachments (summary_id,video_url,bytes,duration,source_duration,subtitle_end,rights_confirmed,timeline_confirmation)
        VALUES (?,?,?,?,?,?,1,'user-confirmed-same-version')`).run(rowId, publicUrl, bytes, probe.duration, verified.duration, verified.end);
      return verified;
    }).immediate();
    committed = true;
    return { status: 'done', video_url: publicUrl, attachment: { bytes, duration: probe.duration, source_duration: source.duration, subtitle_end: source.end, timeline: 'user-confirmed-same-version' },
      message: '已附加原片並沿用現有字幕與摘要，未執行辨識或翻譯，也未自動燒錄。時間軸由你確認，片長檢查不等同內容比對。' };
  } catch (error) {
    if (timedOut) fail('UPLOAD_TIMEOUT', '原片上傳或驗證逾時，已取消；既有摘要與字幕不變。', 408);
    if (request.signal.aborted) fail('UPLOAD_CANCELLED', '已取消附加原片；既有摘要與字幕不變。', 409);
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC') fail('INSUFFICIENT_DISK', '本機磁碟空間不足，未附加原片。', 507);
    throw error;
  } finally {
    clearTimeout(timeout); request.signal.removeEventListener('abort', abort);
    await handle?.close().catch(() => undefined);
    if (!committed && target && published) {
      // Do not delete a different file if the destination was replaced by another local actor.
      try { const stat = await fsp.lstat(target); if (stat.ino === published.ino && stat.dev === published.dev && !stat.isSymbolicLink()) await fsp.unlink(target); } catch { /* already absent */ }
    }
    if (tempDirectory && cleanupSnapshots) {
      try { await unchangedDirectories(cleanupSnapshots); await fsp.rm(tempDirectory, { recursive: true, force: true }); } catch { /* Never follow a raced directory to delete unrelated files. */ }
    }
    releaseMediaOperation(db, rowId, token);
  }
}

export function attachmentErrorResponse(error: unknown): Response {
  const known = error instanceof AttachmentError || error instanceof WatchError;
  return Response.json({ error: known ? error.message : '附加原片失敗；既有摘要與字幕未變更，請確認本機儲存與 MP4 後重試。', code: known ? error.code : 'ATTACHMENT_FAILED' },
    { status: known ? error.status : 500, headers: { 'Cache-Control': 'no-store' } });
}
