/** 純 UI 前置條件，不讀伺服器設定，也不觸發翻譯。 */
export type WatchConsentState = 'demo' | 'loading' | 'stopped' | 'failed' | 'unloaded' | 'model-unavailable' | 'ready';
export interface WatchConsentGate {
  state: WatchConsentState;
  canConsent: boolean;
  title: string;
  description: string;
}
export function getWatchConsentGate(input: {
  demo: boolean;
  loading: boolean;
  stopped: boolean;
  sourceReady: boolean;
  modelEnabled: boolean;
  loadError: string;
  processingMode?: 'local' | 'cloud';
  unlimited?: boolean;
  translationStatusMessage?: string;
}): WatchConsentGate {
  if (input.demo) return {
    state: 'demo', canConsent: false, title: '示範模式，不會送出翻譯請求',
    description: '這裡使用內嵌示例，因此同意框與翻譯按鈕停用。切換到正式觀看頁後，先載入原文字幕。',
  };
  if (input.loading) return {
    state: 'loading', canConsent: false, title: '正在取得原文字幕，請稍候',
    description: '播放器可以先播放；取得可用的原文字幕後，才能勾選同意並啟用翻譯。',
  };
  if (input.stopped) return {
    state: 'stopped', canConsent: false, title: '本次工作已停止',
    description: '請按上方「載入影片與原文」建立新的工作，再重新勾選同意。',
  };
  if (input.loadError) return {
    state: 'failed', canConsent: false, title: '原文字幕取得失敗，尚不能啟用翻譯',
    description: input.loadError,
  };
  if (!input.sourceReady) return {
    state: 'unloaded', canConsent: false, title: '還沒有可用的原文字幕',
    description: '請先在上方貼上 YouTube 連結，按「載入影片與原文」。只有播放畫面出現，並不代表字幕已取得。',
  };
  if (!input.modelEnabled) return {
    state: 'model-unavailable', canConsent: false, title: input.processingMode === 'local' ? '原文已就緒，本機模型尚未就緒' : '原文已就緒，但翻譯模型尚未設定',
    description: input.processingMode === 'local' ? `${input.translationStatusMessage || '本機翻譯模型尚未就緒。'} 仍可同步看原文。請啟動並完成本機模型設定後重新載入；不會自動改用雲端或要求付費 API。` : '仍可同步看原文。請在本機服務端完成模型設定後，重新載入影片；不要把模型 API key 貼進本頁或 Chrome 配對碼。',
  };
  return {
    state: 'ready', canConsent: true, title: input.processingMode === 'local' ? '原文與本機翻譯設定已就緒' : '原文與翻譯服務已就緒',
    description: input.processingMode === 'local' ? '全本機、不按批次收費；勾選同意後可持續翻譯至停止。模型執行失敗會明確提示，不會回退雲端。' : '現在可以勾選下方同意框，再按「啟用同步翻譯」。未同意前不會呼叫翻譯模型。',
  };
}


/** Copy is based on server/session metadata, not client quota preferences. */
export interface WatchProcessingUiInfo {
  processingMode?: 'local' | 'cloud'; unlimited?: boolean; translationModel?: string; translationStatusMessage?: string;
  limits?: { sessionCalls: number | null; dailyCalls: number | null };
}
export const formatWatchLimit = (value: number | null | undefined) => value === null ? '不限' : value === undefined ? '待確認' : String(value);
export function getWatchProcessingCopy(info: WatchProcessingUiInfo) {
  const local = info.processingMode === 'local';
  return {
    local,
    banner: local ? `全本機、不按批次收費、${info.unlimited ? '持續翻譯至停止（不限總批數）' : '依本機工作設定處理'}。模型：${info.translationModel || '本機模型'}。${info.translationStatusMessage ? ` ${info.translationStatusMessage}` : ''}`
      : info.processingMode === 'cloud' ? `雲端處理模式：${info.translationModel || '已設定的模型'}；可能產生 API 費用。` : '正在確認後端處理模式；尚未啟用翻譯。',
    consent: local ? '我同意在這台電腦上處理這支影片的原文字幕、必要前後文與術語。資料不送外部翻譯 API，不按批次收費；可持續翻譯至停止，每批 8 段且一次只處理一批。'
      : `我允許將原文字幕、必要前後文與術語送至設定的雲端模型。可能產生 API 費用；本次最多 ${formatWatchLimit(info.limits?.sessionCalls)} 次、每日最多 ${formatWatchLimit(info.limits?.dailyCalls)} 次模型呼叫（不是金額上限）。`,
    stopping: local ? '本次本機工作已停止，已完成字幕保留在畫面。若要繼續，請重新載入影片。' : '本次工作已停止，已完成字幕保留在畫面。若要繼續，請重新載入影片。已送出的雲端請求仍可能計費。',
    processingNote: local ? '暫停會停止後續預取，恢復播放再繼續；跳轉優先處理目前區段。本機模型未就緒不會改用雲端，字幕仍需要模型運算時間。' : '暫停會停止後續預取，恢復播放再繼續；跳轉優先處理目前區段。已送出的雲端請求可能仍計費；字幕需要短暫準備。',
  };
}
export function watchUsageLabel(info: WatchProcessingUiInfo, calls: { session: number; daily: number }) {
  return info.processingMode === 'local' ? `全本機 · 已處理 ${calls.session} 批${info.unlimited ? ' · 不限總批數' : ''}`
    : `本次 ${calls.session}/${formatWatchLimit(info.limits?.sessionCalls)} · 今日 ${calls.daily}/${formatWatchLimit(info.limits?.dailyCalls)}`;
}
