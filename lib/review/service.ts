/**
 * 語意校訂服務：讀字幕 → 切視窗與風險 → 背景重譯（只本機）→ 候選給人決定 → 套用寫回字幕並留版本。
 * 一次只跑一部影片；重啟後不自動續跑，租約過期由使用者手動繼續。
 *
 * 寫回字幕的原則：交易內重讀、以 segments_zh 原字串做 CAS，任何其他工作（字幕續作、重新翻譯、另一個 worker）
 * 在我們讀取之後改過字幕，就整批不寫、回 409；SRT／VTT 匯出失敗不吞，記進 export_error 讓人重試。
 */
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Glossary } from '../glossary-defaults';
import type { requestLocalTranslation } from '../watch/local-translator';
import { writeSubtitleFiles } from '../pipeline/burn-bilingual';
import { hashValue } from '../learning/source';
import { buildReviewWindows, prioritizeWindows, toReviewCues } from './windows';
import { runSubtitleReview, ReviewPipelineError, compact } from './pipeline';
import { ReviewInputError, SubtitleReviewStore, idleReviewProgress } from './store';
import { SUBTITLE_REVIEW_VERSION, type ReviewCandidate, type ReviewCue, type ReviewResponse, type ReviewWindow } from './types';

interface Segment { start: number; end: number; text: string }
export interface ReviewSourceRow {
  id: string; video_id: string; title: string | null; segments: string | null; segments_zh: string | null; is_translated: number;
  transcript_source: string | null; srt_zh_path: string | null; card_render_token: string | null; pipeline_stage: string | null;
  status?: string | null; subtitle_status?: string | null;
}

export interface SubtitleReviewServiceDependencies {
  db: Database.Database;
  store: SubtitleReviewStore;
  model: () => string;
  processingMode: () => 'local' | 'cloud';
  glossary: () => Glossary;
  request: typeof requestLocalTranslation;
  projectRoot?: string;
  /** 影片庫字幕工作是否還在跑（它結束時會整份重寫 segments_zh）。 */
  jobActive?: (id: string) => boolean;
}

export interface StartOptions { scope: 'flagged' | 'all' | 'windows'; limit: number; windowKeys?: string[] }
const FLAGGED_MIN_SCORE = 3;

const parseSegments = (json: string | null): Segment[] | null => {
  if (!json) return null;
  try { const value = JSON.parse(json); return Array.isArray(value) ? value : null; } catch { return null; }
};
const validSegment = (cue: unknown): cue is Segment => !!cue && typeof cue === 'object' && Number.isFinite((cue as Segment).start) && Number.isFinite((cue as Segment).end) && typeof (cue as Segment).text === 'string';

export const reviewSourceHash = (segments: Segment[], transcriptSource: string | null) => hashValue([SUBTITLE_REVIEW_VERSION.split('-').slice(0, 2).join('-'), segments.map(cue => [cue.start, cue.end, cue.text]), transcriptSource || '']);

interface Prepared { cues: ReviewCue[]; segments: Segment[]; segmentsZh: Segment[]; windows: ReviewWindow[]; sourceHash: string }

export class SubtitleReviewService {
  private tasks = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  constructor(private deps: SubtitleReviewServiceDependencies) {}

  private loadRow(id: string): ReviewSourceRow {
    const row = this.deps.db.prepare('SELECT * FROM summaries WHERE id=? OR video_id=?').get(id, id) as ReviewSourceRow | undefined;
    if (!row) throw new ReviewInputError('找不到這部影片。', 404);
    return row;
  }

  /** 原文與中譯必須逐句對齊：句數相同且每句 start/end 完全一致，否則不校訂也不套用。 */
  private prepare(row: ReviewSourceRow): Prepared {
    const segments = parseSegments(row.segments);
    if (!segments || !segments.length || !segments.every(validSegment)) throw new ReviewInputError('這部影片沒有可用的原文逐字稿，無法校訂。', 422);
    const zh = row.is_translated ? parseSegments(row.segments_zh) : null;
    if (!zh || zh.length !== segments.length || !zh.every(validSegment)) throw new ReviewInputError('中譯尚未完成或與原文句數不一致；請先完成字幕再校訂。', 422);
    if (zh.some((cue, index) => cue.start !== segments[index].start || cue.end !== segments[index].end)) throw new ReviewInputError('中譯時間軸與原文不一致，請先重新產生字幕再校訂。', 422);
    const cues = toReviewCues(segments, zh);
    return { cues, segments, segmentsZh: zh, windows: buildReviewWindows(cues), sourceHash: reviewSourceHash(segments, row.transcript_source) };
  }

