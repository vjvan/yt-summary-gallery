/* global chrome, WatchCore, AudioWatchCore, importScripts, settings, api, fail, isPopup, contentTab, storageReady, stopAll, broadcast, SETTINGS_KEY, controllers */
importScripts('audio-core.js');
globalThis.AudioWatch = (() => {
  'use strict';
  let current = null;
  let lifecycle = 0;
  let creatingOffscreen = null;
  const STORAGE_KEY = 'watchAudioActive';
  const offscreenUrl = () => chrome.runtime.getURL('offscreen.html');
  const isOffscreen = sender => sender.id === chrome.runtime.id && !sender.tab && sender.url === offscreenUrl();
  async function offscreen(message) {
    const response = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
    if (!response?.ok) throw fail(response?.error || '分頁音訊程序尚未就緒。', 'AUDIO_CAPTURE_FAILED');
    return response;
  }
  async function ensureOffscreen() {
    if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl()] })).length) return;
    if (!creatingOffscreen) creatingOffscreen = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Only record user-approved YouTube tab audio in complete bounded clips; never microphone or video.' }).finally(() => { creatingOffscreen = null; });
    await creatingOffscreen;
  }
  async function notify(record, type, detail = {}) {
    await chrome.tabs.sendMessage(record.tabId, { type, runId: record.runId, videoId: record.videoId, ...detail }, { frameId: 0 }).catch(() => {});
  }
  async function cleanupOrphan() {
    await storageReady;
    if (current) return;
    const saved = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
    if (!saved) return;
    await chrome.storage.session.remove(STORAGE_KEY);
    await offscreen({ type: 'OFFSCREEN_STOP', runId: saved.runId }).catch(() => {});
    if (AudioWatchCore.validRun(saved.audioSessionId)) await api(await settings(), `/api/watch/audio/session/${saved.audioSessionId}/stop`, {}, null, 5000).catch(() => {});
  }
  async function stop(reason = '已停止分頁收音。', clear = false) {
    lifecycle += 1;
    const record = current;
    if (!record) { await cleanupOrphan(); return; }
    current = null;
    controllers.get(`audio:${record.runId}:start`)?.abort();
    controllers.get(`audio:${record.runId}:chunk`)?.abort();
    await offscreen({ type: 'OFFSCREEN_STOP', runId: record.runId }).catch(() => {});
    const saved = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
    if (saved?.runId === record.runId) await chrome.storage.session.remove(STORAGE_KEY);
    await notify(record, 'AUDIO_STOPPED', { reason, clear });
    if (record.audioSessionId) await api(record.config, `/api/watch/audio/session/${record.audioSessionId}/stop`, {}, null, 5000).catch(() => {});
  }
  async function getClock(record) {
    const clock = await chrome.tabs.sendMessage(record.tabId, { type: 'AUDIO_GET_CLOCK' }, { frameId: 0 });
    const reason = AudioWatchCore.unsafeClock(clock, record.videoId);
    if (reason) throw fail(reason, 'AUDIO_UNSAFE_CLOCK');
    return clock;
  }
  async function start(message) {
    if (message.confirmAudio !== true) throw fail('每次開始前都必須另外同意分頁收音與目前模式的辨識／翻譯處理。', 'AUDIO_CONSENT_REQUIRED', 403);
    if (!Number.isInteger(message.maxChunks) || (message.maxChunks !== 0 && (message.maxChunks < 2 || message.maxChunks > 20))) throw fail('雲端收音需設定 2–20 段上限；0 只供已確認的全本機不限模式使用。');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const video = WatchCore.youtubeUrl(tab?.url);
    if (!video) throw fail('請在 YouTube /watch 影片頁面手動開始收音。');
    await globalThis.LiveWatch?.stop('user');
    await stop('開始新的手動收音工作。', true);
    const epoch = lifecycle;
    const config = await settings();
    if (config.token.length < 16) throw fail('請先測試連線並儲存配對權杖。');
    const record = { runId: crypto.randomUUID(), tabId: tab.id, windowId: tab.windowId, videoId: video.id, config, audioSessionId: null, maxChunks: message.maxChunks, usedChunks: 0, phase: 'starting', lastClock: null, activeStart: null };
    await getClock(record); // No capture when paused, ads, background, seeking or not 1x.
    const status = await api(config, '/api/watch/status', undefined, null, 10000);
    if (epoch !== lifecycle) throw fail('收音啟動已取消。', 'AUDIO_CANCELLED');
    if (message.expectedProcessingMode === 'local' && !WatchCore.isLocalProcessing(status)) throw fail('後端已切換至雲端；請重新確認音訊傳送與費用同意。', 'PROCESSING_MODE_CHANGED', 403);
    const unlimited = WatchCore.isUnlimitedLocal(status);
    if (message.maxChunks === 0 && !unlimited) throw fail('只有後端確認的全本機模式可不限總收音段數。', 'AUDIO_LIMIT_REQUIRED', 403);
    if (!status.audioConfigured) throw fail(WatchCore.isLocalProcessing(status) ? '本機收音辨識模型尚未設定；不會改用雲端。' : '雲端收音辨識服務尚未設定。', 'AUDIO_NOT_CONFIGURED');
    record.processingMode = status.processingMode === 'local' ? 'local' : 'cloud';
    record.unlimited = unlimited;
    record.maxChunks = unlimited ? null : message.maxChunks;
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...config, enabled: false } });
    await stopAll(config); await broadcast(); // Never start the V1 translator alongside audio.
    if (epoch !== lifecycle) throw fail('收音啟動已取消。', 'AUDIO_CANCELLED');
    current = record;
    try {
      const result = await api(config, '/api/watch/audio/session', { url: video.url, title: typeof tab.title === 'string' ? tab.title.slice(0, 300) : '', confirmAudio: true, maxChunks: record.maxChunks === null ? 0 : record.maxChunks }, `audio:${record.runId}:start`);
      if (current !== record) { if (AudioWatchCore.validRun(result.audioSessionId)) await api(config, `/api/watch/audio/session/${result.audioSessionId}/stop`, {}, null, 5000).catch(() => {}); return { started: false }; }
      if (!AudioWatchCore.validRun(result.audioSessionId) || result.videoId !== record.videoId) throw fail('本機回傳的收音工作不正確。', 'AUDIO_INVALID_RESPONSE');
      record.audioSessionId = result.audioSessionId;
      if (record.processingMode === 'local' && !WatchCore.isLocalProcessing(result)) throw fail('工作模式改變；不會自動轉成雲端收音。', 'PROCESSING_MODE_CHANGED', 403);
      if (record.unlimited && !WatchCore.isUnlimitedLocal(result)) throw fail('後端未確認不限段數，本次收音不會啟動。', 'AUDIO_LIMIT_REQUIRED', 403);
      record.processingMode = result.processingMode === 'local' ? 'local' : 'cloud';
      record.unlimited = WatchCore.isUnlimitedLocal(result);
      record.maxChunks = record.unlimited ? null : Math.min(record.maxChunks || message.maxChunks, Number(result.limits?.sessionChunks) || record.maxChunks || message.maxChunks);
      record.lastClock = await getClock(record);
      if (current !== record) return { started: false };
      await chrome.storage.session.set({ [STORAGE_KEY]: { runId: record.runId, tabId: record.tabId, videoId: record.videoId, audioSessionId: record.audioSessionId } });
      await ensureOffscreen();
      if (current !== record) return { started: false };
      // activeTab comes only from this explicit extension popup invocation.
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: record.tabId });
      if (current !== record) return { started: false };
      await offscreen({ type: 'OFFSCREEN_START', runId: record.runId, streamId });
      if (current !== record) { await offscreen({ type: 'OFFSCREEN_STOP', runId: record.runId }).catch(() => {}); return { started: false }; }
      record.phase = 'waiting';
      await notify(record, 'AUDIO_STARTED', { maxChunks: record.maxChunks, processingMode: record.processingMode, unlimited: record.unlimited });
      return { started: true, message: '已開始實驗收音；每段 12 秒。辨識期間不新增錄音，結果顯示為有時間戳的延遲逐字稿。' };
    } catch (error) { if (current === record) await stop(error.message, false); throw error; }
  }
  async function clock(message, sender) {
    const tab = await contentTab(sender, true);
    const record = current;
    if (!record || record.tabId !== tab.id || message.runId !== record.runId) { if (!record) await cleanupOrphan(); return { active: false }; }
    const reason = AudioWatchCore.unsafeClock(message.clock, record.videoId);
    const latestVideo = WatchCore.youtubeUrl(tab.url);
    const previous = record.lastClock;
    const jumped = previous && message.clock && Math.abs((message.clock.time - previous.time) - (message.clock.observedAt - previous.observedAt) / 1000) > 1.5;
    if (reason || latestVideo?.id !== record.videoId || jumped) { await stop(reason || '影片跳轉或切換，已停止收音。', latestVideo?.id !== record.videoId); return { active: false }; }
    record.lastClock = message.clock;
    if (record.phase === 'starting') return { active: true };
    await offscreen({ type: 'OFFSCREEN_HEARTBEAT', runId: record.runId }).catch(() => {});
    if (record.phase === 'waiting') {
      if ((record.maxChunks !== null && record.usedChunks >= record.maxChunks)) { await stop('已達收音片段上限。'); return { active: false }; }
      record.phase = 'recording';
      try {
        const boundary = await getClock(record);
        if (current !== record) return { active: false };
        record.activeStart = AudioWatchCore.roundTime(boundary.time);
        await offscreen({ type: 'OFFSCREEN_RECORD', runId: record.runId, start: record.activeStart });
        await notify(record, 'AUDIO_STATUS', { text: `正在收音第 ${record.usedChunks + 1}${record.maxChunks === null ? '（全本機不限總段數）' : `/${record.maxChunks}`} 段（12 秒，1 倍速）` });
      } catch (error) { await stop(error.message); return { active: false }; }
    }
    return { active: true };
  }
  async function captured(message, sender) {
    if (!isOffscreen(sender)) throw fail('不允許的音訊來源。', 'FORBIDDEN', 403);
    const record = current;
    if (!record || message.runId !== record.runId) return { ignored: true };
    if (message.type === 'AUDIO_CAPTURE_ERROR') { await stop(typeof message.error === 'string' ? message.error.slice(0, 200) : '分頁收音已中斷。'); return { stopped: true }; }
    if (record.phase !== 'recording' || (record.maxChunks !== null && record.usedChunks >= record.maxChunks)) throw fail('音訊工作忙碌或已達上限。', 'AUDIO_BUSY', 429);
    record.phase = 'recognizing'; // Backpressure before decoding or any await.
    try {
      if (!AudioWatchCore.validRun(message.chunkId) || message.start !== record.activeStart || !['audio/webm', 'audio/webm;codecs=opus'].includes(message.mimeType) || !AudioWatchCore.validBase64(message.base64) || message.duration < 11 || message.duration > 15) throw fail('音訊片段格式或長度不正確。');
      const boundary = await getClock(record);
      if (current !== record) return { ignored: true };
      if (!AudioWatchCore.validBoundary(message.start, boundary.time)) throw fail('播放時間不連續，已丟棄這段錄音。');
      const binary = atob(message.base64);
      if (binary.length > AudioWatchCore.MAX_BYTES) throw fail('音訊超過 2 MB 上限。');
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const form = new FormData();
      form.append('audioSessionId', record.audioSessionId); form.append('chunkId', message.chunkId);
      form.append('start', String(AudioWatchCore.roundTime(message.start))); form.append('end', String(AudioWatchCore.roundTime(boundary.time))); form.append('confirmAudio', 'true');
      form.append('file', new Blob([bytes], { type: message.mimeType }), `${message.chunkId}.webm`);
      record.usedChunks += 1; // An uncertain failed attempt may already be billable.
      await notify(record, 'AUDIO_STATUS', { text: `第 ${record.usedChunks}${record.maxChunks === null ? '（全本機不限總段數）' : `/${record.maxChunks}`} 段辨識中（不新增錄音；逐字稿會延遲）` });
      const result = await api(record.config, '/api/watch/audio/chunk', form, `audio:${record.runId}:chunk`);
      if (current !== record) return { ignored: true };
      if (result.audioSessionId !== record.audioSessionId || result.chunkId !== message.chunkId || !Array.isArray(result.cues) || !result.cues.every(cue => WatchCore.validCue(cue) && cue.start >= message.start && cue.end <= boundary.time + 0.01)) throw fail('辨識結果時間或工作不相符。', 'AUDIO_INVALID_RESPONSE');
      await notify(record, 'AUDIO_RESULT', { result, start: message.start, end: boundary.time });
      if ((record.maxChunks !== null && record.usedChunks >= record.maxChunks)) await stop('已達收音上限；可點時間戳回放已辨識片段。');
      else { await offscreen({ type: 'OFFSCREEN_RELEASE', runId: record.runId }); if (current === record) record.phase = 'waiting'; }
      return { accepted: true };
    } catch (error) { if (current === record) await stop(`${error.message} ${record.processingMode === 'local' ? '已停止本機處理，不會改用雲端。' : '未自動重試，避免額外費用。'}`); throw error; }
  }
  async function handle(message, sender) {
    if (message.type.startsWith('POPUP_AUDIO_')) {
      if (!isPopup(sender)) throw fail('收音只能由使用者手動點擊擴充功能啟動。', 'FORBIDDEN', 403);
      if (message.type === 'POPUP_AUDIO_START') return start(message);
      if (message.type === 'POPUP_AUDIO_STOP') { await stop('使用者已停止收音。'); return { stopped: true }; }
      throw fail('未知的收音操作。');
    }
    if (message.type === 'AUDIO_CAPTURED' || message.type === 'AUDIO_CAPTURE_ERROR') return captured(message, sender);
    if (message.type === 'AUDIO_CLOCK') return clock(message, sender);
    if (message.type === 'AUDIO_STOP') {
      const tab = await contentTab(sender, true);
      if (current?.tabId === tab.id && current.runId === message.runId) await stop(typeof message.reason === 'string' ? message.reason.slice(0, 160) : '影片狀態改變，已停止收音。', message.clear === true);
      return { stopped: true };
    }
    throw fail('未知的收音訊息。');
  }
  if (chrome.tabs.onActivated) chrome.tabs.onActivated.addListener(({ tabId }) => { if (current && current.tabId !== tabId) void stop('分頁切到背景，已停止收音。'); });
  if (chrome.windows?.onFocusChanged) chrome.windows.onFocusChanged.addListener(windowId => { if (current && windowId !== current.windowId) void stop('Chrome 視窗不在前景，已停止收音。'); });
  return { handle, stop, tabClosed: async tabId => { if (current?.tabId === tabId) await stop('分頁已關閉。', true); }, tabNavigated: async (tabId, url) => { if (current?.tabId === tabId && WatchCore.youtubeUrl(url)?.id !== current.videoId) await stop('影片已切換，已停止收音。', true); } };
})();
