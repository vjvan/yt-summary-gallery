/** Browser-safe validation only. The server still probes the actual media. */
export const ORIGINAL_VIDEO_MAX_BYTES = 2 * 1024 ** 3;
export function originalVideoSelectionError(file: { name: string; size: number } | null): string {
  if (!file) return '請先選擇同一版本的已授權 MP4 原片。';
  if (!/\.mp4$/i.test(file.name)) return '這一版只接受 MP4；不要只修改副檔名，伺服器會檢查實際影片格式。';
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return '影片檔案為空或大小無效。';
  if (file.size > ORIGINAL_VIDEO_MAX_BYTES) return '影片超過 2 GiB 上限，這一版不會上傳。';
  return '';
}

export function originalVideoUploadHeaders(size: number, rights: boolean, sameTimeline: boolean): Record<string, string> {
  if (!rights || !sameTimeline) throw new Error('請確認處理授權及同版本時間軸後再附加。');
  if (!Number.isSafeInteger(size) || size <= 0 || size > ORIGINAL_VIDEO_MAX_BYTES) throw new Error('影片大小無效。');
  return { 'Content-Type': 'video/mp4', 'X-File-Size': String(size), 'X-Confirm-Rights': 'true', 'X-Confirm-Same-Timeline': 'true' };
}
