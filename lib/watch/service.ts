import { createHash, randomUUID } from 'node:crypto';
import { getGlossary } from '../glossary-store';
import type { Glossary } from '../glossary-defaults';
import { fetchWatchSource, canonicalYouTubeUrl } from './source';
import { selectWindow } from './cues';
import { TRANSLATION_VERSION, translateWatchWindow } from './translator';
import { WatchStore, translationMatchesSource } from './store';
import { WatchError, LOCAL_QUALITY_REASONS, safeLocalQualityReason } from './errors';
import { withVideoTermbase } from './termbase';
import type { WatchSessionView, WatchSource, WatchWindowResult, WatchLimits, WatchProviderInfo, WatchCue, WatchCueFailure, TranslatedCue } from './types';
import { watchProviderInfo, watchProviderStatus } from './provider';
import { hasOrdinaryReactVerb, protectedNamesOnlyText } from './protected-terms';
import { libraryTranslations, type LibraryTranslations } from './library-lookup';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Only local cache semantics change. Existing cloud window keys/cost units remain unchanged.
const LOCAL_CUE_CACHE_SCHEMA = 'validated-source-cue-v1';
const reactSenseSuffix = (cue: WatchCue, glossary: Glossary) => hasOrdinaryReactVerb(cue, glossary) ? ':react-verb-v1' : '';
const cueKey = (prefix: string, cue: WatchCue, glossary: Glossary) => `${prefix}:cue:${cue.id}${reactSenseSuffix(cue, glossary)}`;
const boundedLimit = (value: string | undefined, fallback: number, max: number) => {
  const n = Number(value); return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};
export const watchLimits = (): WatchLimits => watchProviderInfo().processingMode === 'local' ? { sessionCalls: null, dailyCalls: null } : {
  sessionCalls: boundedLimit(process.env.WATCH_SESSION_CALL_LIMIT, 25, 100),
  dailyCalls: boundedLimit(process.env.WATCH_DAILY_CALL_LIMIT, 100, 500),
};

interface Session {
  source: WatchSource; glossary: Glossary; glossaryVersion: string; cachePrefix: string;
  calls: number; accessedAt: number; stopped: boolean; provider: WatchProviderInfo;
  /** 影片庫已翻好的字幕；有就優先用，命中句回寫快取，不跑模型。 */
  library: LibraryTranslations | null;
  job?: { windowKey: string; controller: AbortController; promise: Promise<WatchWindowResult> };
}
interface Dependencies {
  store: WatchStore;
  source: typeof fetchWatchSource;
  translate: typeof translateWatchWindow;
  glossary: () => Glossary;
  enabled: () => boolean;
  limits: () => WatchLimits;
  provider?: () => WatchProviderInfo;
  status?: (signal?: AbortSignal) => Promise<WatchProviderInfo>;
  /** 影片庫查詢；沒給就不查（測試或純即時模式）。 */
  library?: (videoId: string) => LibraryTranslations | null;
}

/** Request-driven bounded worker: current position first; never starts summary/cards/audio. */
export class WatchService {
  private sessions = new Map<string, Session>();
  private sources = new Map<string, { source: WatchSource; at: number }>();
  private sourceJobs = 0;
  private translating = new Set<string>();
  constructor(private deps: Dependencies) {}
  private provider() { return (this.deps.provider || watchProviderInfo)(); }
  private async status(signal?: AbortSignal): Promise<WatchProviderInfo> {
    if (this.deps.status) return this.deps.status(signal);
    // Test/injected providers have no external readiness probe unless explicitly supplied.
    if (this.deps.provider) { const info = this.provider(); return { ...info, translationReady: info.translationReady ?? info.translationConfigured }; }
    return watchProviderStatus(signal);
  }
  private limits(provider: WatchProviderInfo): WatchLimits {
    return provider.processingMode === 'local' ? { sessionCalls: null, dailyCalls: null } : this.deps.limits();
  }

