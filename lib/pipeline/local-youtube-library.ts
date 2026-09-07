/** YouTube library jobs: captions → local summary/cards → full validated subtitle export.
 * Summary readiness and subtitle completeness are deliberately separate states. */
import path from 'node:path';
import { getDb, type SummaryRow } from '../db';
import { watchService } from '../watch/service';
import { processingMode } from '../watch/provider';
import { canonicalYouTubeUrl } from '../watch/source';
import type { TranslatedCue, WatchSessionView, WatchCueFailure } from '../watch/types';
import { transcriptFromWatchSource } from './fetch-transcript';
import { extractLocalSummary } from './local-summary';
import { ensureSummaryShape, type Summary } from './extract-summary';
import type { VideoMetadata } from './fetch-transcript';
import { renderCard } from './render-card';
import { resolveCardStyle } from '../card-style';
import { writeSubtitleFiles } from './burn-bilingual';
import { selectWindow } from '../watch/cues';
import { WatchError, LOCAL_QUALITY_REASONS, safeLocalQualityReason } from '../watch/errors';

const runtime = globalThis as typeof globalThis & { __localLibraryJobs?: Map<string, Promise<void>> };
const jobs = () => runtime.__localLibraryJobs ??= new Map<string, Promise<void>>();
export function ensureLibrarySubtitleColumns() {
  const db = getDb();
  for (const [name, type] of [['subtitle_status', 'TEXT'], ['subtitle_completed', 'INTEGER DEFAULT 0'], ['subtitle_total', 'INTEGER DEFAULT 0'], ['subtitle_error', 'TEXT']]) {
    const columns = db.prepare('PRAGMA table_info(summaries)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === name)) db.exec(`ALTER TABLE summaries ADD COLUMN ${name} ${type}`);
  }
}

export function publicLibraryError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'LIBRARY_BUSY_TIMEOUT') return '本機字幕服務忙碌超過 90 秒，已暫停此工作；成功字幕已保留，請停止其他翻譯工作後重試。';
  if (code === 'LOCAL_TRANSLATION_QUALITY') return '部分字幕尚未通過翻譯品質檢查，成功段落已保留；請按「繼續完成字幕」重試未完成段落。';
  if (/CAPTION|YTDLP|NO_CAPTIONS|ENGLISH_ONLY/.test(code)) return '無法取得英文原文字幕，可能是 YouTube 流量限制、字幕語言不符或 yt-dlp 需要更新。請稍後重試；未下載音訊或呼叫付費辨識。';
  if (/LOCAL_|BUSY/.test(code)) return '本機模型尚未完成或暫時忙碌。已完成的字幕快取會保留，稍後重試；不會改用雲端。';
  return '本機摘要或字幕工作未完成，已取得的字幕與成功快取會保留。請確認 Ollama 可用後重試；不會自動下載音訊或改用雲端。';
}

/** Persist only fixed guard reasons and source timing; never exception/model/source text. */
export function libraryPartialSubtitleError(completed: number, total: number, failures: WatchCueFailure[]): string {
  const clock = (seconds: number) => {
    const safe = Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 10) : 0;
    const minutes = Math.floor(safe / 600), rest = safe % 600;
    return `${String(minutes).padStart(2, '0')}:${String(Math.floor(rest / 10)).padStart(2, '0')}.${rest % 10}`;
  };
  const reasons = failures.slice(0, 3).map(item => `${clock(item.start)}–${clock(item.end)} ${LOCAL_QUALITY_REASONS[safeLocalQualityReason(item.reason)]}`).join('；');
  return `字幕已完成 ${completed}/${total} 句，仍有 ${total - completed} 句未通過品質檢查。${reasons ? `原因：${reasons}。` : ''}摘要已完成；請繼續完成字幕後下載完整中/雙語 SRT。`;
}

/** Stable server-selected anchors; reject an impossible window rather than silently skipping it. */
export function libraryWindowTime(source: WatchSessionView, index: number): number {
  const previousEnd = index ? Math.max(...source.cues.slice(0, index).map(cue => cue.end)) : 0;
  const time = Math.max(source.cues[index].start, previousEnd);
  if (selectWindow(source.cues, time).windowKey !== String(Math.floor(index / 8))) throw new Error('原文字幕時間軸無法完整分批，請重新載入原文。');
  return time;
}

