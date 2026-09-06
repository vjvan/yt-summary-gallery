/* global chrome, WatchCore */
(() => {
  'use strict';
  if (globalThis.__ytSummaryWatchLoaded) return;
  globalThis.__ytSummaryWatchLoaded = true;
  let generation = 0;
  let permissionRequest = 0;
  let currentVideoId = null;
  let config = { enabled: false, mode: 'bilingual', maxBatches: 10 };
  let session = null;
  let pending = false;
  let pendingWindow = false;
  let pendingCreateId = null;
  let retryAt = 0;
  let failureCount = 0;
  let halted = false;
  let queuedRetryKey = null;
  // Only a user's click authorizes the existing bounded transient retries for
  // an otherwise blocked quality window. Never authorize on quality failure.
  let retryWindowKey = null;
  let video = null;
  let player = null;
  let host = null;
  let statusElement, originalElement, translatedElement, modeElement, captionsElement, pageElement, modelElement, recoveryElement, retryElement, retryFailedElement, progressElement, downloadElement;
  let statusText = '';
  const translated = new Map();
  // Presentation-only cache: original/translated cues remain complete and unchanged.
  const captionPages = new Map();
  // Failed quality checks are not successful/cache-ready windows. Only an explicit
  // user action may retry the same failed window; playback may advance to others.
  const ready = new Set();
  const failedWindows = new Map();
  const failedCues = new Map();
  const videoEvents = ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'timeupdate', 'ended'];

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw Object.assign(new Error(response?.error || '擴充功能已重新載入，請重新整理 YouTube 頁面。'), { code: response?.code, status: response?.status });
    return response.data;
  }
  function setStatus(value) { statusText = value; if (statusElement) statusElement.textContent = value; }
  function clearCaptions() {
    if (originalElement) originalElement.textContent = '';
    if (translatedElement) translatedElement.textContent = '';
    if (pageElement) { pageElement.textContent = ''; pageElement.hidden = true; }
    if (captionsElement) captionsElement.hidden = true;
  }
  function stopSession() {
    generation += 1;
    const old = session;
    if (pendingCreateId) void send({ type: 'WATCH_CANCEL_CREATE', requestId: pendingCreateId }).catch(() => {});
    pendingCreateId = null;
    session = null;
    pending = false;
    pendingWindow = false;
    halted = false;
    retryAt = 0;
    failureCount = 0;
    translated.clear();
    captionPages.clear();
    ready.clear();
    failedWindows.clear();
    failedCues.clear();
    queuedRetryKey = null;
    retryWindowKey = null;
    updateRecoveryUI();
    clearCaptions();
    if (old) void send({ type: 'WATCH_STOP', sessionId: old.sessionId }).catch(() => {});
  }
  // publicConfig only enables this preference with saved local consent. The
  // session must independently confirm local mode before any translation.
  function fullPrefetch() { return config.enabled && config.localFullPrefetch === true && (!session || WatchCore.isLocalProcessing(session)); }
  function cancelPending(reason) {
    if (pendingCreateId) void send({ type: 'WATCH_CANCEL_CREATE', requestId: pendingCreateId }).catch(() => {});
    if (pendingWindow && session) void send({ type: 'WATCH_CANCEL_WINDOW', sessionId: session.sessionId }).catch(() => {});
    if (pending) { generation += 1; retryAt = Date.now() + 500; }
    pendingCreateId = null;
    pending = false;
    pendingWindow = false;
    queuedRetryKey = null;
    retryWindowKey = null;
    setStatus(reason);
  }
  function requestRetry(key) {
    if (!config.enabled || config.mode === 'original' || halted || pending || !WatchCore.isLocalProcessing(session) || !failedWindows.has(key) || retryWindowKey !== null) return;
    queuedRetryKey = key;
    retryWindowKey = key;
    failureCount = 0;
    retryAt = 0;
    updateRecoveryUI();
    tick();
  }
  function validTranslation(cue, source) {
    return WatchCore.validCue(cue) && cue.text.trim() && source && cue.start === source.start && cue.end === source.end && cue.originalText === source.text;
  }
  function makeOverlay() {
    if (!player) return;
    if (host && host.parentElement === player) return;
    host?.remove();
    host = document.createElement('div');
    host.setAttribute('data-yt-summary-watch', '');
    Object.assign(host.style, { position: 'absolute', inset: '0', zIndex: '2147483000', pointerEvents: 'none' });
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{all:initial}.toolbar{position:absolute;top:12px;left:12px;max-width:calc(100% - 24px);display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:7px 10px;background:rgba(12,21,30,.86);color:#fff;border:1px solid #ffffff25;border-radius:7px;font:12px/1.5 system-ui,sans-serif;pointer-events:auto;box-sizing:border-box}.progress{font-size:11px;color:#d0f3dc;flex-basis:100%;white-space:normal}.model{font-size:11px;color:#b9ddff;overflow-wrap:anywhere}.recovery{flex-basis:100%;max-width:540px;white-space:normal;color:#ffe1a3}.status{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}select,button{font:12px system-ui,sans-serif;color:#fff;background:#29394a;border:1px solid #788a9b;border-radius:4px;padding:4px}button{cursor:pointer}.captions{position:absolute;bottom:14%;left:5%;width:90%;text-align:center;pointer-events:none;font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;line-height:1.45;box-sizing:border-box}.line{display:table;margin:3px auto;padding:3px 10px;max-width:100%;border-radius:4px;background:rgba(0,0,0,.82);color:white;white-space:pre-line;overflow-wrap:anywhere;box-sizing:border-box;text-shadow:0 1px 3px #000}.zh{font-size:clamp(16px,2.1vw,29px);font-weight:600}.original{font-size:clamp(12px,1.35vw,20px);color:#e1e8ed}.line:empty{display:none}[hidden]{display:none!important}@media(max-width:700px){.toolbar{font-size:10px;top:8px;padding:4px 6px;gap:6px}.status{max-width:160px}.captions{bottom:17%}}`;
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    statusElement = document.createElement('span');
    statusElement.className = 'status';
    statusElement.setAttribute('role', 'status');
    statusElement.textContent = statusText;
    modelElement = document.createElement('span');
    modelElement.className = 'model';
    recoveryElement = document.createElement('span');
    recoveryElement.className = 'recovery';
    recoveryElement.setAttribute('role', 'status');
    recoveryElement.hidden = true;
    retryElement = document.createElement('button');
    retryElement.className = 'retry';
    retryElement.textContent = '重試目前區段';
    retryElement.hidden = true;
    retryElement.addEventListener('click', () => {
      const batch = session && video ? WatchCore.batchAt(session.cues, video.currentTime) : null;
      if (batch) requestRetry(batch.key);
    });
    retryFailedElement = document.createElement('button');
    retryFailedElement.className = 'retry-failed';
    retryFailedElement.textContent = '重試下一個失敗區段';
    retryFailedElement.hidden = true;
    retryFailedElement.addEventListener('click', () => {
      const key = [...failedWindows.keys()].sort((a, b) => Number(a) - Number(b))[0];
      if (key !== undefined && fullPrefetch()) requestRetry(key);
    });
    progressElement = document.createElement('span');
    progressElement.className = 'progress';
    progressElement.setAttribute('role', 'status');
    downloadElement = document.createElement('button');
    downloadElement.className = 'download';
    downloadElement.textContent = '下載完整雙語 SRT';
    downloadElement.hidden = true;
    downloadElement.addEventListener('click', () => {
      if (!session || !WatchCore.prefetchProgress(session.cues, translated, failedCues).complete) return;
      const text = WatchCore.bilingualSrt(session.cues, translated);
      if (!text) return;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `yt-summary-${currentVideoId}-zh-TW-bilingual.srt`;
      host.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    pageElement = document.createElement('span');
    pageElement.className = 'page-status';
    pageElement.hidden = true;
    pageElement.style.cssText = 'font-size:10px;white-space:nowrap;flex-shrink:0;color:#dce7ee';
    pageElement.setAttribute('title', '長字幕依原字幕時間近似分頁，不裁切或摘要。原文與繁中各自分頁；完整文字保留在本機 /watch 逐字稿。* 表示原時段較短，可在 /watch 暫停看全文。');
    modeElement = document.createElement('select');
    modeElement.style.maxWidth = '105px';
    modeElement.setAttribute('aria-label', 'YT Summary 字幕顯示模式');
    for (const [value, label] of [['bilingual', '繁中＋原文'], ['translated', '繁中'], ['original', '原文（不新增翻譯）']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; modeElement.append(option);
    }
    modeElement.value = config.mode;
    modeElement.addEventListener('change', () => {
      config.mode = modeElement.value;
      if (config.mode === 'original') cancelPending('原文模式：已停止預譯，保留原文與已完成字幕。');
      render(); tick();
    });
    const close = document.createElement('button');
    close.style.cssText = 'white-space:nowrap;flex-shrink:0';
    close.textContent = '關閉';
    close.setAttribute('aria-label', '停止這支影片並清除 YT Summary 字幕');
    close.addEventListener('click', () => {
      config.enabled = false;
      stopSession();
      host.hidden = true;
      void send({ type: 'WATCH_CLOSE' }).catch(() => {});
    });
    toolbar.append(modelElement, statusElement, pageElement, modeElement, retryElement, retryFailedElement, downloadElement, close, progressElement, recoveryElement);
    captionsElement = document.createElement('div');
    captionsElement.className = 'captions';
    translatedElement = document.createElement('div'); translatedElement.className = 'line zh';
    originalElement = document.createElement('div'); originalElement.className = 'line original';
    captionsElement.append(translatedElement, originalElement);
    root.append(style, toolbar, captionsElement);
    player.append(host);
    updateRecoveryUI();
  }
  function attachPlayer() {
    const foundPlayer = document.getElementById('movie_player');
    const foundVideo = foundPlayer?.querySelector('video.html5-main-video') || null;
    if (video !== foundVideo) {
      if (video) for (const event of videoEvents) video.removeEventListener(event, onVideoEvent);
      video = foundVideo;
      if (video) for (const event of videoEvents) video.addEventListener(event, onVideoEvent);
    }
    if (player !== foundPlayer) { player = foundPlayer; host?.remove(); host = null; }
    if (config.enabled) makeOverlay();
  }
  function onVideoEvent(event) {
    if (event.type === 'seeking') { queuedRetryKey = null; retryWindowKey = null; }
    if (event.type === 'seeking' && pendingWindow && session && !fullPrefetch()) {
      generation += 1;
      pending = false;
      pendingWindow = false;
      retryAt = Date.now() + 500;
      clearCaptions();
      setStatus('已跳轉，取消舊位置的預取，優先處理目前位置。');
      void send({ type: 'WATCH_CANCEL_WINDOW', sessionId: session.sessionId }).catch(() => {});
    }
    tick();
  }
  function isAd() { return player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting'); }
  function displayPage(cue, text, language, element) {
    const fontSize = Number.parseFloat(globalThis.getComputedStyle?.(element)?.fontSize || (language === '繁中' ? '16' : '12'));
    const playerWidth = player?.clientWidth || 640;
    const availableWidth = playerWidth * 0.9 - 24;
    // Narrow players need shorter pages too, not merely extra CSS wrapping.
    const lineUnits = Math.max(4, Math.min(22, Math.floor(availableWidth / Math.max(1, fontSize)) - 1));
    const pageUnits = Math.min(32, lineUnits * (playerWidth < 360 ? 1 : 2));
    const cacheKey = `${cue.id}:${language}`;
    let cached = captionPages.get(cacheKey);
    if (!cached || cached.text !== text || cached.lineUnits !== lineUnits || cached.pageUnits !== pageUnits) {
      cached = { text, lineUnits, pageUnits, pages: WatchCore.splitCaptionPages(text, { lineUnits, maxLines: 2, pageUnits }) };
      captionPages.set(cacheKey, cached);
    }
    const selected = WatchCore.selectCaptionPage(cached.pages, { start: cue.start, end: cue.end, time: video.currentTime });
    return {
      text: selected.page?.text || '',
      status: selected.total > 1 ? `${language} ${selected.index + 1}/${selected.total}${selected.dense ? '*' : ''}` : '',
    };
  }
  function updateRecoveryUI() {
    if (modelElement) {
      modelElement.textContent = session
        ? `${WatchCore.isLocalProcessing(session) ? '全本機' : '雲端'}模型：${session.translationModel || '後端未提供模型名稱'}`
        : '模型：等待建立工作階段';
    }
    const batch = session && video ? WatchCore.batchAt(session.cues, video.currentTime) : null;
    // A queued click belongs only to the selected window, never a future seek-back.
    if (!fullPrefetch() && queuedRetryKey !== null && queuedRetryKey !== batch?.key) queuedRetryKey = null;
    if (!fullPrefetch() && retryWindowKey !== null && retryWindowKey !== batch?.key) retryWindowKey = null;
    const failure = batch && failedWindows.get(batch.key);
    if (recoveryElement) {
      recoveryElement.hidden = !failure;
      recoveryElement.textContent = failure
        ? halted ? `翻譯已停止；未完成的句子保留原文。${statusText}`
          : `本區段有未翻譯句子（品質檢查未通過），只有失敗句先顯示原文；其他句子仍可繼續。${failure}`
        : '';
    }
    if (retryElement) {
      retryElement.hidden = !failure || halted;
      retryElement.disabled = pending || retryWindowKey !== null || config.mode === 'original';
      retryElement.textContent = queuedRetryKey !== null ? (fullPrefetch() ? '重試已排定' : '重試已排定，請播放影片') : pending && failure ? '處理中，請稍候' : retryWindowKey !== null ? '暫時失敗，等待有界重試' : '重試目前區段';
      retryElement.title = config.mode === 'original' ? '請先切換至繁中或雙語模式。' : (fullPrefetch() ? '只補目前區段未快取的失敗句；暫停也可重試。' : '只重試目前失敗區段；不會清除已完成字幕。暫停時等待播放才送出。');
    }
    const progress = session ? WatchCore.prefetchProgress(session.cues, translated, failedCues) : null;
    if (progressElement) {
      progressElement.hidden = !session || !fullPrefetch();
      const text = progress ? `${progress.complete ? '全片預譯完成' : progress.settled ? '預譯仍有失敗句' : '全片預譯'} · 已就緒 ${progress.readyCues}/${progress.totalCues} 句 · 失敗 ${progress.failedCues} 句（${progress.failedBatches} 批）${!progress.complete && !progress.settled && !halted && session.translationEnabled && config.mode !== 'original' ? ' · 暫停／切分頁也會繼續耗用本機算力' : ''}` : '';
      if (progressElement.textContent !== text) progressElement.textContent = text;
    }
    if (retryFailedElement) {
      retryFailedElement.hidden = !fullPrefetch() || !failedWindows.size || halted;
      retryFailedElement.disabled = pending || retryWindowKey !== null || config.mode === 'original';
    }
    if (downloadElement) downloadElement.hidden = !progress?.complete;
  }
  function render() {
    updateRecoveryUI();
    if (!host) return;
    host.hidden = !config.enabled || !WatchCore.youtubeUrl(location.href) || Boolean(isAd());
    if (host.hidden || !session || !video || video.ended || video.seeking) { clearCaptions(); return; }
    const active = WatchCore.currentCues(session.cues, video.currentTime).slice(0, 4);
    const originalPages = active.filter(cue => config.mode !== 'translated' || failedCues.has(cue.id)).map(cue => displayPage(cue, cue.text, '原文', originalElement));
    const translatedPages = config.mode === 'original' ? [] : active.map(cue => displayPage(cue, translated.get(cue.id)?.text || '', '繁中', translatedElement));
    originalElement.textContent = originalPages.map(page => page.text).filter(Boolean).join('\n');
    translatedElement.textContent = translatedPages.map(page => page.text).filter(Boolean).join('\n');
    pageElement.textContent = [...translatedPages, ...originalPages].map(page => page.status).filter(Boolean).join(' · ');
    pageElement.hidden = !pageElement.textContent;
    captionsElement.hidden = !originalElement.textContent && !translatedElement.textContent;
  }
  function reportError(error, request) {
    if (request && WatchCore.isLocalProcessing(session) && error.code === 'LOCAL_TRANSLATION_QUALITY' && error.status === 502) {
      failedWindows.set(request.key, error.message);
      for (const cue of session.cues.slice(Number(request.key) * WatchCore.BATCH_SIZE, (Number(request.key) + 1) * WatchCore.BATCH_SIZE)) {
        if (!translated.has(cue.id)) failedCues.set(cue.id, error.message);
      }
      retryWindowKey = null;
      queuedRetryKey = null;
      // Do not consume the transient-error retry budget or mark rejected text ready.
      retryAt = 0;
      setStatus(`第 ${Number(request.key) + 1} 區段未翻譯 · 播放至該區段可手動重試；其他區段繼續`);
      render();
      return;
    }
    failureCount += 1;
    if (error.status === 429 || [400, 401, 403, 404, 410, 422].includes(error.status) || failureCount >= 3) {
      halted = true;
      retryWindowKey = null;
      queuedRetryKey = null;
      setStatus(`${error.message} 請在擴充功能重新啟用。`);
    } else {
      retryAt = Date.now() + Math.min(15000, 3000 * failureCount);
      setStatus(`${error.message} 稍後重試（${failureCount}/3）。`);
    }
  }
  async function start() {
    const token = generation;
    const selected = WatchCore.youtubeUrl(location.href);
    if (!selected) return;
    const requestId = `${selected.id}-${token}-${Date.now().toString(36)}`;
    pendingCreateId = requestId;
    pending = true;
    let createdId = null;
    setStatus('正在取得原文字幕（尚未送模型翻譯）…');
    try {
      const result = await send({ type: 'WATCH_SESSION', url: selected.url, requestId });
      createdId = result.sessionId;
      if (token !== generation || !config.enabled || WatchCore.youtubeUrl(location.href)?.id !== selected.id) {
        void send({ type: 'WATCH_STOP', sessionId: result.sessionId }).catch(() => {});
        return;
      }
      if (!Array.isArray(result.cues) || !result.cues.every(WatchCore.validCue) || new Set(result.cues.map(cue => cue.id)).size !== result.cues.length) throw new Error('本機字幕格式不正確。');
      if (result.cachedCues !== undefined) {
        if (!WatchCore.isLocalProcessing(result) || !Array.isArray(result.cachedCues)) throw new Error('本機快取格式不正確。');
        const source = new Map(result.cues.map(cue => [cue.id, cue]));
        if (new Set(result.cachedCues.map(cue => cue.id)).size !== result.cachedCues.length || !result.cachedCues.every(cue => validTranslation(cue, source.get(cue.id)))) throw new Error('本機快取與這支影片的原文或時間不相符。');
        for (const cue of result.cachedCues) translated.set(cue.id, cue);
        for (let first = 0; first < result.cues.length; first += WatchCore.BATCH_SIZE) {
          if (result.cues.slice(first, first + WatchCore.BATCH_SIZE).every(cue => translated.has(cue.id))) ready.add(String(first / WatchCore.BATCH_SIZE));
        }
      }
      session = result;
      failureCount = 0;
      setStatus(WatchCore.prefetchProgress(session.cues, translated, failedCues).complete ? '完整字幕快取已載入，無須新增翻譯。' : session.translationEnabled ? `原文已備妥 · ${session.cues.length} 段 · 等待翻譯` : '後端未啟用翻譯；目前只顯示原文。');
      render();
    } catch (error) {
      if (createdId && !session) void send({ type: 'WATCH_STOP', sessionId: createdId }).catch(() => {});
      if (token === generation) reportError(error);
    }
    finally { if (pendingCreateId === requestId) pendingCreateId = null; if (token === generation) { pending = false; pendingWindow = false; } }
  }
  async function translateWindow(request) {
    const token = generation;
    const id = session.sessionId;
    pending = true;
    pendingWindow = true;
    setStatus('正在翻譯／預取字幕，先顯示原文…');
    try {
      const result = await send({ type: 'WATCH_WINDOW', sessionId: id, time: request.time });
      if (token !== generation || session?.sessionId !== id) return;
      const expected = session.cues.slice(Number(request.key) * WatchCore.BATCH_SIZE, (Number(request.key) + 1) * WatchCore.BATCH_SIZE);
      const source = new Map(expected.map(cue => [cue.id, cue]));
      const failures = result.failedCues ?? [];
      if (result.sessionId !== id || (result.windowKey !== undefined && String(result.windowKey) !== request.key)
        || !Array.isArray(result.cues) || !result.cues.every(cue => validTranslation(cue, source.get(cue.id)))
        || !Array.isArray(failures) || (failures.length > 0 && !WatchCore.isLocalProcessing(session))) throw new Error('本機翻譯格式、來源或時間不正確。');
      const seen = new Set(result.cues.map(cue => cue.id));
      if (seen.size !== result.cues.length) throw new Error('本機翻譯包含重複句子。');
      for (const failure of failures) {
        const cue = source.get(failure.id);
        if (!cue || seen.has(failure.id) || translated.has(failure.id) || failure.start !== cue.start || failure.end !== cue.end || failure.code !== 'LOCAL_TRANSLATION_QUALITY' || typeof failure.message !== 'string' || failure.message.length > 4000) throw new Error('本機失敗句資訊不正確。');
        seen.add(failure.id);
      }
      if (seen.size !== expected.length || (result.complete === true && failures.length) || (result.complete === false && !failures.length)) throw new Error('此批字幕尚未完整回傳，暫時保留原文。');
      // Commit atomically only after every successful/failed cue matches the exact
      // source. Partial success keeps good sentences, never promotes failed text.
      for (const cue of result.cues) { translated.set(cue.id, cue); failedCues.delete(cue.id); }
      for (const failure of failures) { translated.delete(failure.id); failedCues.set(failure.id, failure.message); }
      if (failures.length) { failedWindows.set(request.key, `${failures[0].message}${failures.length > 1 ? `（另有 ${failures.length - 1} 句未通過）` : ''}`); ready.delete(request.key); }
      else { ready.add(request.key); failedWindows.delete(request.key); }
      retryWindowKey = null;
      queuedRetryKey = null;
      failureCount = 0;
      const limit = WatchCore.translationLimit(session, config.maxBatches);
      setStatus(WatchCore.isLocalProcessing(session)
        ? `全本機 · 已處理 ${result.callsUsed} 批 · ${limit === null ? '不限總批數，持續至停止' : `本機上限 ${limit} 批`}`
        : `${result.cached ? '快取命中' : '翻譯就緒'} · 本片 ${result.callsUsed}/${limit} 批 · 今日 ${result.dailyCallsUsed} 批`);
      if (limit !== null && result.callsUsed >= limit) { halted = true; setStatus(`已達本片 ${limit} 批上限；已載入字幕可繼續播放。`); }
      render();
    } catch (error) { if (token === generation) reportError(error, request); }
    finally { if (token === generation) { pending = false; pendingWindow = false; updateRecoveryUI(); } }
  }
  function tick() {
    const selected = WatchCore.youtubeUrl(location.href);
    if ((selected?.id || null) !== currentVideoId) { void refreshPermission(); return; }
    attachPlayer();
    render();
    if (!config.enabled || !video || isAd() || pending || halted || Date.now() < retryAt || config.mode === 'original') return;
    const full = fullPrefetch();
    if (!full && (video.paused || video.ended || video.seeking || document.visibilityState === 'hidden')) return;
    if (!session) { void start(); return; }
    if (!session.translationEnabled) return;
    const batch = WatchCore.batchAt(session.cues, video.currentTime);
    const explicitRetry = retryWindowKey !== null && (full || batch?.key === retryWindowKey);
    const request = full ? WatchCore.fullRequest(session.cues, video.currentTime, ready, failedWindows, explicitRetry ? retryWindowKey : null)
      : explicitRetry ? { key: batch.key, time: video.currentTime } : WatchCore.nextRequest(session.cues, video.currentTime, ready);
    if (request && (explicitRetry || !failedWindows.has(request.key))) {
      queuedRetryKey = null;
      void translateWindow(request);
    }
  }

  async function refreshPermission() {
    const request = ++permissionRequest;
    const selected = WatchCore.youtubeUrl(location.href);
    const id = selected?.id || null;
    if (id !== currentVideoId) { stopSession(); currentVideoId = id; config.enabled = false; if (host) host.hidden = true; }
    try {
      const next = await send({ type: 'WATCH_CONFIG' });
      if (request !== permissionRequest) return;
      const changed = next.enabled !== config.enabled || next.maxBatches !== config.maxBatches || next.localFullPrefetch !== config.localFullPrefetch;
      if (changed) stopSession();
      if (next.mode === 'original' && config.mode !== 'original') cancelPending('原文模式：已停止預譯。');
      config = next;
      if (modeElement) modeElement.value = config.mode;
      if (!config.enabled || !selected) { if (host) host.hidden = true; clearCaptions(); return; }
      attachPlayer();
      if (!session) setStatus(fullPrefetch() ? '已啟用本機整片預譯 · 即將載入字幕；暫停／切分頁仍會耗用算力。' : '已啟用 · 開始播放後載入字幕；暫停不新增請求。');
      tick();
    } catch {
      config.enabled = false;
      stopSession();
      if (host) host.hidden = true;
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'WATCH_STATE_CHANGED') return false;
    void refreshPermission().then(() => respond({ ok: true }));
    return true;
  });
  document.addEventListener('yt-navigate-start', () => { stopSession(); config.enabled = false; if (host) host.hidden = true; });
  document.addEventListener('yt-navigate-finish', () => { void refreshPermission(); });
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('pagehide', () => { stopSession(); config.enabled = false; });
  // Local scheduling only: no per-second POST. A completed 8-cue batch is never requested again.
  setInterval(tick, 500);
  void refreshPermission();
})();