  async start(url: string, language = 'en', signal?: AbortSignal): Promise<WatchSessionView> {
    const canonical = canonicalYouTubeUrl(url);
    let provider = this.provider();
    if (language !== 'en') throw new WatchError('LANGUAGE_UNSUPPORTED', '第一版先支援英文原文字幕。');
    this.sweep();
    if (this.sessions.size + this.sourceJobs >= 8 || this.sourceJobs >= 2) throw new WatchError('BUSY', '開啟的字幕工作太多，請先停止其他工作。', 503);
    this.sourceJobs++;
    let source: WatchSource;
    try {
      provider = await this.status(signal);
      const saved = this.sources.get(canonical.videoId);
      source = saved && Date.now() - saved.at < 5 * 60_000 ? saved.source : await this.deps.source(canonical.url, language, signal);
      signal?.throwIfAborted();
      this.sources.set(canonical.videoId, { source, at: Date.now() });
    } finally { this.sourceJobs--; }
    const glossary = withVideoTermbase(structuredClone(this.deps.glossary()));
    const glossaryVersion = hash(glossary);
    const sessionId = randomUUID();
    const library = this.deps.library?.(source.videoId) ?? null;
    const session: Session = {
      source, glossary, glossaryVersion, provider, library,
      cachePrefix: hash({ video: source.videoId, track: source.trackId, source: source.cues, target: 'zh-TW', glossaryVersion,
        provider: provider.processingMode, model: provider.translationModel, version: TRANSLATION_VERSION,
        ...(provider.processingMode === 'local' ? { cueCacheSchema: LOCAL_CUE_CACHE_SCHEMA } : {}) }),
      calls: 0, accessedAt: Date.now(), stopped: false,
    };
    this.sessions.set(sessionId, session);
    // 本機模式：影片庫是真相，先查庫（語意校訂或外部翻譯套用過的句子比舊快取好），命中就覆寫逐句快取；
    // 庫裡沒有的才看快取。整片都在庫裡時，擴充一句模型都不會叫。
    const cachedCues = provider.processingMode === 'local'
      ? source.cues.flatMap(cue => { const cached = this.fromLibrary(session, cue) ?? this.cachedCue(session, cue); return cached ? [cached] : []; })
      : undefined;
    return { ...source, ...provider, sessionId, glossaryVersion, translationEnabled: this.deps.enabled() && provider.translationConfigured && (provider.translationReady ?? true), limits: this.limits(provider),
      ...(cachedCues ? { cachedCues } : {}) };
  }

  /** 影片庫命中就寫進逐句快取（同一把鍵），下次直接命中快取；寫入失敗不影響回傳。 */
  /**
   * 庫內譯文的最低品質守門：舊管線失敗時會把英文原樣留著卻仍標成已翻譯，這種不能當命中。
   * 只看「整句有沒有中文」；譯文裡合理保留的品牌與工具名（podcast、HeyGen、vibe coding）是好譯文的一部分，
   * 不能拿逐句翻譯的殘留英文規則來擋。純保留名稱的句子（例如 Figma → Figma）本來就沒有中文，屬合法。
   */
  private usable(session: Session, cue: WatchCue, candidate: TranslatedCue): boolean {
    const letters = (cue.text.match(/[A-Za-z]/g) ?? []).length;
    return letters < 3 || /[㐀-鿿]/.test(candidate.text) || protectedNamesOnlyText(cue, session.glossary) !== null;
  }

  /**
   * 庫裡有這句、但內容沒通過守門（例如舊管線失敗留下的英文）：連快取也不信，交回模型。
   * 之前版本的庫內優先沒有守門，可能已經把同一份內容寫進逐句快取，換個讀取路徑就會復活。
   * 庫裡沒有這句的影片維持原本的快取語意，不重新驗證既有快取。
   */
  private libraryRejected(session: Session, cue: WatchCue): boolean {
    const hit = session.library?.find(cue);
    return !!hit && !this.usable(session, cue, hit);
  }

  /** 只有「庫內不合格」且「快取本身也不合格」才當成沒有；模型之後翻好的快取照常使用，不會反覆推論。 */
  private trusted(session: Session, cue: WatchCue, cached: TranslatedCue | undefined): TranslatedCue | undefined {
    if (!cached) return undefined;
    return this.libraryRejected(session, cue) && !this.usable(session, cue, cached) ? undefined : cached;
  }

  private cachedCue(session: Session, cue: WatchCue): TranslatedCue | undefined {
    return this.trusted(session, cue, this.deps.store.getCue(cueKey(session.cachePrefix, cue, session.glossary), cue));
  }

  private fromLibrary(session: Session, cue: WatchCue): TranslatedCue | undefined {
    const hit = session.library?.find(cue);
    if (!hit || !translationMatchesSource(hit, cue) || !this.usable(session, cue, hit)) return undefined;
    if (session.provider.processingMode === 'local') {
      try { this.deps.store.putCue(cueKey(session.cachePrefix, cue, session.glossary), cue, hit); } catch { /* 快取寫不進去仍可顯示 */ }
    }
    return hit;
  }