const CARD_RENDER_ERROR = '文字摘要已保存，但圖卡繪製尚未完成。請確認本機 Chromium 啟動權限或圖卡輸出目錄後，重新提交同一連結重試圖卡；字幕翻譯會繼續，不需重跑摘要模型。';
export function libraryCardsReady(value: unknown): boolean {
  try {
    const paths: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(paths) && paths.length > 0 && paths.every(item => typeof item === 'string' && item.startsWith('/cards/'));
  } catch { return false; }
}
interface LibraryDependencies { summarize?: typeof extractLocalSummary; render?: typeof renderCard }

/** Rendering is an optional artifact step: its failure cannot invalidate text or block subtitles. */
async function renderLibraryCards(id: string, contentId: string, summary: Summary, metadata: VideoMetadata, render: typeof renderCard): Promise<boolean> {
  const db = getDb();
  db.prepare("UPDATE summaries SET status='done', pipeline_stage='library_rendering' WHERE id=?").run(id);
  try {
    const row = db.prepare('SELECT card_style FROM summaries WHERE id=?').get(id) as Pick<SummaryRow, 'card_style'>;
    const slides = await render(summary, metadata, path.join(process.cwd(), 'public', 'cards', contentId), resolveCardStyle(row.card_style));
    if (!slides.length) throw new Error('No rendered cards');
    const publicPaths = slides.map((_, i) => `/cards/${contentId}/slide-${i + 1}.png`);
    db.prepare("UPDATE summaries SET card_paths=?, slide_count=?, error=NULL, pipeline_stage='summary_ready' WHERE id=?").run(JSON.stringify(publicPaths), publicPaths.length, id);
    return true;
  } catch {
    db.prepare("UPDATE summaries SET error=?, pipeline_stage='summary_ready', status='done' WHERE id=?").run(CARD_RENDER_ERROR, id);
    return false;
  }
}

