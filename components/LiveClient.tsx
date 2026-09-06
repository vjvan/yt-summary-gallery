"use client";

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveReplyDraft, LiveSessionDetail, LiveSessionMetadata, LiveTone } from '@/lib/live/types';
import type { WatchProviderInfo } from '@/lib/watch/types';
import { LIVE_DEMO, DEMO_REPLY_EN, DEMO_REPLY_ZH } from '@/lib/live-ui/demo';
import { LiveApiError, liveReadResponse, requestLiveReplyDraft } from '@/lib/live-ui/api';
import { chooseLiveSession, followLiveTranscript, liveSessionLabel, liveSourceHost, liveTime, makeLiveReplyInput, MAX_REPLY_CHARACTERS, mayApplyLiveDraft } from '@/lib/live-ui/state';

const TONES: { value: LiveTone; label: string }[] = [{ value: 'natural', label: '自然對話' }, { value: 'polite', label: '禮貌回覆' }, { value: 'concise', label: '簡短直接' }];
const GAP_LABELS = { silence: '語音停頓', overload: '處理速度落後', 'capture-gap': '收音空段', 'missing-chunks': '片段未到達', 'processing-failed': '辨識或翻譯失敗' };
const DEMO_PROVIDER: WatchProviderInfo = { processingMode: 'local', unlimited: true, translationModel: '本機模型 · 示範資料', translationConfigured: true, translationReady: true, audioConfigured: true };

