export interface LibraryGenerationProgress {
  status?: string;
  pipeline_stage?: string;
  summary?: unknown;
  error?: string | null;
  subtitle_status?: string | null;
  subtitle_completed?: number | null;
  subtitle_total?: number | null;
  subtitle_error?: string | null;
}

/** Summary completion is not subtitle completion; never silently stop at five minutes. */
export function libraryGenerationState(item: LibraryGenerationProgress): {
  status: 'processing' | 'done' | 'error'; message: string; keepPolling: boolean;
} {
  const total = Math.max(0, Number(item.subtitle_total) || 0);
  const ready = Math.min(total, Math.max(0, Number(item.subtitle_completed) || 0));
  const progress = total ? `（${ready}／${total} 句）` : '';
  const summaryReady = Boolean(item.summary) || item.pipeline_stage === 'summary_ready';
  if (item.pipeline_stage === 'library_rendering') return {
    status: 'processing', keepPolling: true,
    message: '文字摘要已保存，正在產生摘要圖卡；已完成的字幕會保留。',
  };
  if (item.pipeline_stage === 'library_summarizing' && item.subtitle_status === 'processing') return {
    status: 'processing', keepPolling: true,
    message: `正在整理全文摘要；接著會處理整片字幕。已有字幕快取${progress}，請保持本機服務開啟。`,
  };
  if (item.subtitle_status === 'processing') return {
    status: 'processing', keepPolling: true,
    message: `${summaryReady ? '摘要已可閱讀；' : ''}整片字幕處理中${progress}。暫停影片不影響此工作，請保持本機服務開啟。`,
  };
  if (item.subtitle_status === 'partial' || item.subtitle_status === 'error') return {
    status: 'error', keepPolling: false,
    message: `${summaryReady ? '摘要已可閱讀；' : ''}字幕尚未全部完成${progress}。${item.subtitle_error || '可按「產生摘要與完整字幕」繼續，成功快取不會重翻。'}`,
  };
  if (item.status === 'error') return {
    status: 'error', keepPolling: false, message: item.error || '處理未完成，請重試；已保存的結果會保留。',
  };
  if (item.status === 'done' && item.error) return {
    status: 'error', keepPolling: false,
    message: `${item.subtitle_status === 'complete' ? `完整字幕已完成${progress}；` : ''}${item.error}`,
  };
  if (item.status === 'done') return {
    status: 'done', keepPolling: false,
    message: item.subtitle_status === 'complete' ? `摘要與完整字幕已完成${progress}。可開啟結果、下載 SRT，或準備原片後燒錄字幕。` : '摘要已完成，可開啟結果查看字幕與下載選項。',
  };
  return {
    status: 'processing', keepPolling: true,
    message: summaryReady ? '摘要已可閱讀，正在準備字幕與下載檔案…' : '正在讀取原文字幕、整理摘要；長影片需要一些時間，不會因為超過五分鐘就隱藏進度。',
  };
}
