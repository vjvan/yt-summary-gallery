import type { requestLocalTranslation } from '../watch/local-translator';
import { LearningStore } from './store';
import { prepareLearningSource, chunkLearningSource, learningSourceHash, type LearningSourceInput } from './source';
import { runLearningPipeline, LearningPipelineError } from './pipeline';
import { LearningInputError, parseLearningPatch } from './validation';
import { LEARNING_VERSION } from './types';
import type { LearningResponse } from './types';
interface LearningServiceDependencies {
  store: LearningStore;
  source: (id: string) => LearningSourceInput | undefined;
  model: () => string;
  request: typeof requestLocalTranslation;
}
/** One local process retains AbortControllers; SQLite lease protects cross-process re-entry.
 * A restart is never silently resumed: after lease expiry the UI offers a manual retry. */
export class LearningService {
  private tasks = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  constructor(private deps: LearningServiceDependencies) {}
  private assertExists(id: string) {
    const source = this.deps.source(id);
    if (!source) throw new LearningInputError('找不到這部影片。', 404);
    return source;
  }
  get(id: string): LearningResponse {
    const source = this.assertExists(id); const response = this.deps.store.get(id);
    if (response.analysis && response.status !== 'running') {
      let model: string;
      try { model = this.deps.model(); } catch { return { ...response, status: 'partial', error: '[LOCAL_CONFIG_INVALID] 本機模型設定無效；保留上次分析，修正設定後可手動重試。' }; }
      if (response.analysis.sourceHash !== learningSourceHash(source) || response.analysis.version !== LEARNING_VERSION || response.analysis.model !== model) {
        return { ...response, status: response.status === 'failed' || response.status === 'cancelled' ? response.status : 'partial', error: `${response.error ? `${response.error} ` : ''}[STALE_ANALYSIS] 原文、模型或分析規則已變更；下方保留上次分析供參考，請手動重新分析。` };
      }
    }
    return response;
  }
  generate(id: string): { accepted: boolean; response: LearningResponse } {
    const raw = this.assertExists(id);
    let source;
    try { source = prepareLearningSource(raw); chunkLearningSource(source); }
    catch (error) { throw new LearningInputError(error instanceof Error ? error.message : '逐字稿無法分析。', 422); }
    const model = this.deps.model();
    const started = this.deps.store.start(id, source.hash, model);
    if (!started.started || !started.token) return { accepted: this.deps.store.get(id).status === 'running', response: this.deps.store.get(id) };
    const token = started.token; const controller = new AbortController();
    const checkActive = () => {
      if (!this.deps.store.active(id, token)) controller.abort();
      controller.signal.throwIfAborted();
    };
    const completion = Promise.resolve().then(async () => {
      checkActive();
      const result = await runLearningPipeline(source, { model, request: this.deps.request, signal: controller.signal,
        load: key => this.deps.store.checkpoint(id, key),
        save: (key, value) => { checkActive(); this.deps.store.saveCheckpoint(id, token, key, value); },
        progress: value => { checkActive(); this.deps.store.progress(id, token, value); },
      });
      checkActive(); this.deps.store.finish(id, token, result.analysis, result.partial);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) this.deps.store.fail(id, token, error instanceof LearningPipelineError ? `[${error.code}] ${error.message}` : `[LEARNING_INCOMPLETE] 本機學習分析尚未完成；先前分析與有效檢查點均保留。請確認 Ollama 模型可用後手動重試，不會改送雲端。`);
    }).finally(() => { if (this.tasks.get(id)?.controller === controller) this.tasks.delete(id); });
    this.tasks.set(id, { controller, completion });
    return { accepted: true, response: this.deps.store.get(id) };
  }
  cancel(id: string): LearningResponse {
    this.assertExists(id); this.deps.store.cancel(id); this.tasks.get(id)?.controller.abort(); return this.deps.store.get(id);
  }
  patch(id: string, body: unknown): LearningResponse {
    const source = this.assertExists(id); const parsed = parseLearningPatch(body);
    if (parsed.sourceHash !== learningSourceHash(source)) throw new LearningInputError('來源逐字稿已變更，請重新分析後再儲存。', 409);
    this.deps.store.patch(id, parsed); return this.get(id);
  }
  /** Deterministic orchestration/test hook, not an HTTP endpoint or automatic scheduler. */
  async settled(id: string): Promise<void> { await this.tasks.get(id)?.completion; }
}