export default function LiveClient({ demo, initialSession = '' }: { demo: boolean; initialSession?: string }) {
  const [sessions, setSessions] = useState<LiveSessionMetadata[]>(demo ? [LIVE_DEMO] : []);
  const [selectedId, setSelectedId] = useState(demo ? LIVE_DEMO.sessionId : '');
  const [detail, setDetail] = useState<LiveSessionDetail | null>(demo ? LIVE_DEMO : null);
  const [provider, setProvider] = useState<WatchProviderInfo | null>(demo ? DEMO_PROVIDER : null);
  const [connection, setConnection] = useState<'connecting' | 'ready' | 'error'>(demo ? 'ready' : 'connecting');
  const [connectionError, setConnectionError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [following, setFollowing] = useState(true);
  const [showOriginal, setShowOriginal] = useState(true);
  const [stopBusy, setStopBusy] = useState(false);
  const [stopNotice, setStopNotice] = useState('');
  const [chinese, setChinese] = useState(demo ? DEMO_REPLY_ZH : '');
  const [tone, setTone] = useState<LiveTone>('natural');
  const [english, setEnglish] = useState(demo ? DEMO_REPLY_EN : '');
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState('');
  const [draftNotice, setDraftNotice] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  const tokenRef = useRef(''); // Pairing code never enters the rendered DOM or persistent storage.
  const selectedRef = useRef(demo ? LIVE_DEMO.sessionId : '');
  const chineseRef = useRef(demo ? DEMO_REPLY_ZH : '');
  const draftGeneration = useRef(0);
  const draftController = useRef<AbortController | null>(null);
  const transcriptPanel = useRef<HTMLDivElement>(null);
  const transcriptContent = useRef<HTMLDivElement>(null);
  const touchStart = useRef<number | null>(null);

  const cancelDraft = useCallback(() => {
    draftGeneration.current++;
    draftController.current?.abort(); draftController.current = null;
    setDraftBusy(false);
  }, []);
  const selectSource = useCallback((id: string) => {
    if (selectedRef.current === id) return;
    cancelDraft(); selectedRef.current = id; chineseRef.current = '';
    setSelectedId(id); setDetail(null); setDetailError(''); setStopNotice('');
    setChinese(''); setEnglish(''); setDraftError(''); setDraftNotice(''); setCopyNotice(''); setFollowing(true);
  }, [cancelDraft]);

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let lastStatus = 0;
    const poll = async () => {
      try {
        if (!tokenRef.current) {
          const pair = await liveReadResponse<{ token: string }>(await fetch('/api/watch/pair', {
            credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          }));
          if (typeof pair.token !== 'string' || pair.token.length < 16) throw Error('無法取得本機配對，請確認伺服器已啟動。');
          controller.signal.throwIfAborted(); tokenRef.current = pair.token;
        }
        const headers = { Authorization: `Bearer ${tokenRef.current}` };
        if (Date.now() - lastStatus > 15_000) {
          const status = await liveReadResponse<WatchProviderInfo>(await fetch('/api/watch/status', { headers, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) }));
          controller.signal.throwIfAborted(); setProvider(status); lastStatus = Date.now();
        }
        const result = await liveReadResponse<{ sessions: LiveSessionMetadata[] }>(await fetch('/api/live/session', { headers, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) }));
        if (!Array.isArray(result.sessions)) throw Error('直播來源清單格式不正確，請重新檢查本機服務。');
        controller.signal.throwIfAborted();
        setSessions(result.sessions); setConnection('ready'); setConnectionError('');
        selectSource(chooseLiveSession(result.sessions, selectedRef.current, initialSession));
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof LiveApiError && error.status === 401) { tokenRef.current = ''; lastStatus = 0; }
        setConnection('error'); setConnectionError(error instanceof Error ? error.message : '無法連線本機服務。');
      } finally { if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 3000); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [demo, initialSession, refresh, selectSource]);

  useEffect(() => {
    if (demo || !selectedId) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!tokenRef.current) return;
        const result = await liveReadResponse<LiveSessionDetail>(await fetch(`/api/live/session/${encodeURIComponent(selectedId)}`, {
          headers: { Authorization: `Bearer ${tokenRef.current}` }, cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
        }));
        if (result.sessionId !== selectedId || !Array.isArray(result.cues) || !Array.isArray(result.chunks) || !Array.isArray(result.gaps)) throw Error('本機逐字稿來源或格式不正確。');
        controller.signal.throwIfAborted();
        if (selectedRef.current !== selectedId) return;
        setDetail(result); setDetailError('');
      } catch (error) {
        if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : '逐字稿更新失敗。');
      } finally { if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, 2000); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [demo, selectedId, refresh]);

  // Closing this viewing page does NOT silently stop the source tab's explicit recording session.
  useEffect(() => () => { draftGeneration.current++; draftController.current?.abort(); }, []);

  const alignTranscript = useCallback((force = false) => {
    if (transcriptPanel.current) followLiveTranscript(transcriptPanel.current, following || force);
  }, [following]);
  useEffect(() => {
    alignTranscript();
    const content = transcriptContent.current;
    if (!following || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => alignTranscript()); observer.observe(content);
    return () => observer.disconnect();
  }, [alignTranscript, following, detail?.cues, showOriginal]);

  async function stopCapture() {
    if (demo || !selectedId || stopBusy) return;
    const target = selectedId; cancelDraft(); setStopBusy(true); setStopNotice('');
    try {
      if (!tokenRef.current) throw Error('本機尚未連線，請直接在 Chrome 擴充功能停止收音。');
      await liveReadResponse(await fetch(`/api/live/session/${encodeURIComponent(target)}/stop`, { method: 'POST',
        headers: { Authorization: `Bearer ${tokenRef.current}` }, signal: AbortSignal.timeout(8000) }));
      if (selectedRef.current !== target) return;
      setDetail(current => current?.sessionId === target ? { ...current, state: 'stopped', status: 'stopped', processing: false, audioProcessing: false, replyProcessing: false } : current);
      setRefresh(value => value + 1); // Abort a pre-stop detail poll so it cannot restore stale active state.
      setStopNotice('本機工作已停止；擴充功能將結束收音，請留意 Chrome 收音指示。已完成逐字稿仍可閱讀。');
    } catch (error) {
      if (selectedRef.current === target) setStopNotice(`尚未確認停止：${error instanceof Error ? error.message : '連線失敗'} 請到 Chrome 擴充功能按「停止」。`);
    } finally { setStopBusy(false); }
  }
  function editChinese(value: string) {
    if (draftBusy) { cancelDraft(); setDraftNotice('中文內容已變更，已取消舊草稿請求。'); }
    chineseRef.current = value; setChinese(value); setCopyNotice(''); setDraftError('');
  }
  async function submitReply(event: React.FormEvent) {
    event.preventDefault(); setDraftError(''); setDraftNotice(''); setCopyNotice('');
    if (demo) { setEnglish(DEMO_REPLY_EN); setDraftNotice('已載入固定示範草稿；不是模型生成，也不會送到 Discord。'); return; }
    const controller = new AbortController(); const generation = ++draftGeneration.current;
    draftController.current?.abort(); draftController.current = controller;
    try {
      if (provider?.processingMode !== 'local' || provider.translationReady !== true || connection !== 'ready') throw Error('請先確認本機翻譯模型已就緒。');
      const input = makeLiveReplyInput(selectedId, chinese, tone);
      setDraftBusy(true);
      const draft: LiveReplyDraft = await requestLiveReplyDraft(input, tokenRef.current, controller.signal);
      if (!mayApplyLiveDraft(draft, input, { sessionId: selectedRef.current, text: chineseRef.current, generation: draftGeneration.current }, generation)) return;
      setEnglish(draft.english); setDraftNotice('英文草稿已就緒。請檢查語氣、對象與內容，再自行貼到 Discord 送出。');
    } catch (error) {
      if (!controller.signal.aborted && generation === draftGeneration.current) setDraftError(error instanceof Error ? error.message : '英文草稿尚未完成，請重試。');
    } finally { if (draftController.current === controller) { draftController.current = null; setDraftBusy(false); } }
  }
  async function copyEnglish() {
    if (!english.trim()) return;
    try { await navigator.clipboard.writeText(english.trim()); setCopyNotice('已複製英文。尚未送出任何 Discord 訊息。'); }
    catch { setCopyNotice('瀏覽器不允許自動複製；請在上方英文框手動選取並複製。'); }
  }

  const source = detail || sessions.find(session => session.sessionId === selectedId);
  const cues = detail?.cues.slice(-500) || [];
  const latest = cues.at(-1);
  const lastProcessed = detail?.chunks.filter(chunk => typeof chunk.processingMs === 'number').at(-1);
  const gaps = detail?.gaps.filter(gap => gap.reason !== 'silence') || [];
  const localReady = provider?.processingMode === 'local' && provider.translationReady === true;
  const canReply = demo || (Boolean(selectedId) && localReady && connection === 'ready');
  const modelStatus = demo ? '示範狀態・未執行模型' : !provider ? '正在確認本機模型' : provider.processingMode !== 'local' ? '目前不是本機模式，請調整伺服器' : !provider.translationReady ? '本機翻譯尚未就緒' : !provider.audioConfigured ? '翻譯可用・Whisper 尚未設定' : '本機翻譯與 Whisper 已設定';
  const replyReason = demo ? '固定範例，不會呼叫 API。' : !selectedId ? '請先啟動並選擇直播來源，才能引用對話準備草稿。' : connection !== 'ready' ? '本機連線中斷，請先重新檢查。' : !localReady ? '本機翻譯模型未就緒，暫時不能產生草稿。' : source?.state === 'stopped' ? '收音已停止；保留期間仍可用上下文準備回覆。' : '只在你按下按鈕後處理中文與目前來源的上下文。';

  return <main className="min-h-screen flex-1 bg-[#fafaf9] text-gray-900">
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div><p className="mb-2 text-xs font-bold tracking-wider text-orange-600">YT SUMMARY / LIVE</p>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Discord 直播翻譯台</h1>
          <p className="mt-3 text-sm leading-relaxed text-gray-600">聽英文・看繁中・用中文準備英文回覆。最後一句話，仍由你決定怎麼說。</p></div>
        <Link href="/glossary" className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 hover:border-orange-300">管理專業術語 ↗</Link>
      </header>

      {demo && <div role="status" className="mb-5 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm leading-relaxed text-orange-900"><strong>互動示範，不是真實直播：</strong>逐字稿、模型狀態與英文草稿皆為固定範例；本頁不收音、不呼叫 API、不發送訊息。 <Link href="/live" className="font-bold underline underline-offset-2">前往正式翻譯台</Link></div>}

      <section aria-labelledby="live-source-title" className="mb-6 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="live-source-title" className="text-sm font-bold">01 / 收音來源與本機狀態</h2>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${demo ? 'bg-gray-100 text-gray-600' : connection === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>{demo ? 'DEMO · 未收音' : connection === 'ready' ? '已連線本機' : connection === 'error' ? '本機連線中斷' : '正在連線本機'}</span>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-gray-600"><strong className="text-gray-800">只開啟這一頁，不會開始收音。</strong>請在桌面 Chrome 的 Discord 分頁，透過擴充功能手動同意並啟動。音訊、字幕與回覆草稿只交給本機模型。</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-gray-50 p-3.5"><p className="text-[11px] font-bold text-gray-500">處理方式</p><p className="mt-1.5 text-sm font-semibold">{modelStatus}</p><p className="mt-1 break-words text-xs leading-relaxed text-gray-500">{provider?.translationModel || 'Ollama + 本機 Whisper'}{!demo && ' · 不自動切換雲端'}</p></div>
          <div className="rounded-xl bg-gray-50 p-3.5"><p className="text-[11px] font-bold text-gray-500">來源工作</p><p className="mt-1.5 text-sm font-semibold">{demo ? '示範來源，沒有實際擷取' : source ? liveSessionLabel(source) : '尚未手動啟動來源'}</p><p className="mt-1 text-xs leading-relaxed text-gray-500">{source ? liveSourceHost(source.url) : 'Discord 網頁版 · 所選分頁的混合聲音'}</p></div>
          <div className="rounded-xl bg-gray-50 p-3.5"><p className="text-[11px] font-bold text-gray-500">延遲與處理</p><p className="mt-1.5 text-sm font-semibold">{lastProcessed?.processingMs !== undefined ? `上段處理 ${(lastProcessed.processingMs / 1000).toFixed(1)} 秒${demo ? '（示例）' : ''}` : source?.audioProcessing ? '模型正在處理目前片段' : '等待第一段完整辨識'}</p><p className="mt-1 text-xs leading-relaxed text-gray-500">不是端到端延遲；先收音再辨識，不保證零延遲。</p></div>
        </div>
        {!demo && provider?.translationStatusMessage && <p className={`mt-3 text-xs leading-relaxed ${localReady ? 'text-gray-500' : 'text-amber-800'}`}>{provider.translationStatusMessage}</p>}
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1"><label htmlFor="live-source" className="mb-2 block text-xs font-bold text-gray-600">選擇已手動啟動的直播來源</label>
            <select id="live-source" value={selectedId} onChange={event => selectSource(event.target.value)} disabled={!sessions.length || demo} className="w-full min-w-0 rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm outline-none focus:border-orange-400 disabled:bg-gray-50 disabled:text-gray-500">
              {!sessions.length && <option value="">尚無直播來源，請依下方步驟開始</option>}
              {sessions.map(session => <option key={session.sessionId} value={session.sessionId}>{session.state === 'stopped' ? '已停止 · ' : ''}{session.title || 'Discord 直播'}</option>)}
            </select></div>
          <button type="button" disabled={demo} onClick={() => { setConnection('connecting'); setRefresh(value => value + 1); }} className="rounded-xl border border-gray-200 px-4 py-3 text-sm font-semibold hover:bg-gray-50 disabled:text-gray-400">重新檢查</button>
          <button type="button" onClick={() => { void stopCapture(); }} disabled={demo || !selectedId || source?.state === 'stopped' || stopBusy} className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700 hover:bg-red-100 disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400">{stopBusy ? '停止中…' : '停止此來源收音'}</button>
        </div>
        {(connectionError || detailError) && <div role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm leading-relaxed text-red-800"><p className="font-semibold">{connectionError || detailError}</p><p className="mt-1 text-xs">畫面保留最後成功的內容，不代表仍在更新；如要停止收音，請直接在 Chrome 擴充功能操作。</p></div>}
        {stopNotice && <p role="status" className="mt-3 text-sm leading-relaxed text-amber-800">{stopNotice}</p>}
        {source?.stopReason && <p className="mt-3 text-sm leading-relaxed text-amber-800">停止原因：{source.stopReason}{source.unprocessedSeconds ? ` · 約 ${source.unprocessedSeconds.toFixed(1)} 秒尚未處理` : ''}</p>}
        <p className="mt-4 text-xs leading-relaxed text-gray-500">開始後，即使切回本頁或其他視窗，仍只收你選定的 Discord 分頁。關閉翻譯台不等於停止收音；請使用「停止此來源收音」或擴充功能的停止按鈕。</p>
      </section>

      {!source && <section aria-labelledby="live-start-title" className="mb-6 rounded-2xl border border-dashed border-orange-200 bg-orange-50/50 p-5 sm:p-6">
        <h2 id="live-start-title" className="font-bold">第一次使用？依序完成這 3 步</h2>
        <ol className="mt-4 grid gap-4 text-sm leading-relaxed sm:grid-cols-3">
          <li><span className="mb-2 block text-xs font-bold text-orange-600">STEP 1</span><strong>準備桌面 Chrome</strong><p className="mt-1 text-gray-600">手動載入專案的 Chrome 擴充功能，完成本機配對，再開啟 Discord 網頁版並加入直播。</p><Link href="/watch" className="mt-2 inline-block text-xs font-bold text-orange-700 underline underline-offset-2">前往配對設定與安裝說明</Link></li>
          <li><span className="mb-2 block text-xs font-bold text-orange-600">STEP 2</span><strong>在來源分頁手動開始</strong><p className="mt-1 text-gray-600">打開 Chrome 擴充功能，選擇 Discord 直播收音，確認所選分頁並勾選本次音訊處理同意。</p></li>
          <li><span className="mb-2 block text-xs font-bold text-orange-600">STEP 3</span><strong>回到這裡聽譯與準備回覆</strong><p className="mt-1 text-gray-600">來源會出現在上方清單；等第一段完整辨識後，下方就會開始顯示原文與繁中。</p><Link href="/live?demo=1" className="mt-2 inline-block text-xs font-bold text-orange-700 underline underline-offset-2">先看不收音的互動示範</Link></li>
        </ol>
      </section>}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
        <section aria-labelledby="live-transcript-title" className="min-w-0 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="border-b border-gray-100 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><h2 id="live-transcript-title" className="text-sm font-bold">02 / 繁中聽譯與原文</h2><span className="text-xs text-gray-500">{cues.length} 句{demo ? '固定示例' : '已完成'}</span></div>
            <p className="mt-2 text-xs leading-relaxed text-gray-500">依音訊時間顯示已完成的翻譯；不是直播原生字幕，也不能從這裡跳轉 Discord 播放。</p></div>
          <div className="border-b border-orange-100 bg-orange-50/60 px-5 py-5" aria-live="polite" aria-atomic="true">
            <p className="mb-2 text-[11px] font-bold tracking-wide text-orange-700">{latest ? `最新完成 · +${liveTime(latest.start)}` : '等待第一句'}</p>
            <p className="text-lg font-semibold leading-relaxed text-gray-900 sm:text-xl">{latest?.text || (source ? '來源已選定，等待收音、辨識與翻譯完成。' : '請先從 Chrome 擴充功能啟動 Discord 直播收音。')}</p>
            {latest && showOriginal && <p className="mt-2 text-sm leading-relaxed text-gray-600">{latest.originalText}</p>}
          </div>
          {gaps.length > 0 && <div role="status" className="border-b border-amber-100 bg-amber-50 px-5 py-3 text-xs leading-relaxed text-amber-900"><strong>有 {gaps.length} 處未完整處理，未假裝補齊內容。</strong>{gaps.slice(-2).map((gap, index) => <p key={`${gap.start}-${index}`}>+{liveTime(gap.start)}–{liveTime(gap.end)} · {GAP_LABELS[gap.reason]}</p>)}</div>}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-5 py-3">
            <button type="button" aria-pressed={following} onClick={() => { setFollowing(!following); if (!following) alignTranscript(true); }} className={`rounded-lg border px-3 py-2 text-xs font-bold ${following ? 'border-orange-200 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-600'}`}>{following ? '自動跟隨最新' : '恢復自動跟隨'}</button>
            <label className="flex items-center gap-2 text-xs text-gray-600"><input type="checkbox" checked={showOriginal} onChange={event => setShowOriginal(event.target.checked)} className="accent-orange-500" />顯示英文原文</label>
          </div>
          <div ref={transcriptPanel} role="region" aria-label="直播逐字稿列表" tabIndex={0} className="max-h-[460px] overflow-y-auto overscroll-contain p-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-300"
            onWheelCapture={event => { if (event.deltaY) setFollowing(false); }}
            onTouchStart={event => { touchStart.current = event.touches[0]?.clientY ?? null; }}
            onTouchMove={event => { if (touchStart.current !== null && Math.abs((event.touches[0]?.clientY ?? touchStart.current) - touchStart.current) > 4) setFollowing(false); }}
            onTouchEnd={() => { touchStart.current = null; }}
            onPointerDown={event => { if (event.pointerType === 'mouse' && event.target === event.currentTarget) setFollowing(false); }}
            onKeyDownCapture={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) setFollowing(false); }}>
            <div ref={transcriptContent}>{cues.length ? cues.map((cue, index) => <article key={cue.id} className={`rounded-xl p-3 ${index === cues.length - 1 ? 'bg-orange-50' : 'border-b border-gray-50'}`}>
              <p className="mb-1.5 text-[11px] font-semibold tabular-nums text-orange-700">+{liveTime(cue.start)}–{liveTime(cue.end)}{demo && ' · 示範'}</p><p className="text-sm font-medium leading-relaxed text-gray-800">{cue.text}</p>{showOriginal && <p className="mt-1.5 text-xs leading-relaxed text-gray-500">{cue.originalText}</p>}
            </article>) : <div className="px-5 py-14 text-center text-sm leading-relaxed text-gray-400">尚無已完成的逐字稿。<br />不會因你開啟此頁，就自動擷取聲音。</div>}</div>
          </div>
          <p className="border-t border-gray-100 px-5 py-3 text-xs leading-relaxed text-gray-500">{following ? '手動捲動可暫停跟隨，方便閱讀前文。' : '已暫停自動跟隨；新的翻譯仍會繼續到達。'} 保留最近 {source?.limits.maxStoredCues || 500} 句，不代表限制總收音段數。</p>
        </section>

        <section aria-labelledby="live-reply-title" className="min-w-0 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 id="live-reply-title" className="text-sm font-bold">03 / 用中文準備英文回覆</h2><p className="mt-2 text-xs leading-relaxed text-gray-500">先寫你想說的話，本機模型協助表達。這裡只產生草稿，<strong>不會按下 Discord 的送出鍵。</strong></p>
          <form onSubmit={event => { void submitReply(event); }} className="mt-5">
            <label htmlFor="live-chinese" className="mb-2 block text-xs font-bold text-gray-600">我想說的中文</label>
            <textarea id="live-chinese" value={chinese} readOnly={demo} onChange={event => editChinese(event.target.value)} maxLength={MAX_REPLY_CHARACTERS} rows={5} placeholder="例如：可以再示範一次人物遮罩的接法嗎？" className="w-full resize-y rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-sm leading-relaxed outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" />
            <div className="mt-2 flex items-center justify-between gap-3"><label className="flex items-center gap-2 text-xs text-gray-600">語氣<select aria-label="英文回覆語氣" value={tone} disabled={draftBusy || demo} onChange={event => setTone(event.target.value as LiveTone)} className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs">{TONES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><span className="text-[11px] tabular-nums text-gray-400">{chinese.length} / {MAX_REPLY_CHARACTERS}</span></div>
            <p className="mt-3 text-xs leading-relaxed text-gray-500">{replyReason}</p>
            <div className="mt-3 flex gap-2"><button type="submit" disabled={!canReply || !chinese.trim() || draftBusy} className="min-h-11 flex-1 rounded-xl bg-orange-500 px-4 py-3 text-sm font-bold text-white hover:bg-orange-600 disabled:bg-gray-200 disabled:text-gray-500">{draftBusy ? '本機準備英文草稿中…' : demo ? '載入固定示範草稿' : '產生英文草稿'}</button>{draftBusy && <button type="button" onClick={() => { cancelDraft(); setDraftNotice('已取消草稿請求，沒有送出 Discord 訊息。'); }} className="rounded-xl border border-gray-200 px-3 text-sm font-semibold text-gray-600">取消</button>}</div>
          </form>
          {draftError && <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm leading-relaxed text-red-700">{draftError}</p>}
          {draftNotice && <p role="status" className="mt-3 text-xs leading-relaxed text-emerald-800">{draftNotice}</p>}
          <div className="mt-6 border-t border-gray-100 pt-5"><div className="mb-2 flex items-center justify-between gap-2"><label htmlFor="live-english" className="text-xs font-bold text-gray-600">英文草稿 · 可以自行修改</label><span className="rounded-full bg-gray-100 px-2 py-1 text-[10px] font-semibold text-gray-500">尚未送出</span></div>
            <textarea id="live-english" value={english} onChange={event => { if (draftBusy) cancelDraft(); setEnglish(event.target.value); setCopyNotice(''); }} rows={6} lang="en" placeholder="英文草稿會出現在這裡；確認後再複製。" className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-3 text-sm leading-relaxed outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100" />
            <button type="button" onClick={() => { void copyEnglish(); }} disabled={!english.trim()} className="mt-3 w-full rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-bold text-orange-700 hover:bg-orange-100 disabled:border-gray-200 disabled:bg-gray-50 disabled:text-gray-400">複製英文，自己到 Discord 送出</button>
            {copyNotice && <p role="status" className="mt-2 text-xs leading-relaxed text-gray-600">{copyNotice}</p>}
            <p className="mt-3 text-xs leading-relaxed text-gray-500">切換來源會清除此區草稿，避免回覆到錯誤的對話。停止收音後，工作保留期間仍可準備回覆。</p>
          </div>
        </section>
      </div>

      <aside className="mt-6 rounded-xl border border-gray-200 bg-white p-4 text-xs leading-relaxed text-gray-600"><strong className="text-gray-800">先知道的限制：</strong>分頁聲音可能混有多位講者、遊戲、音樂與通知；多人重疊會降低辨識品質，這版不辨認講者身分。只收所選分頁聲音，不使用麥克風，也不做螢幕錄影。每次開始收音都需手動同意，請確保參與者知情及允許此用途；草稿也請先確認再送出。</aside>
    </div>
  </main>;
}