  private session(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.stopped || Date.now() - session.accessedAt > 2 * 60 * 60_000) throw new WatchError('SESSION_EXPIRED', '字幕工作已停止或逾時，請重新開啟影片。', 410);
    session.accessedAt = Date.now();
    return session;
  }

  async window(id: string, time: number, consent: boolean, signal?: AbortSignal): Promise<WatchWindowResult> {
    if (consent !== true) throw new WatchError('CONSENT_REQUIRED', '請先同意將原文字幕送交翻譯模型。', 403);
    if (!Number.isFinite(time) || time < 0 || time > 172800) throw new WatchError('INVALID_TIME', '播放時間不正確。');
    const session = this.session(id);
    const provider = this.provider();
    if (provider.processingMode !== session.provider.processingMode || provider.translationModel !== session.provider.translationModel) {
      session.job?.controller.abort();
      throw new WatchError('SESSION_PROVIDER_CHANGED', '翻譯模式或模型已變更，請重新開啟影片；不會自動切換處理方式。', 409);
    }
    const selected = selectWindow(session.source.cues, time);
    const { windowKey, targets, before, after } = selected;
    const local = provider.processingMode === 'local';
    // An affected old complete window must not bypass the corrected per-cue key.
    // All other cue/window keys, including every cloud key, remain unchanged.
    const key = `${session.cachePrefix}:${windowKey}${local && targets.some(cue => hasOrdinaryReactVerb(cue, session.glossary)) ? ':react-verb-v1' : ''}`;
    // 影片庫優先於整窗快取：這支影片先前預譯過的舊快取不能蓋掉之後套用的校訂或外部譯文。
    const libraryHits = session.library ? targets.map(cue => this.fromLibrary(session, cue)) : [];
    const libraryComplete = targets.length > 0 && libraryHits.length === targets.length && libraryHits.every(Boolean);
    // 本機模式部分命中就走逐句路徑（庫內句優先、其餘看逐句快取）；雲端模式整窗快取照舊，不然部分命中的窗每次重讀都再付一次費。
    // 整窗快取同理：只有庫內不合格且快取內容也不合格的句子才讓整窗失效。
    const rawWindow = local ? this.deps.store.getMatching(key, targets) : this.deps.store.get(key);
    const windowCache = rawWindow?.length === targets.length && rawWindow.some((item, position) => !this.trusted(session, targets[position], item)) ? undefined : rawWindow;
    const cached = local ? (libraryHits.some(Boolean) ? undefined : windowCache) : windowCache;
    const result = (cues: WatchWindowResult['cues'], cache: boolean, failedCues: WatchCueFailure[] = []): WatchWindowResult => ({
      sessionId: id, windowKey, cues, cached: failedCues.length ? false : cache,
      callsUsed: session.calls, dailyCallsUsed: this.deps.store.used(provider.processingMode),
      ...(local ? { complete: failedCues.length === 0 && cues.length === targets.length, failedCues } : {}),
    });
    // Supersede only other windows. A ready cache hit still cancels stale work.
    if (session.job && session.job.windowKey !== windowKey) session.job.controller.abort();
    if (libraryComplete) {
      const cues = libraryHits as TranslatedCue[];
      this.deps.store.put(key, cues);
      return result(cues, true);
    }
    if (cached || !targets.length) return result(cached || [], true);
    if (session.job?.windowKey === windowKey && !session.job.controller.signal.aborted) return session.job.promise;
    const savedCues = new Map<string, TranslatedCue>();
    if (local) {
      targets.forEach((cue, position) => {
        const saved = libraryHits[position] ?? this.cachedCue(session, cue);
        if (saved) savedCues.set(cue.id, saved);
      });
      // Reconstruct complete windows from the library plus validated cue cache without reserving work.
      if (savedCues.size === targets.length) {
        const cues = targets.map(cue => savedCues.get(cue.id)!);
        if (libraryHits.some(Boolean)) this.deps.store.put(key, cues);
        return result(cues, true);
      }
    }
    // 雲端模式只認整窗：整窗都在庫裡才用（上面已回傳），缺一句就照常送雲端。
    if (session.provider.translationReady === false) throw new WatchError(provider.processingMode === 'local' ? 'LOCAL_MODEL_UNAVAILABLE' : 'MODEL_NOT_CONFIGURED', session.provider.translationStatusMessage || '翻譯服務尚未就緒，請啟動服務後重新載入影片。', 503);
    if (!this.deps.enabled() || !provider.translationConfigured) throw new WatchError('MODEL_NOT_CONFIGURED', '尚未設定所選的後端翻譯服務；目前可觀看原文字幕。', 503);
    const limits = this.limits(provider);
    if (limits.sessionCalls !== null && session.calls >= limits.sessionCalls) throw new WatchError('SESSION_LIMIT', '已達本次觀看的翻譯批次上限；已完成的字幕仍可使用。', 429);
    if (this.translating.has(key) || this.translating.size >= 2) throw new WatchError('BUSY', '翻譯工作進行中，稍後會優先處理目前位置。', 503);
    signal?.throwIfAborted();
    this.deps.store.reserve(limits.dailyCalls, provider.processingMode);
    session.calls++;
    this.translating.add(key);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const promise = (async () => {
      try {
        if (local) {
          // All initial calls and each translator's bounded repair share this deadline.
          const deadline = AbortSignal.timeout(90_000);
          const batchSignal = AbortSignal.any([controller.signal, deadline]);
          const assertActive = () => {
            if (controller.signal.aborted || session.stopped || this.sessions.get(id) !== session) throw new WatchError('CANCELLED', '已取消本機逐句翻譯；未套用尚未完成的字幕。', 499);
            if (deadline.aborted) throw new WatchError('LOCAL_MODEL_TIMEOUT', '本機逐句翻譯超過整批 90 秒上限；已驗證的句子保留，未完成句子仍未成功。', 504);
            const current = this.provider();
            if (current.processingMode !== session.provider.processingMode || current.translationModel !== session.provider.translationModel) throw new WatchError('SESSION_PROVIDER_CHANGED', '翻譯模式或模型已變更，請重新開啟影片；不會自動切換處理方式。', 409);
          };
          const failedCues: WatchCueFailure[] = [];
          for (const cue of targets) {
            assertActive();
            if (savedCues.has(cue.id)) continue;
            try {
              const translated = await this.deps.translate({ source: session.source, targets: [cue], before, after,
                glossary: session.glossary, signal: batchSignal, provider: session.provider });
              assertActive();
              if (!Array.isArray(translated) || translated.length !== 1 || !translationMatchesSource(translated[0], cue)) {
                throw new WatchError('INVALID_TRANSLATION', '回傳字幕格式或來源不符，未寫入成功快取。', 502);
              }
              // Completed/validated before cancellation is durable; nothing writes after abort.
              this.deps.store.putCue(cueKey(session.cachePrefix, cue, session.glossary), cue, translated[0]);
              savedCues.set(cue.id, translated[0]);
            } catch (error) {
              assertActive();
              if (!(error instanceof WatchError) || error.code !== 'LOCAL_TRANSLATION_QUALITY') throw error;
              // Public failure metadata is source-owned; never leak model output in messages.
              const reason = safeLocalQualityReason(error.qualityReason);
              failedCues.push({ id: cue.id, start: cue.start, end: cue.end, code: 'LOCAL_TRANSLATION_QUALITY',
                reason, message: `本句${LOCAL_QUALITY_REASONS[reason]}；已保留原文，可手動重試此區段。` });
            }
          }
          assertActive();
          const cues = targets.flatMap(cue => { const saved = savedCues.get(cue.id); return saved ? [saved] : []; });
          if (!failedCues.length) this.deps.store.put(key, cues);
          return result(cues, false, failedCues);
        }
        const cues = await this.deps.translate({ source: session.source, targets, before, after, glossary: session.glossary, signal: controller.signal, provider: session.provider });
        controller.signal.throwIfAborted();
        this.deps.store.put(key, cues);
        return result(cues, false);
      } finally {
        signal?.removeEventListener('abort', abort);
        this.translating.delete(key);
        if (session.job?.controller === controller) session.job = undefined;
      }
    })();
    session.job = { windowKey, controller, promise };
    return promise;
  }

  stop(id: string) {
    const session = this.sessions.get(id);
    if (session) { session.stopped = true; session.job?.controller.abort(); this.sessions.delete(id); }
  }
  private sweep() {
    for (const [id, session] of this.sessions) if (Date.now() - session.accessedAt > 2 * 60 * 60_000) this.stop(id);
    for (const [id, source] of this.sources) if (Date.now() - source.at > 5 * 60_000) this.sources.delete(id);
  }
}

// Share across route bundles and development reloads. Captions cache/usage persist in SQLite;
// sessions intentionally expire on process restart and can be safely recreated.
const runtime = globalThis as typeof globalThis & { __ytWatchService?: WatchService };
export function watchService() {
  return runtime.__ytWatchService ??= new WatchService({ store: new WatchStore(), source: fetchWatchSource, translate: translateWatchWindow, glossary: getGlossary, enabled: () => watchProviderInfo().translationConfigured, limits: watchLimits, provider: watchProviderInfo, status: watchProviderStatus, library: libraryTranslations });
}