export async function runLocalYoutubeLibrary(id: string, url: string, dependencies: LibraryDependencies = {}) {
  ensureLibrarySubtitleColumns();
  const db = getDb();
  const service = watchService();
  const summarize = dependencies.summarize || extractLocalSummary;
  const render = dependencies.render || renderCard;
  let session: WatchSessionView | undefined;
  const existing = db.prepare('SELECT * FROM summaries WHERE id = ?').get(id) as (SummaryRow & { subtitle_status?: string }) | undefined;
  if (!existing) return;
  let summaryReady = Boolean(existing.summary);
  let cardError = existing.error === CARD_RENDER_ERROR ? CARD_RENDER_ERROR : null;
  try {
    if (processingMode() !== 'local') throw new Error('本機摘要工作不會改用雲端。');
    // Complete subtitles do not need a new source fetch/model run just to retry PNG rendering.
    if (summaryReady && existing.subtitle_status === 'complete') {
      if (!libraryCardsReady(existing.card_paths)) {
        const summary = ensureSummaryShape(JSON.parse(existing.summary!));
        const metadata: VideoMetadata = { video_id: existing.video_id, title: existing.title || '', channel: existing.channel || '',
          duration: existing.duration || 0, duration_display: existing.duration_display || '', thumbnail_url: existing.thumbnail_url || '',
          transcript_source: existing.transcript_source || 'subtitle', upload_date: '', view_count: 0 };
        await renderLibraryCards(id, existing.video_id, summary, metadata, render);
      }
      db.prepare("UPDATE summaries SET status='done', pipeline_stage='done' WHERE id=?").run(id);
      return;
    }
    session = await service.start(url);
    if (session.processingMode !== 'local') throw new Error('本機摘要工作不會改用雲端。');
    const { metadata, transcript, segments } = transcriptFromWatchSource(session);
    const contentId = session.videoId;
    if (!db.prepare('SELECT id FROM summaries WHERE id=?').get(id)) return;
    db.prepare(`UPDATE summaries SET title=?, duration=?, duration_display=?, thumbnail_url=?, transcript_source=?, transcript=?, segments=?,
      subtitle_status='processing', subtitle_completed=?, subtitle_total=?, subtitle_error=NULL, pipeline_stage=?, error=NULL,
      segments_zh=NULL, transcript_zh=NULL, is_translated=0, srt_zh_path=NULL, srt_bi_path=NULL WHERE id=?`)
      .run(metadata.title, metadata.duration, metadata.duration_display, metadata.thumbnail_url, metadata.transcript_source, transcript, JSON.stringify(segments),
        session.cachedCues?.length || 0, segments.length, summaryReady ? 'summary_ready' : 'library_source_ready', id);
    const outputDir = path.join(process.cwd(), 'public', 'burned', contentId);
    const publicPath = (file: string | null) => file ? '/' + path.relative(path.join(process.cwd(), 'public'), file).split(path.sep).join('/') : null;
    const originals = writeSubtitleFiles({ segments, segmentsZh: null, wasTranslated: false, outputDir, contentId });
    db.prepare('UPDATE summaries SET srt_en_path=? WHERE id=?').run(publicPath(originals.srtEnPath), id);

    let summary: Summary;
    if (!summaryReady) {
      db.prepare("UPDATE summaries SET pipeline_stage='library_summarizing' WHERE id=?").run(id);
      const timestamped = segments.map(cue => `[${Math.floor(cue.start / 60)}:${String(Math.floor(cue.start % 60)).padStart(2, '0')}] ${cue.text}`).join('\n');
      summary = await summarize(timestamped, metadata.title, metadata.channel);
      db.prepare("UPDATE summaries SET summary=?, status='done', pipeline_stage='summary_ready' WHERE id=?").run(JSON.stringify(summary), id);
      summaryReady = true; // Durable text is useful even if the PNG renderer cannot launch.
    } else {
      summary = ensureSummaryShape(JSON.parse(existing.summary!));
      db.prepare("UPDATE summaries SET status='done' WHERE id=?").run(id);
    }
    if (!libraryCardsReady(existing.card_paths)) {
      cardError = await renderLibraryCards(id, contentId, summary, metadata, render) ? null : CARD_RENDER_ERROR;
    }

    const saved = new Map<string, TranslatedCue>((session.cachedCues || []).map(cue => [cue.id, cue]));
    const failures = new Map<string, WatchCueFailure>();
    // At most two bounded passes. Failed cues never erase successes or stop other windows.
    for (let pass = 0; pass < 2 && saved.size < session.cues.length; pass++) {
      for (let index = 0; index < session.cues.length; index += 8) {
        const targets = session.cues.slice(index, index + 8);
        if (targets.every(cue => saved.has(cue.id))) continue;
        if (!db.prepare('SELECT id FROM summaries WHERE id=?').get(id)) return;
        const result = await withLibraryBusyRetry(() => service.window(session!.sessionId, libraryWindowTime(session!, index), true));
        for (const cue of result.cues) { saved.set(cue.id, cue); failures.delete(cue.id); }
        for (const failure of result.failedCues || []) if (!saved.has(failure.id)) failures.set(failure.id, failure);
        db.prepare('UPDATE summaries SET subtitle_completed=?, subtitle_error=? WHERE id=?')
          .run(saved.size, failures.size ? libraryPartialSubtitleError(saved.size, session.cues.length, [...failures.values()]) : null, id);
      }
    }
    if (saved.size !== session.cues.length) {
      db.prepare("UPDATE summaries SET subtitle_status='partial', subtitle_completed=?, subtitle_error=? WHERE id=?")
        .run(saved.size, libraryPartialSubtitleError(saved.size, session.cues.length, [...failures.values()]), id);
      return;
    }
    const translated = session.cues.map(cue => { const result = saved.get(cue.id)!; return { start: cue.start, end: cue.end, text: result.text }; });
    const subtitleFiles = writeSubtitleFiles({ segments, segmentsZh: translated, wasTranslated: true, outputDir, contentId });
    db.prepare(`UPDATE summaries SET segments_zh=?, transcript_zh=?, is_translated=1, srt_zh_path=?, srt_bi_path=?,
      subtitle_status='complete', subtitle_completed=?, subtitle_error=NULL, pipeline_stage='done', status='done' WHERE id=?`)
      .run(JSON.stringify(translated), translated.map(cue => cue.text).join(' '), publicPath(subtitleFiles.srtZhPath), publicPath(subtitleFiles.srtBiPath), translated.length, id);
  } catch (error) {
    const message = publicLibraryError(error);
    if (summaryReady) db.prepare("UPDATE summaries SET status='done', error=?, subtitle_status='error', subtitle_error=? WHERE id=?").run(cardError, message, id);
    else db.prepare("UPDATE summaries SET status='error', error=?, subtitle_status='error', subtitle_error=? WHERE id=?").run(message, message, id);
    // No shell stderr, API payloads, credential-bearing URLs, or model text in logs/UI.
  } finally { if (session) service.stop(session.sessionId); }
}

