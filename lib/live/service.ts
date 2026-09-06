import { createHash, randomUUID } from 'node:crypto';
import { getGlossary } from '../glossary-store';
import type { Glossary } from '../glossary-defaults';
import { WatchError } from '../watch/errors';
import { watchProviderInfo, watchProviderStatus } from '../watch/provider';
import { probeAudio } from '../watch/audio-transcribe';
import { transcribeLocalAudioChunk } from '../watch/audio-local-transcribe';
import { translateWatchWindow } from '../watch/translator';
import { withVideoTermbase } from '../watch/termbase';
import type { AudioChunkInput } from '../watch/audio-types';
import type { TranslatedCue, WatchProviderInfo, WatchSource } from '../watch/types';
import { canonicalDiscordUrl, validateLiveChunk, validateLiveId, validateReplyInput, validateStopInput } from './input';
import { draftLiveReply, validateLiveReply } from './reply';
import type { LiveChunkInput, LiveChunkResult, LiveChunkView, LiveGap, LiveReplyDraft, LiveReplyInput, LiveSessionDetail, LiveSessionMetadata, LiveStopInput, LiveStopReason } from './types';

const RETENTION_MS = 30 * 60_000;
const MAX_SESSIONS = 10;
interface ChunkRecord { view: LiveChunkView; fingerprint: string; cueIds: string[]; promise?: Promise<LiveChunkResult>; failure?: WatchError }
interface Session {
  id: string; url: string; title: string; model: string; glossary: Glossary;
  createdAt: number; updatedAt: number; lastActivity: number;
  status: 'active' | 'stopped' | 'error'; stopReason?: string; unprocessedSeconds?: number;
  nextSequence: number; lastEnd: number;
  records: Map<number, ChunkRecord>; cues: TranslatedCue[]; gaps: LiveGap[]; drafts: LiveReplyDraft[];
  chunkController?: AbortController; replyController?: AbortController;
}
interface Dependencies {
  provider: () => WatchProviderInfo; readiness: (signal?: AbortSignal) => Promise<WatchProviderInfo>;
  probe: typeof probeAudio; transcribe: typeof transcribeLocalAudioChunk; translate: typeof translateWatchWindow;
  reply: typeof draftLiveReply; glossary: () => Glossary; now?: () => number;
}
const stopMessages: Record<LiveStopReason, string> = {
  user: '已由使用者停止收音。', 'source-closed': '來源分頁已關閉或離開 Discord 頻道。',
  'queue-overflow': '待處理音訊佇列已滿，已停止收音；未處理片段不會偽裝成完成字幕。',
  'permission-revoked': '分頁收音權限已取消。', 'capture-error': '分頁收音發生錯誤，已停止。',
  'server-unavailable': '本機服務無法連線，已停止收音。', 'mode-changed': '處理模式或模型已變更，已停止；不會將 Discord 音訊或逐字稿改送雲端。',
};

