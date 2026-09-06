import { WatchError } from './errors';

const LOCAL_CHAT_URL = 'http://127.0.0.1:11434/api/chat';
const MAX_RESPONSE_BYTES = 256 * 1024;
export const LOCAL_TRANSLATION_TIMEOUT_MS = 90_000;

/** The endpoint is fixed, requests cannot redirect, and no credentials are sent. */
export async function requestLocalTranslation(input: {
  model: string; messages: { role: 'system' | 'user'; content: string }[];
  schema: object; signal?: AbortSignal; temperature?: 0 | 0.2;
  /** Optional server-only per-cue ceiling; other shared callers retain 6000. */
  maxOutputTokens?: number;
}): Promise<string> {
  const maxOutputTokens = input.maxOutputTokens ?? 6000;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 6000) throw new WatchError('LOCAL_MODEL_INVALID_LIMIT', '本機輸出長度設定無效。', 503);
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(LOCAL_TRANSLATION_TIMEOUT_MS)]) : AbortSignal.timeout(LOCAL_TRANSLATION_TIMEOUT_MS);
  try {
    signal.throwIfAborted();
    const response = await fetch(LOCAL_CHAT_URL, {
      method: 'POST', signal, cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: input.model, messages: input.messages, stream: false, format: input.schema,
        options: { temperature: input.temperature ?? 0.2, num_predict: maxOutputTokens, num_ctx: 8192 }, keep_alive: '5m' }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new WatchError('LOCAL_MODEL_NOT_FOUND', '找不到本機翻譯模型，請先在 Ollama 安裝所設定的模型；不會改送雲端。', 503);
      throw new WatchError('LOCAL_MODEL_FAILED', '本機翻譯服務回應失敗，請檢查 Ollama；不會改送雲端。', 502);
    }
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new WatchError('LOCAL_MODEL_FAILED', '本機翻譯回應超過安全大小，這一批未寫入成功快取。', 502);
    }
    if (!response.body) throw new WatchError('LOCAL_MODEL_FAILED', '本機翻譯回應為空白。', 502);
    const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new WatchError('LOCAL_MODEL_FAILED', '本機翻譯回應超過安全大小，這一批未寫入成功快取。', 502);
        parts.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const data: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new WatchError('LOCAL_MODEL_FAILED', '本機翻譯回應格式無效。', 502);
    const result = data as { done?: unknown; done_reason?: unknown; message?: { content?: unknown }; error?: unknown };
    // A provider-confirmed output limit is a content failure, not a network
    // failure. Never return or salvage its possibly valid-looking JSON prefix.
    if (!result.error && result.done === true && result.done_reason === 'length') throw new WatchError('LOCAL_TRANSLATION_TRUNCATED', '本機翻譯輸出達到安全長度上限，尚未完整完成。', 502);
    if (result.error || result.done !== true || (result.done_reason !== undefined && result.done_reason !== 'stop')
      || typeof result.message?.content !== 'string' || !result.message.content.trim()) {
      throw new WatchError('LOCAL_MODEL_FAILED', '本機翻譯輸出未完整完成，這一批未寫入成功快取。', 502);
    }
    return result.message.content;
  } catch (error) {
    if (input.signal?.aborted) throw new WatchError('CANCELLED', '已取消本機翻譯。', 499);
    if (error instanceof WatchError) throw error;
    throw new WatchError('LOCAL_MODEL_UNAVAILABLE', '無法連線到本機 Ollama，或翻譯等待逾時。請確認服務與模型已啟動；不會改送雲端。', 503);
  }
}
