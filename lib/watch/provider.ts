import { WatchError } from './errors';
import { localWhisperConfigured } from './audio-local-transcribe';
import type { WatchProcessingMode, WatchProviderInfo } from './types';

/** No implicit cloud fallback: a server operator must explicitly choose cloud mode. */
export function processingMode(): WatchProcessingMode {
  return process.env.WATCH_PROCESSING_MODE?.trim().toLowerCase() === 'cloud' ? 'cloud' : 'local';
}
export function localTranslationModel(): string {
  const model = process.env.WATCH_LOCAL_MODEL?.trim() || 'qwen2.5:7b';
  // Only a local model name/tag, never a URL or an Ollama cloud-model alias.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}(?::[a-zA-Z0-9][a-zA-Z0-9._-]{0,39})?$/.test(model) || /cloud/i.test(model)) {
    throw new WatchError('LOCAL_MODEL_INVALID', '本機翻譯模型名稱無效，請設定已安裝的本機模型，不可使用雲端模型或網址。', 503);
  }
  return model;
}
/** Configuration only, not an online/loaded-model health probe. Never returns credentials. */
export function watchProviderInfo(): WatchProviderInfo {
  const mode = processingMode();
  if (mode === 'local') return {
    processingMode: mode, unlimited: true, translationModel: localTranslationModel(),
    translationConfigured: true, audioConfigured: localWhisperConfigured(),
  };
  const configured = Boolean(process.env.OPENAI_API_KEY?.trim());
  return { processingMode: mode, unlimited: false, translationModel: 'gpt-4o-mini', translationConfigured: configured, audioConfigured: configured };
}

/** Local availability probe only: no model inference and no cloud or redirect fallback. */
export async function watchProviderStatus(inputSignal?: AbortSignal): Promise<WatchProviderInfo> {
  const info = watchProviderInfo();
  if (info.processingMode === 'cloud') return { ...info, translationReady: info.translationConfigured,
    translationStatusMessage: info.translationConfigured ? '雲端翻譯金鑰已設定；此檢查未呼叫付費模型。' : '尚未設定雲端翻譯金鑰。' };
  const signal = inputSignal ? AbortSignal.any([inputSignal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000);
  const unavailable = (message: string): WatchProviderInfo => ({ ...info, translationReady: false, translationStatusMessage: message });
  try {
    signal.throwIfAborted();
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal, cache: 'no-store', redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length')) > 256 * 1024 || !response.body) {
      await response.body?.cancel();
      return unavailable('無法確認本機 Ollama 模型狀態，請檢查本機服務；不會改送雲端。');
    }
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) return unavailable('本機模型清單超過安全大小，暫時無法確認翻譯服務。');
        parts.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const data: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const models = data && typeof data === 'object' && !Array.isArray(data) ? (data as { models?: unknown }).models : undefined;
    if (!Array.isArray(models)) return unavailable('本機模型清單格式無效，請檢查 Ollama 服務。');
    const installed = models.some((model: unknown) => model && typeof model === 'object'
      && ((model as { name?: unknown }).name === info.translationModel || (model as { model?: unknown }).model === info.translationModel));
    return installed ? { ...info, translationReady: true, translationStatusMessage: '本機翻譯模型已安裝；首次推論可能仍需要載入時間。' }
      : unavailable(`尚未安裝本機翻譯模型 ${info.translationModel}，請安裝後重新載入影片。`);
  } catch {
    if (inputSignal?.aborted) throw new WatchError('CANCELLED', '已取消本機模型狀態檢查。', 499);
    return unavailable('本機 Ollama 尚未啟動、無法連線或狀態檢查逾時，請啟動服務後重新載入影片；不會改送雲端。');
  }
}