/** Repeated clicks join the existing job; do not create duplicate model work. */
export function startLocalYoutubeLibrary(id: string, url: string): Promise<void> {
  canonicalYouTubeUrl(url);
  const active = jobs().get(id); if (active) return active;
  ensureLibrarySubtitleColumns();
  // Publish the state before any awaited source/health request, so a retry UI keeps polling.
  getDb().prepare("UPDATE summaries SET subtitle_status=CASE WHEN subtitle_status='complete' THEN 'complete' ELSE 'processing' END, subtitle_error=NULL, pipeline_stage=CASE WHEN subtitle_status='complete' THEN 'library_rendering' ELSE pipeline_stage END WHERE id=?").run(id);
  const work = runLocalYoutubeLibrary(id, url).finally(() => jobs().delete(id));
  jobs().set(id, work);
  return work;
}
export function libraryJobActive(id: string) { return jobs().has(id); }

export function recoverLocalLibraryJobs() {
  ensureLibrarySubtitleColumns();
  // Restart is not a new consent to inference. Preserve checkpoints and offer an explicit retry.
  // A renderer-only retry keeps subtitles complete. It still needs a terminal state on
  // restart; otherwise the UI sees library_rendering forever although no job survived.
  getDb().prepare(`UPDATE summaries SET status=CASE WHEN summary IS NOT NULL AND TRIM(summary)<>'' THEN 'done' ELSE 'error' END, pipeline_stage='library_render_error', card_render_token=NULL, error=?
    WHERE pipeline_stage='library_rendering' OR card_render_token IS NOT NULL`)
    .run('library_render_error: 圖卡繪製因伺服器重新啟動而中斷。原有摘要、字幕、圖片與樣式已保留；請在樣式面板重新套用，只重試圖卡，不需重新翻譯。');
  getDb().prepare(`UPDATE summaries SET subtitle_status='error',
    status=CASE WHEN summary IS NOT NULL AND TRIM(summary)<>'' THEN 'done' ELSE 'error' END,
    pipeline_stage=CASE WHEN pipeline_stage='library_render_error' AND summary IS NOT NULL AND TRIM(summary)<>'' THEN 'library_render_error' WHEN summary IS NOT NULL AND TRIM(summary)<>'' THEN 'summary_ready' ELSE 'error' END,
    subtitle_error='伺服器重新啟動，字幕工作已暫停；請按「繼續完成字幕」，已完成快取不重算。'
    WHERE subtitle_status='processing'`).run();
}

export async function withLibraryBusyRetry<T>(request: () => Promise<T>, options: { now?: () => number; delay?: (ms: number) => Promise<void>; deadlineMs?: number } = {}): Promise<T> {
  const now = options.now || Date.now;
  const delay = options.delay || ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.deadlineMs ?? 90_000);
  for (;;) {
    try { return await request(); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'BUSY') throw error;
      const remaining = deadline - now();
      if (remaining <= 0) throw new WatchError('LIBRARY_BUSY_TIMEOUT', '本機字幕服務忙碌超過等待上限，成功字幕已保留。', 503);
      await delay(Math.min(2000, remaining));
    }
  }
}
