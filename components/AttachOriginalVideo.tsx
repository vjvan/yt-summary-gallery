"use client";

import { useEffect, useId, useRef, useState } from 'react';
import { originalVideoSelectionError, originalVideoUploadHeaders } from '@/lib/original-video-client';

export default function AttachOriginalVideo({ id, busy = false, duration, onAttached }: {
  id: string; busy?: boolean; duration: number; onAttached: () => Promise<unknown>;
}) {
  const fieldId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [rights, setRights] = useState(false);
  const [sameTimeline, setSameTimeline] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const controllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => { controllerRef.current?.abort(); controllerRef.current = null; }, [id]);
  const selectionError = originalVideoSelectionError(file);
  async function attach() {
    if (controllerRef.current || uploading || busy) return;
    if (selectionError || !file) { setMessage(selectionError); return; }
    if (!rights || !sameTimeline) { setMessage('請先勾選兩項確認。'); return; }
    const controller = new AbortController();
    controllerRef.current = controller;
    setUploading(true); setMessage('正在上傳並檢查原片；不會重新辨識、翻譯或自動燒錄。');
    try {
      const response = await fetch(`/api/summaries/${encodeURIComponent(id)}/attach-video`, {
        method: 'POST', headers: originalVideoUploadHeaders(file.size, rights, sameTimeline), body: file,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60_000)]),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error.slice(0, 600) : '原片附加失敗，請重新整理確認後再試。');
      if (result?.status !== 'done' || typeof result.video_url !== 'string') throw new Error('尚未確認附加結果，請重新整理查詢；不會自動重送。');
      setMessage('原片已附加，已有字幕與摘要保留。請先播放核對同步，再手動燒錄。');
      await onAttached();
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : '無法確認附加結果。請重新整理查詢，再決定是否重試。');
    } finally {
      if (controllerRef.current === controller) { controllerRef.current = null; setUploading(false); }
    }
  }
  return <section aria-label="附加已授權原片" className="mt-4 min-w-0 rounded-xl border border-orange-200 bg-orange-50/40 p-4">
    <h3 className="font-bold text-gray-900">已有原片？附加 MP4，沿用這筆字幕</h3>
    <p className="mt-2 text-sm leading-relaxed text-gray-600">不重新辨識或翻譯，不更動摘要。只接受同版本、未剪輯的原片；片長檢查不能證明內容相同，附加後仍需播放核對同步。</p>
    {Number.isFinite(duration) && duration > 0 && <p className="mt-2 text-xs text-gray-600">目前來源片長：約 {Math.floor(duration / 60)} 分 {Math.round(duration % 60)} 秒。上限 2 GiB。</p>}
    <label htmlFor={fieldId} className="mt-3 block text-sm font-bold text-gray-800">選擇已授權 MP4 原片</label>
    <input id={fieldId} type="file" accept=".mp4,video/mp4" disabled={uploading || busy}
      className="mt-2 block w-full min-w-0 max-w-full text-sm text-gray-600 file:mr-2 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-2 file:text-gray-800"
      onChange={event => { setFile(event.target.files?.[0] || null); setRights(false); setSameTimeline(false); setMessage(''); }} />
    {file && <p className="mt-2 break-all text-xs text-gray-600">{file.name} · {(file.size / 1024 ** 2).toFixed(1)} MiB</p>}
    {file && selectionError && <p role="alert" className="mt-2 text-sm text-red-700">{selectionError}</p>}
    <label className="mt-3 flex items-start gap-2 text-sm text-gray-800">
      <input type="checkbox" className="mt-1 shrink-0 accent-orange-600" checked={rights} disabled={uploading || busy} onChange={event => setRights(event.target.checked)} />
      <span>我有權上傳並處理這個影片檔案。</span>
    </label>
    <label className="mt-3 flex items-start gap-2 text-sm text-gray-800">
      <input type="checkbox" className="mt-1 shrink-0 accent-orange-600" checked={sameTimeline} disabled={uploading || busy} onChange={event => setSameTimeline(event.target.checked)} />
      <span>我確認這是同一支影片、同一版本；未剪輯、未加減片頭，與現有字幕使用相同的 0 秒起點。</span>
    </label>
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" onClick={attach} disabled={busy || uploading || !!selectionError || !rights || !sameTimeline}
        className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-50">
        {uploading ? '上傳並檢查原片中…' : '附加原片，保留現有字幕'}
      </button>
      {uploading && <button type="button" onClick={() => { controllerRef.current?.abort(); setMessage('已取消上傳等待；若剛好完成，原片可能已附加。請重新整理確認，不會自動重送。'); }} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">取消上傳</button>}
    </div>
    {busy && <p className="mt-2 text-xs text-gray-600">原片下載或燒錄中，請等該工作結束後再附加。</p>}
    {message && <p role="status" className="mt-3 break-words text-sm text-gray-700">{message}</p>}
    <p className="mt-3 text-xs text-gray-500">附加不等於字幕已完成；中譯仍有缺句時，中文／雙語燒錄會保持停用。</p>
  </section>;
}