  private writeBlock(row: ReviewSourceRow): string | null {
    if (row.card_render_token != null || row.pipeline_stage === 'library_rendering') return '這支影片正在重畫圖卡，請等完成再改字幕。';
    if (row.status === 'processing' || row.subtitle_status === 'processing' || this.deps.jobActive?.(row.id)) return '字幕或摘要工作進行中，它結束時會整份重寫字幕；請等完成再套用或還原。';
    return null;
  }

  get(id: string): ReviewResponse {
    const row = this.loadRow(id);
    const prepared = this.prepare(row);
    this.deps.store.recoverExpired();
    const run = this.deps.store.row(row.id);
    const stale = run?.source_hash && run.source_hash !== prepared.sourceHash;
    // current／changed 一律以此刻的字幕重算：候選存的是產生當時的譯文，之後字幕可能被別的工作改過。
    const candidates = this.deps.store.candidates(row.id, prepared.sourceHash).map(item => {
      const current = prepared.segmentsZh[item.cueIndex]?.text ?? item.current;
      return { ...item, current, changed: current === null || compact(item.candidate) !== compact(current), outdated: item.version !== SUBTITLE_REVIEW_VERSION };
    });
    const drifted = candidates.filter(item => item.decision === 'applied' && item.changed).length;
    const outdated = candidates.filter(item => item.outdated && item.decision !== 'applied').length;
    const flagged = new Set(prioritizeWindows(prepared.windows, FLAGGED_MIN_SCORE).map(window => window.key));
    return {
      status: run ? (stale && run.status !== 'running' ? 'partial' : run.status) : 'idle',
      progress: run ? JSON.parse(run.progress_json) : idleReviewProgress(),
      sourceHash: prepared.sourceHash,
      model: run?.model ?? null,
      version: run?.version ?? null,
      counts: {
        windows: prepared.windows.length, flaggedWindows: flagged.size, candidates: candidates.length,
        changed: candidates.filter(item => item.changed).length, approved: candidates.filter(item => item.decision === 'approved').length,
        rejected: candidates.filter(item => item.decision === 'rejected').length, applied: candidates.filter(item => item.decision === 'applied').length,
      },
      windows: prepared.windows.map(window => ({ key: window.key, flags: window.flags, score: window.score, flagged: flagged.has(window.key), start: window.cues[0].start, end: window.cues[window.cues.length - 1].end, cueIndexes: window.cues.map(cue => cue.index) })),
      candidates,
      error: stale ? `${run?.error ? `${run.error} ` : ''}[STALE_REVIEW] 原文字幕已變更，下方候選來自舊版本，請重新校訂。` : run?.error ?? null,
      lastAppliedAt: run?.last_applied_at ?? null,
      exportError: run?.export_error ?? null,
      drifted,
      outdated,
      writerActive: !!this.deps.jobActive?.(row.id),
    };
  }

