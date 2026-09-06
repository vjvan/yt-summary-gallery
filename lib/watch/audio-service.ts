import { createHash, randomUUID } from 'node:crypto';
import { getGlossary } from '../glossary-store';
import type { Glossary } from '../glossary-defaults';
import { canonicalYouTubeUrl } from './source';
import { WatchError } from './errors';
import { translateWatchWindow } from './translator';
import { withVideoTermbase } from './termbase';
import { AudioUsageStore } from './audio-store';
import { validateAudioChunk } from './audio-upload';
import { probeAudio, transcribeAudioChunk } from './audio-transcribe';
import { transcribeLocalAudioChunk } from './audio-local-transcribe';
import { processingMode, watchProviderInfo } from './provider';
import type { AudioChunkInput, AudioChunkResult, AudioSessionView } from './audio-types';
import type { WatchCue, WatchSource } from './types';

const bounded = (value: string | undefined, fallback: number, max: number) => {
  const n = Number(value); return Number.isInteger(n) && n >= 2 ? Math.min(n, max) : fallback;
};
export const audioLimits = () => ({
  sessionChunks: bounded(process.env.WATCH_AUDIO_SESSION_CHUNK_LIMIT, 10, 20),
  dailyChunks: bounded(process.env.WATCH_AUDIO_DAILY_CHUNK_LIMIT, 40, 200),
});
interface RecordResult { fingerprint: string; promise?: Promise<AudioChunkResult>; result?: AudioChunkResult; error?: unknown }
interface AudioSession {
  videoId: string; title: string; glossary: Glossary; limit: number | null; used: number; accessed: number;
  mode: 'local' | 'cloud';
  records: Map<string, RecordResult>; fingerprints: Map<string, RecordResult>;
  context: WatchCue[]; controller?: AbortController;
}
interface Dependencies {
  store: AudioUsageStore; probe: typeof probeAudio; transcribe: typeof transcribeAudioChunk;
  transcribeLocal?: typeof transcribeAudioChunk; mode?: () => 'local' | 'cloud';
  translate: typeof translateWatchWindow; glossary: () => Glossary; enabled: () => boolean;
  limits: () => { sessionChunks: number; dailyChunks: number };
}
export class AudioWatchService {
  private sessions = new Map<string, AudioSession>();
  private active = 0;
  private localDay = '';
  private localCalls = 0;
  constructor(private deps: Dependencies) {}
  private mode() { return this.deps.mode?.() || 'cloud'; }
  private localUsed(increment = false) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    if (day !== this.localDay) { this.localDay = day; this.localCalls = 0; }
    if (increment) this.localCalls++;
    return this.localCalls;
  }
  /** Keep only recent local dedupe/results. Unlimited duration must not mean unlimited RAM. */
  private trimLocalRecords(session: AudioSession) {
    if (session.mode !== 'local') return;
    while (session.records.size >= 96) {
      const oldest = [...session.records.values()].find(record => !record.promise);
      if (!oldest) break;
      for (const [id, record] of session.records) if (record === oldest) session.records.delete(id);
      session.fingerprints.delete(oldest.fingerprint);
    }
  }
  start(input: { url: string; title?: string; confirmAudio: boolean; maxChunks: number }): AudioSessionView {
    const mode = this.mode();
    if (input.confirmAudio !== true) throw new WatchError('AUDIO_CONSENT_REQUIRED', mode === 'local' ? '請先同意由本機處理分頁音訊、辨識與翻譯。' : '請先同意傳送分頁音訊、辨識與翻譯費用。', 403);
    const unlimited = mode === 'local' && input.maxChunks === 0;
    if (!Number.isInteger(input.maxChunks) || (!unlimited && (input.maxChunks < 2 || input.maxChunks > 20))) throw new WatchError('AUDIO_INVALID_LIMIT', mode === 'local' ? '本機音訊工作可設 0 表示不限段數，或設定 2 至 20 段。' : '單次音訊工作上限須介於 2 至 20 段。');
    const canonical = canonicalYouTubeUrl(input.url);
    if (!this.deps.enabled()) throw new WatchError('MODEL_NOT_CONFIGURED', mode === 'local' ? '尚未設定本機音訊辨識與翻譯模型；不會改用雲端。' : '伺服器尚未設定音訊辨識與翻譯金鑰。', 503);
    if (mode === 'local' && !this.deps.transcribeLocal) throw new WatchError('LOCAL_AUDIO_NOT_CONFIGURED', '尚未設定本機 Whisper；不會改用雲端。', 503);
    this.sweep();
    if (this.sessions.size >= 4) throw new WatchError('AUDIO_BUSY', '音訊工作數量已達上限，請先停止其他工作。', 503);
    const limits = this.deps.limits();
    if (mode === 'cloud' && this.deps.store.used() >= limits.dailyChunks) throw new WatchError('AUDIO_DAILY_LIMIT', '已達每日音訊辨識上限。', 429);
    const audioSessionId = randomUUID();
    const sessionChunks = unlimited ? null : mode === 'local' ? input.maxChunks : Math.min(input.maxChunks, limits.sessionChunks);
    this.sessions.set(audioSessionId, {
      videoId: canonical.videoId, title: (input.title || canonical.videoId).slice(0, 300),
      glossary: withVideoTermbase(structuredClone(this.deps.glossary())), limit: sessionChunks, mode, used: 0, accessed: Date.now(),
      records: new Map(), fingerprints: new Map(), context: [],
    });
    return { audioSessionId, videoId: canonical.videoId, sourceLanguage: 'en', processingMode: mode, unlimited,
      limits: { sessionChunks, dailyChunks: mode === 'local' ? null : limits.dailyChunks, maxChunkSeconds: 15 } };
  }
  private session(id: string): AudioSession {
    const session = this.sessions.get(id);
    if (!session || Date.now() - session.accessed > 30 * 60_000) {
      this.stop(id);
      throw new WatchError('AUDIO_SESSION_EXPIRED', '音訊工作已停止或逾時，請重新啟動收音。', 410);
    }
    session.accessed = Date.now(); return session;
  }
  async chunk(input: AudioChunkInput, signal?: AbortSignal): Promise<AudioChunkResult> {
    validateAudioChunk(input);
    const session = this.session(input.audioSessionId);
    if (session.mode !== this.mode()) throw new WatchError('AUDIO_PROVIDER_CHANGED', '處理模式已變更；請重新啟動音訊工作，不會自動切換到其他提供者。', 409);
    signal?.throwIfAborted();
    const fingerprint = createHash('sha256').update(`${input.start}|${input.end}|${input.mime}|`).update(input.bytes).digest('hex');
    const previous = session.records.get(input.chunkId);
    if (previous && previous.fingerprint !== fingerprint) throw new WatchError('AUDIO_CHUNK_CONFLICT', '相同片段編號不得改用不同音訊或時間。', 409);
    if (session.mode === 'cloud' && !previous && session.records.size >= 40) throw new WatchError('AUDIO_SESSION_LIMIT', '音訊片段嘗試過多，請停止並檢查收音設定。', 429);
    const duplicate = previous || session.fingerprints.get(fingerprint);
    const dailyUsed = () => session.mode === 'local' ? this.localUsed() : this.deps.store.used();
    const wrap = (result: AudioChunkResult, cached: boolean): AudioChunkResult => ({ ...result, chunkId: input.chunkId, cached, usage: { sessionChunks: session.used, dailyChunks: dailyUsed() } });
    if (duplicate) {
      this.trimLocalRecords(session);
      session.records.set(input.chunkId, duplicate);
      session.fingerprints.set(fingerprint, duplicate);
      if (duplicate.error) throw duplicate.error;
      if (duplicate.result) return wrap(duplicate.result, true);
      if (duplicate.promise) return wrap(await duplicate.promise, true);
    }
    if (session.controller || this.active >= 2) throw new WatchError('AUDIO_BUSY', '上一段音訊仍在辨識或翻譯，請稍後再送。', 503);
    if (session.limit !== null && session.used >= session.limit) throw new WatchError('AUDIO_SESSION_LIMIT', '已達這次收音的片段上限，已完成字幕仍可觀看。', 429);
    if (!this.deps.enabled()) throw new WatchError('MODEL_NOT_CONFIGURED', session.mode === 'local' ? '本機模型未設定；不會改用雲端。' : '伺服器尚未設定音訊辨識與翻譯金鑰。', 503);
    const transcribe = session.mode === 'local' ? this.deps.transcribeLocal : this.deps.transcribe;
    if (!transcribe) throw new WatchError('LOCAL_AUDIO_NOT_CONFIGURED', '本機 Whisper 未設定；不會改用雲端。', 503);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    // Bound the complete pipeline for direct requests too. Async jobs also cap at 110s;
    // Chrome's overall 120s budget leaves time to receive the final job response.
    const pipelineTimeout = setTimeout(() => controller.abort(), 110_000);
    session.controller = controller; this.active++;
    const record: RecordResult = { fingerprint };
    this.trimLocalRecords(session);
    session.records.set(input.chunkId, record); session.fingerprints.set(fingerprint, record);
    const promise = (async () => {
      try {
        await this.deps.probe(input, controller.signal);
        controller.signal.throwIfAborted();
        // Reserve immediately before the first billable call. Never refund uncertain failure or cancellation.
        if (session.mode === 'cloud') this.deps.store.reserve(this.deps.limits().dailyChunks);
        else this.localUsed(true);
        session.used++;
        const originalCues = await transcribe(input, fingerprint, controller.signal);
        controller.signal.throwIfAborted();
        let cues: AudioChunkResult['cues'] = [];
        if (originalCues.length) {
          const last = session.context.at(-1);
          const before = last && last.end <= input.start + 0.2 && input.start - last.end <= 3 ? session.context.slice(-2) : [];
          const source: WatchSource = { videoId: session.videoId, title: session.title, language: 'en', sourceKind: 'automatic', trackId: `audio:${fingerprint}`, cues: originalCues };
          // Local inference needs its own 90s budget, not the cloud adapter's 45s cap.
          // The complete ASR + translation pipeline still cannot exceed 110s.
          const translateSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(session.mode === 'local' ? 90_000 : 45_000)]);
          cues = await this.deps.translate({ source, targets: originalCues, before, after: [], glossary: session.glossary, signal: translateSignal });
          controller.signal.throwIfAborted();
          session.context = originalCues.slice(-2);
        } else session.context = [];
        const result: AudioChunkResult = { audioSessionId: input.audioSessionId, chunkId: input.chunkId, cues, originalCues,
          usage: { sessionChunks: session.used, dailyChunks: dailyUsed() }, cached: false };
        record.result = result; return result;
      } catch (error) {
        const safe = error instanceof WatchError ? error : controller.signal.aborted
          ? new WatchError('CANCELLED', session.mode === 'local' ? '本機音訊工作已取消，沒有雲端 API 費用。' : '音訊工作已取消；已送出的請求仍可能計費。', 409)
          : new WatchError('AUDIO_FAILED', session.mode === 'local' ? '本機音訊辨識或翻譯未完成；不會改用雲端。' : '音訊辨識或翻譯未完成；若已送交模型，本段仍計入使用量。', 502);
        record.error = safe; throw safe;
      } finally {
        clearTimeout(pipelineTimeout);
        signal?.removeEventListener('abort', abort); this.active--;
        if (session.controller === controller) session.controller = undefined;
        record.promise = undefined;
      }
    })();
    record.promise = promise;
    return promise;
  }
  stop(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.controller?.abort(); session.context = []; session.records.clear(); session.fingerprints.clear();
    this.sessions.delete(id);
  }
  private sweep() { for (const [id, session] of this.sessions) if (Date.now() - session.accessed > 30 * 60_000) this.stop(id); }
}
const runtime = globalThis as typeof globalThis & { __ytAudioWatchService?: AudioWatchService };
export function audioWatchService() {
  return runtime.__ytAudioWatchService ??= new AudioWatchService({ store: new AudioUsageStore(), probe: probeAudio, transcribe: transcribeAudioChunk,
    transcribeLocal: transcribeLocalAudioChunk, mode: processingMode,
    translate: translateWatchWindow, glossary: getGlossary, enabled: () => { const info = watchProviderInfo(); return info.translationConfigured && info.audioConfigured; }, limits: audioLimits });
}