/** Local-only in-memory live branch. No Discord API, URL fetching, persistence or send action. */
export class LiveService {
  private sessions = new Map<string, Session>(); private starting = false;
  private audioActive = 0; private replyActive = 0;
  constructor(private deps: Dependencies) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  private local(session?: Session): WatchProviderInfo {
    const info = this.deps.provider();
    if (info.processingMode !== 'local' || (session && session.model !== info.translationModel)) {
      if (session) this.stopInternal(session, { reason: 'mode-changed' }, 'error');
      throw new WatchError('LIVE_LOCAL_ONLY', 'Discord 直播只支援全本機模式；模式或模型已變更，不會改送雲端。', 403);
    }
    return info;
  }
  private metadata(session: Session): LiveSessionMetadata {
    return { sessionId: session.id, url: session.url, title: session.title, source: 'discord', processingMode: 'local', unlimited: true,
      state: session.status === 'active' ? 'active' : 'stopped', status: session.status,
      createdAt: session.createdAt, updatedAt: session.updatedAt, nextSequence: session.nextSequence,
      processing: !!session.chunkController || !!session.replyController, audioProcessing: !!session.chunkController, replyProcessing: !!session.replyController,
      translationModel: session.model, ...(session.stopReason ? { stopReason: session.stopReason } : {}), ...(session.unprocessedSeconds !== undefined ? { unprocessedSeconds: session.unprocessedSeconds } : {}),
      limits: { maxChunkSeconds: 15, maxStoredChunks: 100, maxStoredCues: 500 },
    };
  }
  private sweep() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > RETENTION_MS) { session.chunkController?.abort(); session.replyController?.abort(); this.sessions.delete(id); }
    }
  }
  private getSession(id: string, active = false): Session {
    validateLiveId(id); this.sweep();
    const session = this.sessions.get(id);
    if (!session) throw new WatchError('LIVE_SESSION_EXPIRED', '直播工作已逾時或本機服務已重啟，請重新開始收音。', 410);
    if (active && session.status !== 'active') throw new WatchError('LIVE_SESSION_STOPPED', '直播收音已停止；已完成逐字稿仍保留供閱讀。', 410);
    return session;
  }
  async start(input: { url: string; title?: string; confirmAudio: boolean }, signal?: AbortSignal): Promise<LiveSessionMetadata> {
    this.local();
    if (input.confirmAudio !== true) throw new WatchError('LIVE_CONSENT_REQUIRED', '請先明確同意擷取此 Discord 分頁音訊並在本機辨識與翻譯。', 403);
    const url = canonicalDiscordUrl(input.url);
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 300)) throw new WatchError('LIVE_INVALID_TITLE', '直播標題最多 300 字。');
    this.sweep();
    if (this.starting || [...this.sessions.values()].some(session => session.status === 'active')) throw new WatchError('LIVE_BUSY', '第一版同時只收一個 Discord 分頁，請先停止目前工作。', 503);
    this.starting = true;
    try {
      const provider = await this.deps.readiness(signal); signal?.throwIfAborted(); this.local();
      if (provider.processingMode !== 'local') throw new WatchError('LIVE_LOCAL_ONLY', 'Discord 直播僅支援本機模式。', 403);
      if (!provider.audioConfigured) throw new WatchError('LIVE_NOT_READY', '本機 Whisper 模型或執行檔尚未設定，請先檢查本機語音辨識。', 503);
      if (!provider.translationConfigured || provider.translationReady === false) throw new WatchError('LIVE_NOT_READY', provider.translationStatusMessage || '本機翻譯模型尚未就緒，請先檢查本機服務。', 503);
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = [...this.sessions.values()].filter(session => session.status !== 'active' && this.now() - session.lastActivity >= 5 * 60_000).sort((a, b) => a.lastActivity - b.lastActivity)[0];
        if (!oldest) throw new WatchError('LIVE_BUSY', '近期直播工作較多，請稍候再開新工作；已停止記錄至少保留 5 分鐘。', 503);
        oldest.replyController?.abort(); this.sessions.delete(oldest.id);
      }
      const now = this.now(), id = randomUUID();
      const session: Session = { id, url, title: input.title?.trim() || 'Discord 直播', model: provider.translationModel, glossary: withVideoTermbase(structuredClone(this.deps.glossary())),
        createdAt: now, updatedAt: now, lastActivity: now, status: 'active', nextSequence: 0, lastEnd: 0,
        records: new Map(), cues: [], gaps: [], drafts: [],
      };
      this.sessions.set(id, session); return this.metadata(session);
    } finally { this.starting = false; }
  }
  list(): { sessions: LiveSessionMetadata[] } {
    this.sweep();
    for (const session of this.sessions.values()) { try { this.local(session); } catch { /* Preserve stopped/error metadata so Chrome stops capture. */ } }
    return { sessions: [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt).map(session => this.metadata(session)) };
  }
  get(id: string): LiveSessionDetail {
    const session = this.getSession(id);
    try { this.local(session); } catch { /* See list: never resume or use cloud. */ }
    return { ...this.metadata(session), cues: structuredClone(session.cues), chunks: [...session.records.values()].map(record => structuredClone(record.view)), gaps: structuredClone(session.gaps), drafts: structuredClone(session.drafts) };
  }
  private stopInternal(session: Session, input: LiveStopInput, status: 'stopped' | 'error' = 'stopped') {
    if (session.status === 'active') { session.status = status; session.updatedAt = this.now(); session.lastActivity = this.now(); session.stopReason = stopMessages[input.reason || 'user']; session.unprocessedSeconds = input.unprocessedSeconds; }
    session.chunkController?.abort(); session.replyController?.abort();
  }
  stop(id: string, input: LiveStopInput = {}): LiveSessionMetadata {
    validateStopInput(input); const session = this.getSession(id); this.stopInternal(session, input); return this.metadata(session);
  }
  private addGap(session: Session, gap: LiveGap) { session.gaps.push(gap); if (session.gaps.length > 100) session.gaps.splice(0, session.gaps.length - 100); }
  private chunkResult(session: Session, record: ChunkRecord, cached: boolean): LiveChunkResult {
    const cues = record.cueIds.map(id => session.cues.find(cue => cue.id === id));
    if (cues.some(cue => !cue)) throw new WatchError('LIVE_SEQUENCE_EXPIRED', '此片段已超過逐字稿保留範圍，無法重取；不會重複辨識舊音訊。', 410);
    const translated = cues as TranslatedCue[];
    return { sessionId: session.id, sequence: record.view.sequence, start: record.view.start, end: record.view.end, cues: structuredClone(translated),
      originalCues: translated.map(cue => ({ id: cue.id, start: cue.start, end: cue.end, text: cue.originalText })), cached,
      ...(record.view.gapBefore ? { gapBefore: structuredClone(record.view.gapBefore) } : {}),
    };
  }
  async chunk(input: LiveChunkInput, signal?: AbortSignal): Promise<LiveChunkResult> {
    validateLiveChunk(input); const session = this.getSession(input.sessionId, true); const provider = this.local(session); signal?.throwIfAborted();
    const fingerprint = createHash('sha256').update(`${input.sequence}|${input.start}|${input.end}|${input.gapReason || ''}|`).update(input.bytes).digest('hex');
    const previous = session.records.get(input.sequence);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new WatchError('LIVE_SEQUENCE_CONFLICT', '相同序號不得改用不同音訊、時間或空白原因。', 409);
      if (previous.failure) throw previous.failure;
      if (previous.promise) { await previous.promise; signal?.throwIfAborted(); return this.chunkResult(session, previous, true); }
      return this.chunkResult(session, previous, true);
    }
    if (input.sequence < session.nextSequence) throw new WatchError('LIVE_SEQUENCE_EXPIRED', '此序號已處理或超過保留範圍；不會重複辨識。', 410);
    if (input.start + 0.000002 < session.lastEnd) throw new WatchError('LIVE_OUT_OF_ORDER', '音訊時鐘重疊或倒退，請維持同一分頁的樣本時鐘。', 409);
    if (session.chunkController || this.audioActive >= 1) throw new WatchError('LIVE_BUSY', '上一段直播音訊仍在辨識，請保持有界佇列，勿重複平行上傳。', 503);
    if (!provider.audioConfigured || !provider.translationConfigured) throw new WatchError('LIVE_NOT_READY', '本機辨識或翻譯設定已失效，未送出音訊。', 503);
    const missingSequences = input.sequence - session.nextSequence;
    const gap: LiveGap | undefined = missingSequences > 0 || input.start - session.lastEnd > 0.002
      ? { start: session.lastEnd, end: input.start, reason: missingSequences > 0 ? 'missing-chunks' : input.gapReason || 'capture-gap', ...(missingSequences > 0 ? { missingSequences } : {}) } : undefined;
    const record: ChunkRecord = { fingerprint, cueIds: [], view: { sequence: input.sequence, start: input.start, end: input.end, status: 'processing', ...(gap ? { gapBefore: gap } : {}) } };
    if (gap) this.addGap(session, gap);
    while (session.records.size >= 100) session.records.delete(session.records.keys().next().value!);
    session.records.set(input.sequence, record); session.nextSequence = input.sequence + 1; session.lastEnd = input.end; session.updatedAt = this.now(); session.lastActivity = this.now();
    const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 110_000); const began = this.now();
    session.chunkController = controller; this.audioActive++;
    const audio: AudioChunkInput = { audioSessionId: session.id, chunkId: `live-${input.sequence}-${fingerprint.slice(0, 16)}`, start: 0, end: input.end - input.start, confirmAudio: true, bytes: input.bytes, mime: 'audio/wav' };
    const promise = (async () => {
      try {
        await this.deps.probe(audio, controller.signal); controller.signal.throwIfAborted(); this.local(session);
        const relative = await this.deps.transcribe(audio, fingerprint, controller.signal); controller.signal.throwIfAborted(); this.local(session);
        if (relative.length > 8 || relative.some(cue => !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || cue.end > audio.end || !cue.text.trim())) throw new WatchError('LIVE_ASR_FAILED', '辨識片段超出音訊樣本範圍，未寫入逐字稿。', 502);
        // Reuse the bounded clip-based ASR adapter without imposing its 6h video-time cap on live sample clocks.
        const originals = relative.map(cue => ({ ...cue, start: input.start + cue.start, end: input.start + cue.end }));
        let cues: TranslatedCue[] = [];
        if (originals.length) {
          const recent = session.cues.at(-1); const before = !gap && recent && input.start - recent.end <= 3 ? session.cues.slice(-2).map(cue => ({ ...cue, text: cue.originalText })) : [];
          const source: WatchSource = { videoId: session.id, title: session.title, language: 'en', sourceKind: 'automatic', trackId: `discord:${fingerprint}`, cues: originals };
          cues = await this.deps.translate({ source, targets: originals, before, after: [], glossary: session.glossary, signal: controller.signal, provider: { processingMode: 'local', translationModel: session.model } });
          controller.signal.throwIfAborted(); this.local(session);
          // Production translator already validates this; preserve the contract for injected providers too.
          if (cues.length !== originals.length || cues.some((cue, i) => cue.id !== originals[i].id || cue.start !== originals[i].start || cue.end !== originals[i].end || cue.originalText !== originals[i].text || !cue.text.trim())) throw new WatchError('LIVE_TRANSLATION_FAILED', '本機翻譯時間或片段不符，未寫入逐字稿。', 502);
          session.cues.push(...cues); if (session.cues.length > 500) session.cues.splice(0, session.cues.length - 500);
          record.cueIds = cues.map(cue => cue.id);
        }
        record.view.status = cues.length ? 'done' : 'silent'; record.view.processingMs = Math.max(0, this.now() - began); session.updatedAt = this.now(); session.lastActivity = this.now();
        return this.chunkResult(session, record, false);
      } catch (error) {
        const safe = error instanceof WatchError ? error : controller.signal.aborted ? new WatchError('CANCELLED', '直播片段已取消，未完成部分不會顯示成已翻譯。', 409) : new WatchError('LIVE_CHUNK_FAILED', '本機辨識或翻譯未完成；本段已標記缺漏，沒有改送雲端。', 502);
        record.failure = safe; record.view.status = 'error'; record.view.error = safe.message; record.view.processingMs = Math.max(0, this.now() - began);
        this.addGap(session, { start: input.start, end: input.end, reason: 'processing-failed' }); session.updatedAt = this.now();
        throw safe;
      } finally {
        clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.audioActive--; record.promise = undefined;
        if (session.chunkController === controller) session.chunkController = undefined;
      }
    })(); record.promise = promise; return promise;
  }
  async reply(input: LiveReplyInput, signal?: AbortSignal): Promise<LiveReplyDraft> {
    const tone = validateReplyInput(input); const session = this.getSession(input.sessionId); this.local(session); signal?.throwIfAborted();
    if (session.replyController || this.replyActive >= 1) throw new WatchError('LIVE_REPLY_BUSY', '上一份英文回覆草稿仍在準備，請稍候。', 503);
    const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), 110_000); session.replyController = controller; this.replyActive++; session.lastActivity = this.now();
    try {
      const english = await this.deps.reply({ text: input.text, tone, title: session.title, context: session.cues.slice(-8), glossary: session.glossary, model: session.model, signal: controller.signal });
      controller.signal.throwIfAborted(); this.local(session);
      const draft: LiveReplyDraft = { sessionId: session.id, draftId: randomUUID(), sourceText: input.text.trim(), english: validateLiveReply(JSON.stringify({ english })), tone, createdAt: this.now() };
      session.drafts.push(draft); if (session.drafts.length > 10) session.drafts.splice(0, session.drafts.length - 10);
      session.updatedAt = this.now(); session.lastActivity = this.now(); return structuredClone(draft);
    } catch (error) {
      if (error instanceof WatchError) throw error;
      throw new WatchError(controller.signal.aborted ? 'CANCELLED' : 'LIVE_REPLY_FAILED', controller.signal.aborted ? '英文回覆草稿已取消，沒有送出任何訊息。' : '本機英文草稿未完成，沒有送出任何訊息。', controller.signal.aborted ? 409 : 502);
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); this.replyActive--; if (session.replyController === controller) session.replyController = undefined; }
  }
}
const runtime = globalThis as typeof globalThis & { __ytLiveService?: LiveService };
export function liveService(): LiveService {
  return runtime.__ytLiveService ??= new LiveService({ provider: watchProviderInfo, readiness: watchProviderStatus, probe: probeAudio, transcribe: transcribeLocalAudioChunk,
    translate: translateWatchWindow, reply: draftLiveReply, glossary: getGlossary });
}
