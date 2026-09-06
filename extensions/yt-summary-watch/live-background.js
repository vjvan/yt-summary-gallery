/* global chrome, WatchCore, AudioWatch, LiveCore, importScripts, api, fail, settings, isPopup, stopAll, broadcast, SETTINGS_KEY, controllers */
importScripts('live-core.js');
globalThis.LiveWatch = (() => {
  'use strict';
  let current = null, prepared = null, preparingOffscreen = null, lifecycle = 0;
  let lastView = { active: false, message: '尚未收音。Discord 需每次手動同意。' };
  const KEY = 'watchLiveActive';
  const trustedOffscreen = sender => sender.id === chrome.runtime.id && !sender.tab && sender.url === chrome.runtime.getURL('offscreen.html');
  async function offscreen(message) {
    const result = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
    if (!result?.ok) throw fail(result?.error || '分頁音訊程序未就緒。', 'LIVE_CAPTURE_FAILED');
    return result;
  }
  async function ensureOffscreen() {
    if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')] })).length) return;
    if (!preparingOffscreen) preparingOffscreen = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Capture only the explicitly consented Discord tab audio locally; no microphone, video or chat access.' }).finally(() => { preparingOffscreen = null; });
    await preparingOffscreen;
  }
  const queueSeconds = record => record.queue.reduce((total, item) => total + item.end - item.start, 0) + (record.inflight ? record.inflight.end - record.inflight.start : 0);
  async function badge(text, warning = false) {
    await chrome.action?.setBadgeText({ text }).catch(() => {});
    await chrome.action?.setBadgeBackgroundColor({ color: warning ? '#a83232' : '#157d60' }).catch(() => {});
  }
  async function persist(record) {
    if (current !== record) return;
    await chrome.storage.session.set({ [KEY]: { runId: record.runId, sessionId: record.sessionId, tabId: record.tabId, url: record.url, title: record.title, unprocessedSeconds: LiveCore.roundTime(queueSeconds(record) + record.partialSeconds) } });
  }
  async function stop(reason = 'user', extraSeconds = 0, detail = '') {
    lifecycle++;
    const record = current;
    if (!record) {
      const saved = (await chrome.storage.session.get(KEY))[KEY];
      if (!saved) return { stopped: true };
      await chrome.storage.session.remove(KEY);
      await offscreen({ type: 'LIVE_OFFSCREEN_STOP', runId: saved.runId }).catch(() => {});
      if (LiveCore.validId(saved.sessionId)) await api(await settings(), `/api/live/session/${saved.sessionId}/stop`, { reason: 'server-unavailable', unprocessedSeconds: Math.min(21600, saved.unprocessedSeconds || 0) }, null, 5000).catch(() => {});
      lastView = { active: false, sessionId: saved.sessionId, url: saved.url, message: '控制程式曾中斷，已停止舊音軌；未完成音訊不會自動恢復。' };
      await badge(''); return { stopped: true };
    }
    current = null;
    const remaining = queueSeconds(record) + Math.max(record.partialSeconds || 0, extraSeconds);
    record.queue.length = 0;
    controllers.get(`live:${record.runId}:chunk`)?.abort(); controllers.get(`live:${record.runId}:start`)?.abort();
    const capture = await offscreen({ type: 'LIVE_OFFSCREEN_STOP', runId: record.runId }).catch(() => ({}));
    const unprocessedSeconds = LiveCore.roundTime(Math.min(21600, Math.max(remaining, queueSeconds(record) + (capture.partialSeconds || 0))));
    const messages = { user: '已停止 Discord 直播收音。', 'queue-overflow': '處理速度落後、待處理音訊超過 30 秒，已自動停止；沒有偷偷略過音訊繼續收音。', 'source-closed': '來源分頁已關閉或離開原頻道，已停止。', 'server-unavailable': '無法連線本機翻譯台，已停止音軌。', 'mode-changed': '本機處理模式或就緒狀態改變，已停止；不轉雲端。', 'capture-error': '分頁收音中斷，已停止。', 'permission-revoked': '分頁收音權限已被結束，已停止。' };
    lastView = { active: false, sessionId: record.sessionId, url: record.url, title: record.title, message: `${messages[reason] || messages['capture-error']} ${detail} 尚未完成約 ${unprocessedSeconds.toFixed(1)} 秒音訊。`, unprocessedSeconds };
    const saved = (await chrome.storage.session.get(KEY))[KEY];
    if (saved?.runId === record.runId) await chrome.storage.session.remove(KEY);
    await badge('');
    if (record.sessionId) await api(record.config, `/api/live/session/${record.sessionId}/stop`, { reason, unprocessedSeconds }, null, 5000).catch(() => {});
    return { stopped: true, ...lastView };
  }
  async function sourceTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = LiveCore.discordUrl(tab?.url);
    return url ? { tabId: tab.id, url, title: String(tab.title || 'Discord 直播').slice(0, 300) } : null;
  }
  async function prepare() {
    if (!current) await stop('user'); // Clean orphan audio; never auto-resume it.
    const source = await sourceTab();
    const config = await settings();
    const provider = await api(config, '/api/watch/status', undefined, null, 10000);
    prepared = source && LiveCore.ready(provider) ? { ...source, config, at: Date.now() } : null;
    if (prepared) await ensureOffscreen(); // Empty document only; no getUserMedia before manual start.
    return { ...(await view()), source, ready: !!prepared, processingMode: provider.processingMode, providerMessage: provider.translationStatusMessage || (!LiveCore.ready(provider) ? '需要已就緒的全本機辨識與翻譯，不能使用雲端。' : '本機辨識與翻譯設定已就緒。') };
  }
  async function view() {
    const source = await sourceTab();
    if (!current) return { ...lastView, source, ready: !!prepared && prepared.url === source?.url && Date.now() - prepared.at < 120000 };
    const seconds = LiveCore.roundTime(queueSeconds(current));
    return { active: true, sessionId: current.sessionId, url: current.url, title: current.title, source, ready: false, queueSeconds: seconds, message: `${current.phase === 'starting' ? '正在建立本機工作' : '持續收音中'} · 待處理 ${seconds.toFixed(1)} 秒${seconds >= 12 ? '，處理落後；達 30 秒會自動停止' : ''}。切到翻譯台或其他分頁仍會收音。` };
  }
  async function start(message) {
    if (message.confirmAudio !== true) throw fail('每次需重新同意擷取所示 Discord 分頁音訊；切到背景仍會收音。', 'LIVE_CONSENT_REQUIRED', 403);
    const source = prepared;
    if (!source || Date.now() - source.at > 120000 || message.sourceTabId !== source.tabId || message.sourceUrl !== source.url) throw fail('來源或本機就緒檢查已失效；請按重新檢查，確認來源後再手動開始。', 'LIVE_PREPARE_REQUIRED', 403);
    prepared = null;
    // Invoke within this user-triggered handler BEFORE any network/storage/stop await.
    const streamPromise = chrome.tabCapture.getMediaStreamId({ targetTabId: source.tabId });
    streamPromise.catch(() => {});
    const stopPrevious = stop('user').catch(() => {}); const stopYoutube = AudioWatch.stop('開始 Discord 直播翻譯，停止 YouTube 收音。', true).catch(() => {});
    const epoch = lifecycle;
    const record = { runId: crypto.randomUUID(), ...source, queue: [], inflight: null, partialSeconds: 0, nextSequence: 0, lastEnd: 0, sessionId: null, phase: 'starting', lastPoll: 0, polling: false };
    current = record;
    try {
      const tab = await chrome.tabs.get(source.tabId);
      if (LiveCore.discordUrl(tab.url) !== source.url || !tab.active) throw fail('目前分頁已切換，請重新確認來源。', 'LIVE_SOURCE_CHANGED');
      // Server rechecks local mode/readiness and explicit consent. No audio is obtained before this succeeds.
      const session = await api(record.config, '/api/live/session', { url: record.url, title: record.title, confirmAudio: true }, `live:${record.runId}:start`, 10000);
      if (current !== record || epoch !== lifecycle) { if (LiveCore.validId(session.sessionId)) await api(record.config, `/api/live/session/${session.sessionId}/stop`, { reason: 'user' }, null, 5000).catch(() => {}); return { started: false }; }
      if (LiveCore.validId(session.sessionId)) record.sessionId = session.sessionId;
      if (!LiveCore.validId(session.sessionId) || session.processingMode !== 'local' || (session.status || session.state) !== 'active') throw fail('伺服器未確認全本機直播工作，音訊不會送出。', 'LIVE_MODE_REQUIRED');
      record.sessionId = session.sessionId;
      const streamId = await streamPromise;
      // Previous stops close tracks synchronously before their remote cleanup completes.
      await offscreen({ type: 'LIVE_OFFSCREEN_START', runId: record.runId, streamId });
      if (current !== record) { await offscreen({ type: 'LIVE_OFFSCREEN_STOP', runId: record.runId }).catch(() => {}); return { started: false }; }
      record.phase = 'recording';
      await chrome.storage.local.set({ [SETTINGS_KEY]: { ...record.config, enabled: false } });
      void stopAll(record.config); void broadcast(); void stopPrevious; void stopYoutube;
      await persist(record); await badge('LIVE');
      return { started: true, ...(await view()) };
    } catch (cause) { if (current === record) await stop(cause.code === 'LIVE_MODE_REQUIRED' ? 'mode-changed' : 'capture-error', 0, cause.message); throw cause; }
  }
  async function pump(record) {
    if (current !== record || record.inflight || !record.queue.length) return;
    const item = record.queue.shift(); record.inflight = item;
    try {
      const bytes = Uint8Array.from(atob(item.base64), value => value.charCodeAt(0));
      const form = new FormData(); form.append('sessionId', record.sessionId); form.append('sequence', String(item.sequence));
      form.append('start', String(LiveCore.roundTime(item.start))); form.append('end', String(LiveCore.roundTime(item.end)));
      form.append('audio', new Blob([bytes], { type: 'audio/wav' }), `live-${item.sequence}.wav`);
      if (item.gapReason) form.append('gapReason', item.gapReason);
      const result = await api(record.config, '/api/live/chunk', form, `live:${record.runId}:chunk`);
      if (current !== record) return;
      if (result.sessionId !== record.sessionId || result.sequence !== item.sequence) throw fail('辨識結果與直播片段不一致。', 'LIVE_INVALID_RESPONSE');
      record.inflight = null;
      await persist(record); await badge(record.queue.length ? `${Math.ceil(queueSeconds(record))}s` : 'LIVE', queueSeconds(record) >= 12);
      void pump(record);
    } catch (cause) { if (current === record) await stop('server-unavailable', 0, cause.message); }
  }
  async function captured(message) {
    const record = current;
    if (!record || message.runId !== record.runId) return { ignored: true };
    if (record.phase !== 'recording' || !Number.isInteger(message.sequence) || message.sequence !== record.nextSequence || !Number.isFinite(message.start) || !Number.isFinite(message.end) || message.start < record.lastEnd - 0.000001 || message.end - message.start < 0.2 || message.end - message.start > 8.001 || typeof message.base64 !== 'string' || message.base64.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.base64) || ![undefined, 'silence'].includes(message.gapReason)) {
      await stop('capture-error', 0, '音訊片段序號或 sample clock 不連續。'); throw fail('音訊片段格式不正確。', 'LIVE_INVALID_CHUNK');
    }
    const tab = await chrome.tabs.get(record.tabId).catch(() => null);
    if (current !== record) return { ignored: true };
    if (LiveCore.discordUrl(tab?.url) !== record.url) { await stop('source-closed'); return { ignored: true }; }
    const duration = message.end - message.start;
    if (queueSeconds(record) + duration > LiveCore.MAX_QUEUE_SECONDS) { await stop('queue-overflow', duration); return { active: false, stopped: true }; }
    record.nextSequence++; record.lastEnd = message.end;
    record.queue.push({ sequence: message.sequence, start: message.start, end: message.end, gapReason: message.gapReason, base64: message.base64 });
    await persist(record); await badge(`${Math.ceil(queueSeconds(record))}s`, queueSeconds(record) >= 12); void pump(record);
    return { accepted: true, queueSeconds: queueSeconds(record) };
  }
  async function heartbeat(message) {
    const record = current;
    if (!record || record.runId !== message.runId) { if (!record) void stop('server-unavailable'); return { active: false }; }
    record.partialSeconds = Math.max(0, Math.min(8, Number(message.partialSeconds) || 0));
    const tab = await chrome.tabs.get(record.tabId).catch(() => null);
    if (current !== record) return { active: false };
    if (LiveCore.discordUrl(tab?.url) !== record.url) { await stop('source-closed'); return { active: false }; }
    if (!record.polling && Date.now() - record.lastPoll >= 2000) {
      record.polling = true; record.lastPoll = Date.now();
      void api(record.config, `/api/live/session/${record.sessionId}`, undefined, null, 5000).then(result => {
        if (current !== record) return;
        if (result.sessionId !== record.sessionId || result.processingMode !== 'local') return stop('mode-changed');
        if ((result.status || result.state) !== 'active') return stop('user', 0, '翻譯台已結束這次工作。');
      }).catch(cause => { if (current === record) return stop('server-unavailable', 0, cause.message); }).finally(() => { record.polling = false; });
    }
    return { active: true, queueSeconds: queueSeconds(record) };
  }
  async function handle(message, sender) {
    if (message.type.startsWith('POPUP_LIVE_')) {
      if (!isPopup(sender)) throw fail('直播收音只接受擴充功能的手動操作。', 'FORBIDDEN', 403);
      if (message.type === 'POPUP_LIVE_PREPARE') return prepare();
      if (message.type === 'POPUP_LIVE_STATE') return view();
      if (message.type === 'POPUP_LIVE_START') return start(message);
      if (message.type === 'POPUP_LIVE_STOP') return stop('user');
      if (message.type === 'POPUP_LIVE_OPEN') { const config = await settings(); const sessionId = current?.sessionId || lastView.sessionId; const url = `${WatchCore.serverOrigin(config.server)}/live${LiveCore.validId(sessionId) ? `?session=${sessionId}` : ''}`; await chrome.tabs.create({ url }); return { opened: true }; }
      throw fail('未知的直播操作。');
    }
    if (!trustedOffscreen(sender)) throw fail('不接受網站或其他分頁的音訊訊息。', 'FORBIDDEN', 403);
    if (message.type === 'LIVE_CAPTURED') return captured(message);
    if (message.type === 'LIVE_HEARTBEAT') return heartbeat(message);
    if (message.type === 'LIVE_CAPTURE_ERROR') { if (current?.runId === message.runId) await stop('capture-error', message.partialSeconds, typeof message.error === 'string' ? message.error.slice(0, 200) : ''); return { stopped: true }; }
    throw fail('未知的直播訊息。');
  }
  return { handle, stop, async tabClosed(tabId) { if (current?.tabId === tabId) await stop('source-closed'); }, async tabNavigated(tabId, url) { if (current?.tabId === tabId && LiveCore.discordUrl(url) !== current.url) await stop('source-closed'); } };
})();