  start(id: string, options: StartOptions): { accepted: boolean; response: ReviewResponse } {
    if (this.deps.processingMode() !== 'local') throw new ReviewInputError('語意校訂只在本機模式執行，不會改送雲端。', 409);
    const row = this.loadRow(id);
    const prepared = this.prepare(row);
    const model = this.deps.model();
    // 舊版校訂邏輯產生的候選不算「已有候選」，升版後高風險視窗會自動重跑；同窗有一句已寫回不擋整窗
    //（重跑時 saveCandidates 只在文字相同才保留 applied，已寫進字幕的內容不受影響）。
    const existing = new Set(this.deps.store.candidates(row.id, prepared.sourceHash).filter(item => item.version === SUBTITLE_REVIEW_VERSION).map(item => item.windowKey));
    let selected: ReviewWindow[];
    if (options.scope === 'windows') {
      const keys = new Set(options.windowKeys ?? []);
      selected = prepared.windows.filter(window => keys.has(window.key));
      if (!selected.length) throw new ReviewInputError('指定的視窗不存在。', 422);
    } else {
      const pool = options.scope === 'all' ? prepared.windows : prioritizeWindows(prepared.windows, FLAGGED_MIN_SCORE);
      selected = pool.filter(window => !existing.has(window.key)).slice(0, options.limit);
      if (!selected.length) throw new ReviewInputError(options.scope === 'all' ? '所有視窗都已有候選；要重跑請指定視窗。' : '高風險視窗都已有候選；可改選「校訂其餘視窗」繼續。', 409);
    }
    const started = this.deps.store.start(row.id, prepared.sourceHash, model, SUBTITLE_REVIEW_VERSION, selected.length);
    if (!started.started || !started.token) return { accepted: this.deps.store.row(row.id)?.status === 'running', response: this.get(id) };
    const token = started.token;
    const controller = new AbortController();
    const checkActive = () => { if (!this.deps.store.active(row.id, token)) controller.abort(); controller.signal.throwIfAborted(); };
    const completion = Promise.resolve().then(async () => {
      checkActive();
      const result = await runSubtitleReview({ title: row.title || '', cues: prepared.cues, windows: selected }, {
        model, request: this.deps.request, signal: controller.signal, glossary: this.deps.glossary(), title: row.title || '', sourceHash: prepared.sourceHash,
        load: key => this.deps.store.checkpoint(row.id, key),
        save: (key, value) => { checkActive(); this.deps.store.saveCheckpoint(row.id, token, key, value); },
        progress: value => { checkActive(); this.deps.store.progress(row.id, token, value); },
        // 每窗成功就保存，後面的視窗失敗或取消都不丟掉已完成的候選。
        onWindow: candidates => { checkActive(); this.deps.store.saveCandidates(row.id, token, prepared.sourceHash, model, candidates, SUBTITLE_REVIEW_VERSION); },
        // 人工指定視窗重跑就是要新推論，不吃檢查點快取。
        refresh: options.scope === 'windows',
      });
      checkActive();
      const changed = result.candidates.filter(item => item.changed).length;
      this.deps.store.finish(row.id, token, { stage: 'complete', completed: result.processedWindows.length, total: selected.length,
        message: `${result.partial ? `部分完成（${result.failedWindows.length} 個視窗失敗）；` : '本輪完成；'}${result.processedWindows.length} 個視窗、${result.candidates.length} 句候選，其中 ${changed} 句與現行譯文不同。請逐句採用後再套用。` }, result.partial);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) this.deps.store.fail(row.id, token, error instanceof ReviewPipelineError ? `[${error.code}] ${error.message}` : '[REVIEW_INCOMPLETE] 本機語意校訂尚未完成；已產生的候選與檢查點都保留，請確認 Ollama 後手動繼續，不會改送雲端。');
    }).finally(() => { if (this.tasks.get(row.id)?.controller === controller) this.tasks.delete(row.id); });
    this.tasks.set(row.id, { controller, completion });
    return { accepted: true, response: this.get(id) };
  }

  cancel(id: string): ReviewResponse {
    const row = this.loadRow(id);
    // 只有本 process 持有 controller 時才能真的中止推論；跨 worker 的取消只清租約，舊呼叫會在下一個檢查點自行退出。
    this.tasks.get(row.id)?.controller.abort();
    this.deps.store.cancel(row.id);
    return this.get(id);
  }

  decide(id: string, sourceHash: string, cueIndexes: number[], decision: 'approved' | 'rejected' | 'candidate'): ReviewResponse {
    const row = this.loadRow(id);
    const prepared = this.prepare(row);
    if (sourceHash !== prepared.sourceHash) throw new ReviewInputError('原文字幕已變更，請重新校訂後再決定。', 409);
    if (!cueIndexes.length) throw new ReviewInputError('沒有指定句子。', 400);
    this.deps.store.decide(row.id, sourceHash, cueIndexes, decision);
    return this.get(id);
  }

  /**
   * 把已採用的候選寫回 segments_zh 與 SRT／VTT。交易內重讀並以原字串 CAS；已燒錄的 MP4 不會自動重燒。
   * 回傳的 exportError 不為 null 代表資料庫已更新但字幕檔沒寫成功，可用 exportAgain 重試。
   */
  apply(id: string, sourceHash: string, only?: number[]): { applied: number; batchId: string | null; exportError: string | null; response: ReviewResponse } {
    const row = this.loadRow(id);
    const block = this.writeBlock(row);
    if (block) throw new ReviewInputError(block, 409);
    const prepared = this.prepare(row);
    if (sourceHash !== prepared.sourceHash) throw new ReviewInputError('原文字幕已變更，請重新校訂後再套用。', 409);
    const written = this.applyWithinTransaction(row, prepared, sourceHash, only);
    if (!written) return { applied: 0, batchId: null, exportError: null, response: this.get(id) };
    const exportError = this.exportSubtitleFiles(row, prepared.segments, written.nextZh);
    if (exportError) this.deps.store.setExportError(row.id, exportError);
    return { applied: written.items, batchId: written.batchId, exportError, response: this.get(id) };
  }

  /** 套用的交易部分；`only` 限定這次只寫哪些句子（reapply 只處理漂移的句子）。可被外層交易包住（savepoint）。 */
  private applyWithinTransaction(row: ReviewSourceRow, prepared: Prepared, sourceHash: string, only?: number[]): { nextZh: Segment[]; items: number; batchId: string } | null {
    const scope = only ? new Set(only) : null;
    const approved = this.deps.store.approved(row.id, sourceHash).filter(item => !scope || scope.has(item.cueIndex));
    if (!approved.length) return null;
    const batchId = randomUUID();
    const appliedAt = new Date().toISOString();
    let written: { nextZh: Segment[]; items: number; batchId: string } | null = null;
    this.deps.db.transaction(() => {
      const fresh = this.freshRow(row.id);
      if (fresh.segments !== row.segments) throw new ReviewInputError('原文字幕在套用前被其他工作更動，未寫入任何句子；請重新整理。', 409);
      if (fresh.segments_zh !== row.segments_zh) throw new ReviewInputError('中譯在套用前被其他工作更動，未寫入任何句子；請重新整理後再套用。', 409);
      const freshBlock = this.writeBlock(fresh);
      if (freshBlock) throw new ReviewInputError(freshBlock, 409);
      const nextZh = prepared.segmentsZh.map(cue => ({ ...cue }));
      const items: Array<{ cueIndex: number; sourceText: string; previousText: string | null; nextText: string }> = [];
      const identical: number[] = [];
      for (const item of approved) {
        const target = nextZh[item.cueIndex];
        if (!target || prepared.segments[item.cueIndex]?.text !== item.source) throw new ReviewInputError(`第 ${item.cueIndex + 1} 句的原文已變更，未套用任何句子。`, 409);
        const nextText = item.candidate.trim();
        if (!nextText || /[\r\n]/.test(nextText)) throw new ReviewInputError(`第 ${item.cueIndex + 1} 句的候選格式無效，未套用任何句子。`, 422);
        if (target.text.trim() === nextText) { identical.push(item.cueIndex); continue; }
        items.push({ cueIndex: item.cueIndex, sourceText: item.source, previousText: target.text, nextText });
        target.text = nextText;
      }
      if (identical.length) this.deps.store.markApplied(row.id, sourceHash, identical);
      if (!items.length) return;
      const updated = this.deps.db.prepare('UPDATE summaries SET segments_zh=?, transcript_zh=? WHERE id=? AND segments_zh=?')
        .run(JSON.stringify(nextZh), nextZh.map(cue => cue.text).join(' '), row.id, row.segments_zh);
      if (updated.changes !== 1) throw new ReviewInputError('中譯在套用時被其他工作更動，未寫入任何句子；請重新整理後再套用。', 409);
      this.deps.store.recordApplied(row.id, sourceHash, batchId, items, appliedAt);
      this.deps.store.setExportError(row.id, null);
      written = { nextZh, items: items.length, batchId };
    })();
    return written;
  }

  revertLast(id: string): { reverted: number; exportError: string | null; response: ReviewResponse } {
    const row = this.loadRow(id);
    const block = this.writeBlock(row);
    if (block) throw new ReviewInputError(block, 409);
    const batch = this.deps.store.lastBatch(row.id);
    if (!batch) throw new ReviewInputError('沒有可還原的套用紀錄。', 404);
    const prepared = this.prepare(row);
    if (batch.sourceHash !== prepared.sourceHash) throw new ReviewInputError('原文字幕在套用後已變更，這一批無法安全還原。', 409);
    let nextZh: Segment[] | null = null;
    this.deps.db.transaction(() => {
      const fresh = this.freshRow(row.id);
      if (fresh.segments !== row.segments || fresh.segments_zh !== row.segments_zh) throw new ReviewInputError('字幕在還原前被其他工作更動，未還原任何句子；請重新整理。', 409);
      const freshBlock = this.writeBlock(fresh);
      if (freshBlock) throw new ReviewInputError(freshBlock, 409);
      const restored = prepared.segmentsZh.map(cue => ({ ...cue }));
      for (const item of batch.items) {
        const target = restored[item.cueIndex];
        if (!target) throw new ReviewInputError('字幕句數已變更，無法還原。', 409);
        if (target.text !== item.nextText) throw new ReviewInputError(`第 ${item.cueIndex + 1} 句在套用後又被改過，未還原任何句子。`, 409);
        target.text = item.previousText ?? target.text;
      }
      const updated = this.deps.db.prepare('UPDATE summaries SET segments_zh=?, transcript_zh=? WHERE id=? AND segments_zh=?')
        .run(JSON.stringify(restored), restored.map(cue => cue.text).join(' '), row.id, row.segments_zh);
      if (updated.changes !== 1) throw new ReviewInputError('字幕在還原時被其他工作更動，未還原任何句子；請重新整理。', 409);
      this.deps.store.recordReverted(row.id, batch.batchId, batch.sourceHash, batch.items.map(item => item.cueIndex));
      this.deps.store.setExportError(row.id, null);
      nextZh = restored;
    })();
    const exportError = this.exportSubtitleFiles(row, prepared.segments, nextZh!);
    if (exportError) this.deps.store.setExportError(row.id, exportError);
    return { reverted: batch.items.length, exportError, response: this.get(id) };
  }

  /** 交易內重讀整列，用來重驗字幕字串與工作狀態。 */
  private freshRow(id: string): ReviewSourceRow {
    const fresh = this.deps.db.prepare('SELECT * FROM summaries WHERE id=?').get(id) as ReviewSourceRow | undefined;
    if (!fresh) throw new ReviewInputError('找不到這部影片。', 404);
    return fresh;
  }

  /**
   * 已寫回的句子被其他工作覆蓋後（例如整片重新翻譯），只把這些漂移的句子重新標成已採用並再套用。
   * 重新標記與套用在同一個交易：套用失敗（409）時決定狀態一併回滾，漂移提醒不會消失。
   */
  reapply(id: string, sourceHash: string): { applied: number; batchId: string | null; exportError: string | null; response: ReviewResponse } {
    const row = this.loadRow(id);
    const block = this.writeBlock(row);
    if (block) throw new ReviewInputError(block, 409);
    const prepared = this.prepare(row);
    if (sourceHash !== prepared.sourceHash) throw new ReviewInputError('原文字幕已變更，請重新校訂後再套用。', 409);
    const drifted = this.get(id).candidates.filter(item => item.decision === 'applied' && item.changed).map(item => item.cueIndex);
    if (!drifted.length) return { applied: 0, batchId: null, exportError: null, response: this.get(id) };
    const written = this.deps.db.transaction(() => {
      this.deps.store.decide(row.id, sourceHash, drifted, 'approved', { includeApplied: true });
      return this.applyWithinTransaction(row, prepared, sourceHash, drifted);
    })();
    if (!written) return { applied: 0, batchId: null, exportError: null, response: this.get(id) };
    const exportError = this.exportSubtitleFiles(row, prepared.segments, written.nextZh);
    if (exportError) this.deps.store.setExportError(row.id, exportError);
    return { applied: written.items, batchId: written.batchId, exportError, response: this.get(id) };
  }

  /** 資料庫已更新但字幕檔沒寫成功時，用目前資料庫內容重新匯出。 */
  exportAgain(id: string): ReviewResponse {
    const row = this.loadRow(id);
    const prepared = this.prepare(row);
    const exportError = this.exportSubtitleFiles(row, prepared.segments, prepared.segmentsZh);
    this.deps.store.setExportError(row.id, exportError);
    return this.get(id);
  }

  /**
   * 只有已經有中譯字幕檔的影片才重寫；失敗回傳說明，不吞。
   * 寫檔前再從資料庫讀一次最新中譯：匯出永遠反映資料庫當下，不用呼叫端可能已過時的快照。
   */
  private exportSubtitleFiles(row: ReviewSourceRow, segments: Segment[], segmentsZh: Segment[]): string | null {
    if (!row.srt_zh_path) return null;
    const root = this.deps.projectRoot ?? process.cwd();
    const outputDir = path.join(root, 'public', 'burned', row.video_id);
    try {
      const latest = this.deps.db.prepare('SELECT segments, segments_zh FROM summaries WHERE id=?').get(row.id) as { segments: string | null; segments_zh: string | null } | undefined;
      const latestSegments = latest ? parseSegments(latest.segments) : null;
      const latestZh = latest ? parseSegments(latest.segments_zh) : null;
      const useLatest = latestSegments && latestZh && latestSegments.length === latestZh.length && latestSegments.every(validSegment) && latestZh.every(validSegment);
      fs.mkdirSync(outputDir, { recursive: true });
      writeSubtitleFiles({ segments: useLatest ? latestSegments : segments, segmentsZh: useLatest ? latestZh : segmentsZh, wasTranslated: true, outputDir, contentId: row.video_id });
      return null;
    } catch (error) {
      return `字幕檔（SRT／VTT）重寫失敗：${error instanceof Error ? error.message : '未知錯誤'}。資料庫已更新，請按「重新匯出字幕檔」重試。`;
    }
  }

  candidatesFor(id: string): ReviewCandidate[] { const row = this.loadRow(id); return this.deps.store.candidates(row.id, this.prepare(row).sourceHash); }

  /** 測試與排程用的等待點，不是 HTTP 端點。 */
  async settled(id: string): Promise<void> { const row = this.loadRow(id); await this.tasks.get(row.id)?.completion; }
}
