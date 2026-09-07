/** Library media actions only. Never calls translation or downloads on its own. */
export type MediaAction = 'download' | 'burn';
export type MediaData = Record<string, unknown>;

export function mediaFailureMessage(value: unknown, action: MediaAction, status?: number): string {
  const raw = typeof value === 'string' ? value : '';
  if (status === 403 || /\b403\b|forbidden|private video|sign in|login|members.only/i.test(raw)) return '來源拒絕下載或需要授權（403／登入限制）。請使用你有權處理的本機影片；不會繞過限制或自動重試下載。';
  if (/source video missing|no source video/i.test(raw)) return '找不到本機原始影片。請先取得有權使用的原片，再重新開始燒錄。';
  if (/srt missing|no srt yet/i.test(raw)) return '找不到對應字幕檔。請先完成字幕匯出，再重新開始燒錄。';
  if (/此影片沒有獨立英文字幕/.test(raw)) return '此影片沒有獨立英文字幕，請選擇已有的字幕語系。';
  if (status === 404) return '找不到這筆影片資料，請返回翻譯庫確認。';
  if (/not a video/i.test(raw)) return '這筆資料不是可燒錄的本機影片。';
  if (/videotoolbox.*(?:compression|硬體)|-12903/i.test(raw)) return 'VideoToolbox 硬體編碼目前不可用或忙碌；可稍後重試，或由本人選擇下方 libx264 高品質模式，不會自動改用其他模式。';
  if (/subtitles.*(not found|no such filter)|libass/i.test(raw)) return '本機 FFmpeg 缺少字幕燒錄功能（libass），請檢查 ffmpeg-full 設定。';
  if (/字幕.*尚未完成/.test(raw)) return '中文／雙語字幕尚未完整完成，請先續作字幕；目前只可燒錄已有的原文字幕。';
  if (/字幕.*(對齊|一致|有效)|invalid.*subtitle/i.test(raw)) return '原文與譯文字幕未完整對齊；已停止匯出，不會略過缺句。';
  return action === 'download' ? '原片下載失敗，請檢查來源授權及本機服務後再手動重試；不會自動下載。' : '字幕燒錄失敗，請檢查本機原片、字幕與 FFmpeg；不會自動重試。';
}

export async function mediaResponse(response: Response, action: MediaAction): Promise<MediaData> {
  let data: MediaData;
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    data = parsed as MediaData;
  } catch { throw new Error(mediaFailureMessage(null, action, response.status)); }
  if (!response.ok || typeof data.error === 'string' && !('id' in data)) throw new Error(mediaFailureMessage(data.error, action, response.status));
  return data;
}

/** One read at a time, bounded by elapsed time; caller owns consent and cancellation. */
export async function pollMediaTask(input: {
  action: MediaAction;
  read: () => Promise<MediaData>;
  onUpdate: (data: MediaData) => void;
  signal: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<MediaData> {
  const now = input.now ?? Date.now;
  const deadline = now() + (input.timeoutMs ?? (input.action === 'download' ? 610_000 : 3_660_000));
  const delay = input.delay ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('aborted')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }));
  while (!input.signal.aborted) {
    if (now() >= deadline) throw new Error('等待工作結果逾時；已停止查詢，不會自動重送。後端可能仍在處理，請稍後重新整理確認。');
    const data = await input.read();
    if (input.signal.aborted) throw new Error('aborted');
    input.onUpdate(data);
    if (input.action === 'download') {
      if (typeof data.video_url === 'string' && data.video_url) return data;
      if (typeof data.error === 'string' && data.error.startsWith('download-video:')) throw new Error(mediaFailureMessage(data.error, 'download'));
    } else {
      if (data.burn_status === 'done') return data;
      if (data.burn_status === 'error') throw new Error(mediaFailureMessage(data.burn_error, 'burn'));
      if (data.burn_status !== 'burning') throw new Error('尚未開始燒錄，請確認原片與字幕是否就緒。');
    }
    await delay(4000, input.signal);
  }
  throw new Error('aborted');
}

/** New local records require complete subtitles for zh/bi; historical null is unchanged. */
export function canBurnSubtitleTrack(subtitleStatus: unknown, track: 'bi' | 'zh' | 'en'): boolean {
  return subtitleStatus == null || subtitleStatus === 'complete' || track === 'en';
}
