/* global chrome, WatchCore, AudioWatch, importScripts */
'use strict';
importScripts('core.js');
const SETTINGS_KEY = 'watchSettings';
const SESSION_PREFIX = 'watchSession:';
const controllers = new Map();
const busySessions = new Set();
const creatingTabs = new Map();
// Pairing token is never accessible to YouTube content scripts or chrome.storage.sync.
const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]);
function fail(message, code = 'EXTENSION_ERROR', status = 400) { return Object.assign(new Error(message), { code, status }); }
async function settings() {
  await storageReady;
  return WatchCore.boundedSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
}
function isPopup(sender) { return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html') && !sender.tab; }
async function contentTab(sender, allowDeparted = false) {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) throw fail('不允許的訊息來源。', 'FORBIDDEN', 403);
  const frame = new URL(sender.url || 'about:blank');
  if (frame.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(frame.hostname)) throw fail('只接受 YouTube 主頁面的訊息。', 'FORBIDDEN', 403);
  const tab = await chrome.tabs.get(sender.tab.id);
  const url = new URL(tab.url || 'about:blank');
  if (!allowDeparted && (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname))) throw fail('目前已離開 YouTube。', 'FORBIDDEN', 403);
  return tab;
}
async function allowed(tab, config) {
  const video = WatchCore.youtubeUrl(tab.url);
  if (!video || !config.enabled || !config.consent || !config.token) return false;
  const keys = [`watchActive:${tab.id}`, `watchBlocked:${tab.id}`];
  const state = await chrome.storage.session.get(keys);
  return state[keys[1]] !== video.id && (config.autoMode || state[keys[0]] === video.id);
}
async function publicConfig(tab) {
  const config = await settings();
  return { enabled: await allowed(tab, config), autoMode: config.autoMode, mode: config.mode, maxBatches: config.maxBatches, localFullPrefetch: config.localFullPrefetch && config.consent && config.consentMode === 'local' };
}
async function broadcast() {
  const tabs = await chrome.tabs.query({ url: ['https://www.youtube.com/*', 'https://youtube.com/*'] });
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: 'WATCH_STATE_CHANGED' }, { frameId: 0 })));
}
function allowedApiRoute(method, route) {
  if (method === 'POST') return /^\/api\/(watch\/(session|window|session\/[A-Za-z0-9_-]{8,128}\/stop|audio\/(session|chunk|session\/[A-Za-z0-9_-]{8,128}\/stop))|live\/(session|chunk|session\/[a-f0-9-]{36}\/stop))$/.test(route);
  return (method === 'GET' && (route === '/api/watch/status' || /^\/api\/live\/session\/[a-f0-9-]{36}$/.test(route))) || (['GET', 'DELETE'].includes(method) && /^\/api\/watch\/jobs\/[a-f0-9-]{36}$/i.test(route));
}
async function api(config, path, body, key, timeout = 120000) {
  // Never accept a caller-provided URL, headers, route or HTTP method.
  const method = path === '/api/watch/status' || /^\/api\/live\/session\/[a-f0-9-]{36}$/.test(path) ? 'GET' : 'POST';
  if (!allowedApiRoute(method, path)) throw fail('不允許的 API 路由。', 'FORBIDDEN', 403);
  const origin = WatchCore.serverOrigin(config.server);
  const controller = new AbortController();
  if (key) controllers.set(key, controller);
  const timer = setTimeout(() => controller.abort(), timeout);
  let jobId = null;
  let completed = false;
  const jobPath = id => `/api/watch/jobs/${id}`;
  function assertJobId(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw fail('本機工作編號無效。', 'INVALID_RESPONSE', 502);
    return id;
  }
  async function wire(method, route, payload, preferAsync = false) {
    if (!allowedApiRoute(method, route)) throw fail('不允許的 API 路由。', 'FORBIDDEN', 403);
    // Each HTTP request ends before Chrome's 30-second fetch-response deadline.
    const requestTimer = setTimeout(() => controller.abort(), Math.min(timeout, 25000));
    try {
      const response = await fetch(origin + route, {
        method, headers: { Authorization: `Bearer ${config.token}`, ...(payload === undefined || (typeof FormData !== 'undefined' && payload instanceof FormData) ? {} : { 'Content-Type': 'application/json' }), ...(preferAsync ? { Prefer: 'respond-async' } : {}) },
        ...(payload === undefined ? {} : { body: typeof FormData !== 'undefined' && payload instanceof FormData ? payload : JSON.stringify(payload) }),
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw fail(typeof result.error === 'string' ? result.error : `本機 API 回傳 ${response.status}。`, result.code || 'API_ERROR', response.status);
      return { result, status: response.status };
    } finally { clearTimeout(requestTimer); }
  }
  function waitPoll() {
    return new Promise((resolve, reject) => {
      if (controller.signal.aborted) { reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); return; }
      const abort = () => { clearTimeout(wait); reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); };
      const wait = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, 1500);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
  }
  try {
    const asyncJob = path === '/api/watch/session' || path === '/api/watch/window' || path === '/api/watch/audio/session' || path === '/api/watch/audio/chunk' || path === '/api/live/chunk';
    let response = await wire(method, path, body, asyncJob);
    if (response.status !== 202) { completed = true; return response.result; }
    jobId = assertJobId(response.result.jobId);
    while (response.status === 202) {
      // Bounded API activity during a real job, not an always-on service worker.
      await chrome.runtime.getPlatformInfo();
      await waitPoll();
      response = await wire('GET', jobPath(jobId));
      if (response.result.jobId && response.result.jobId !== jobId) throw fail('工作回應不相符。', 'INVALID_RESPONSE', 502);
    }
    if (response.result.status !== 'done' || !response.result.result) throw fail('本機工作尚未正確完成。', 'INVALID_RESPONSE', 502);
    completed = true;
    return response.result.result;
  } catch (error) {
    if (error.name === 'AbortError') throw fail('請求已停止或逾時，尚未完成的翻譯不會顯示。', 'ABORTED', 408);
    if (error.code) throw error;
    throw fail('無法連線本機 YT Summary，請確認伺服器已啟動、網址與配對權杖正確。', 'NETWORK_ERROR', 503);
  } finally {
    clearTimeout(timer);
    if (key && controllers.get(key) === controller) controllers.delete(key);
    if (jobId && !completed) {
      // Parent abort must not abort cleanup's separate short request.
      const cleanup = new AbortController();
      const cleanupTimer = setTimeout(() => cleanup.abort(), 5000);
      await fetch(origin + jobPath(jobId), { method: 'DELETE', headers: { Authorization: `Bearer ${config.token}` }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: cleanup.signal }).catch(() => {});
      clearTimeout(cleanupTimer);
    }
  }
}
async function stopRecord(id, config) {
  controllers.get(id)?.abort();
  await chrome.storage.session.remove(SESSION_PREFIX + id);
  await api(config, `/api/watch/session/${id}/stop`, {}, null, 5000).catch(() => {});
}
async function stopAll(config, tabId) {
  for (const [id, active] of creatingTabs) if (tabId === undefined || id === tabId) controllers.get(`create:${id}:${active.requestId}`)?.abort();
  const state = await chrome.storage.session.get(null);
  await Promise.allSettled(Object.entries(state).filter(([key, value]) => key.startsWith(SESSION_PREFIX) && (tabId === undefined || value.tabId === tabId))
    .map(([key]) => stopRecord(key.slice(SESSION_PREFIX.length), config)));
}
async function handlePopup(message) {
  const previous = await settings();
  if (message.type === 'POPUP_PAIR') {
    const incoming = WatchCore.boundedSettings({ ...previous, server: message.server, token: message.token });
    if (incoming.token.length < 16 || incoming.token.length > 512 || /^sk-/.test(incoming.token) || /[\r\n]/.test(incoming.token)) throw fail('請輸入 /watch 的配對權杖，不是模型 API key。');
    const result = await api(incoming, '/api/watch/status', undefined, null, 10000);
    await globalThis.LiveWatch?.stop('user');
    await AudioWatch.stop('配對設定已變更。', true);
    await stopAll(previous);
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...incoming, enabled: false } });
    await broadcast();
    return result;
  }
  if (message.type === 'POPUP_SETTINGS') return previous;
  if (message.type === 'POPUP_STATUS') return api(previous, '/api/watch/status', undefined, null, 10000);
  if (message.type === 'POPUP_DISABLE') {
    await globalThis.LiveWatch?.stop('user');
    await AudioWatch.stop('已全部停用。', true);
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...previous, enabled: false } });
    await broadcast();
    await stopAll(previous);
    return { enabled: false };
  }
  if (message.type !== 'POPUP_ENABLE') throw fail('未知的設定操作。');
  await AudioWatch.stop('切換為原文字幕模式。', true);
  const config = WatchCore.boundedSettings({ ...message.settings, consentMode: message.expectedProcessingMode });
  if (!config.enabled || !config.consent || config.token.length < 16 || config.token.length > 512 || /^sk-/.test(config.token) || /[\r\n]/.test(config.token)) throw fail('請同意字幕傳送與費用，並輸入 /watch 的有效配對權杖。');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const video = WatchCore.youtubeUrl(tab?.url);
  if (!video) throw fail('請先切到 YouTube 的 /watch 影片頁面，再按啟用。');
  // Clear old sessions with their original credentials before changing the server/token.
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...previous, enabled: false } });
  await broadcast();
  await stopAll(previous);
  const localState = await chrome.storage.session.get(null);
  await chrome.storage.session.remove(Object.keys(localState).filter(key => key.startsWith('watchActive:')));
  await chrome.storage.session.set({ [`watchActive:${tab.id}`]: video.id });
  await chrome.storage.session.remove(`watchBlocked:${tab.id}`);
  await chrome.storage.local.set({ [SETTINGS_KEY]: config });
  await broadcast();
  let delivered = true;
  await chrome.tabs.sendMessage(tab.id, { type: 'WATCH_STATE_CHANGED' }, { frameId: 0 }).catch(() => { delivered = false; });
  return { message: delivered ? '已啟用目前影片。開始播放後會載入原文並分批翻譯；暫停時不新增請求。' : '設定已儲存。請重新整理 YouTube 頁面，讓擴充功能載入。' };
}
async function handleContent(message, sender) {
  const tab = await contentTab(sender, ['WATCH_STOP', 'WATCH_CANCEL_CREATE', 'WATCH_CANCEL_WINDOW'].includes(message.type));
  if (message.type === 'WATCH_CONFIG') return publicConfig(tab);
  if (message.type === 'WATCH_CANCEL_CREATE') {
    const active = creatingTabs.get(tab.id);
    if (active && active.requestId === message.requestId) controllers.get(`create:${tab.id}:${active.requestId}`)?.abort();
    return { cancelled: true };
  }
  const config = await settings();
  if (message.type === 'WATCH_CLOSE') {
    const video = WatchCore.youtubeUrl(tab.url);
    if (video) await chrome.storage.session.set({ [`watchBlocked:${tab.id}`]: video.id });
    await chrome.storage.session.remove(`watchActive:${tab.id}`);
    await stopAll(config, tab.id);
    return { stopped: true };
  }
  const sessionId = message.sessionId;
  if (message.type === 'WATCH_STOP' || message.type === 'WATCH_WINDOW' || message.type === 'WATCH_CANCEL_WINDOW') {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) throw fail('無效的工作階段。');
    const key = SESSION_PREFIX + sessionId;
    const record = (await chrome.storage.session.get(key))[key];
    if (!record || record.tabId !== tab.id) {
      if (message.type === 'WATCH_STOP' || message.type === 'WATCH_CANCEL_WINDOW') return { stopped: true };
      throw fail('工作階段已結束，請重新啟用。', 'SESSION_EXPIRED', 410);
    }
    if (message.type === 'WATCH_STOP') { await stopRecord(sessionId, config); return { stopped: true }; }
    if (message.type === 'WATCH_CANCEL_WINDOW') { controllers.get(sessionId)?.abort(); return { cancelled: true }; }
    if (!await allowed(tab, config) || WatchCore.youtubeUrl(tab.url)?.id !== record.videoId) throw fail('目前影片尚未啟用翻譯。', 'NOT_ENABLED', 403);
    if (!Number.isFinite(message.time) || message.time < 0 || message.time > record.maxTime + 1) throw fail('無效的播放時間。');
    if (WatchCore.limitReached(record, Math.max(record.callsUsed, record.reservedCalls || 0), config.maxBatches)) throw fail('已達這支影片的翻譯批次上限；已載入的字幕仍可使用。', 'EXTENSION_LIMIT', 429);
    if (busySessions.has(sessionId)) throw fail('正在翻譯上一批，請稍候。', 'BUSY', 503);
    busySessions.add(sessionId);
    // Reserve before the request: failures/aborts may already have incurred provider cost.
    // A successful cache hit releases its reservation; uncertain failures remain counted.
    const reserved = { ...record, reservedCalls: (record.reservedCalls || 0) + 1 };
    await chrome.storage.session.set({ [key]: reserved });
    try {
      const result = await api(config, '/api/watch/window', { sessionId, time: message.time, confirmTranslation: true }, sessionId);
      if ((await chrome.storage.session.get(key))[key]) await chrome.storage.session.set({ [key]: { ...reserved, reservedCalls: Math.max(0, reserved.reservedCalls - (result.cached ? 1 : 0)), callsUsed: Number(result.callsUsed) || record.callsUsed } });
      return result;
    } finally { busySessions.delete(sessionId); }
  }
  if (message.type !== 'WATCH_SESSION') throw fail('未知的內容操作。');
  if (!await allowed(tab, config)) throw fail('請先在擴充功能同意並啟用這支影片。', 'NOT_ENABLED', 403);
  const video = WatchCore.youtubeUrl(tab.url);
  if (!video || WatchCore.youtubeUrl(message.url)?.id !== video.id) throw fail('影片已切換，忽略舊請求。', 'STALE_VIDEO', 409);
  if (typeof message.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(message.requestId)) throw fail('原文請求編號無效。');
  const active = creatingTabs.get(tab.id);
  if (active) {
    if (active.videoId !== video.id) controllers.get(`create:${tab.id}:${active.requestId}`)?.abort();
    throw fail('原文字幕正在切換，請稍候。', 'BUSY', 503);
  }
  const creation = { requestId: message.requestId, videoId: video.id };
  creatingTabs.set(tab.id, creation);
  try {
    const result = await api(config, '/api/watch/session', { url: video.url, sourceLanguage: 'en' }, `create:${tab.id}:${creation.requestId}`);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(result.sessionId || '') || !Array.isArray(result.cues) || !result.cues.every(WatchCore.validCue)) throw fail('本機回傳的字幕格式不正確。', 'INVALID_RESPONSE', 502);
    if (config.consentMode === 'local' && !WatchCore.isLocalProcessing(result)) {
      await api(config, `/api/watch/session/${result.sessionId}/stop`, {}, null, 5000).catch(() => {});
      throw fail('後端模式已改變；尚未同意雲端傳送，請重新開啟擴充功能確認。', 'PROCESSING_MODE_CHANGED', 403);
    }
    const current = await chrome.tabs.get(tab.id).catch(() => null);
    const currentConfig = await settings();
    if (currentConfig.server !== config.server || currentConfig.token !== config.token || !current || WatchCore.youtubeUrl(current.url)?.id !== video.id || !await allowed(current, currentConfig)) {
      await api(config, `/api/watch/session/${result.sessionId}/stop`, {}, null, 5000).catch(() => {});
      throw fail('影片已切換或已停用。', 'STALE_VIDEO', 409);
    }
    await chrome.storage.session.set({ [SESSION_PREFIX + result.sessionId]: {
      tabId: tab.id, videoId: video.id, callsUsed: 0, reservedCalls: 0,
      processingMode: result.processingMode === 'local' ? 'local' : 'cloud', unlimited: result.unlimited === true,
      sessionLimit: result.limits?.sessionCalls === null ? null : Number(result.limits?.sessionCalls) || config.maxBatches,
      maxTime: Math.max(0, ...result.cues.map(cue => cue.end)),
    } });
    return result;
  } finally { if (creatingTabs.get(tab.id) === creation) creatingTabs.delete(tab.id); }
}
importScripts('audio-background.js');
importScripts('live-background.js');
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string' || message.target === 'offscreen') return false;
  (async () => {
    await storageReady;
    if (message.type.startsWith('LIVE_') || message.type.startsWith('POPUP_LIVE_')) return globalThis.LiveWatch.handle(message, sender);
    if (message.type.startsWith('AUDIO_') || message.type.startsWith('POPUP_AUDIO_')) return AudioWatch.handle(message, sender);
    return isPopup(sender) ? handlePopup(message) : handleContent(message, sender);
  })().then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message, code: error.code || 'EXTENSION_ERROR', status: error.status || 400 }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  void globalThis.LiveWatch.tabClosed(tabId);
  void AudioWatch.tabClosed(tabId);
  const active = creatingTabs.get(tabId);
  if (active) controllers.get(`create:${tabId}:${active.requestId}`)?.abort();
  void settings().then(config => stopAll(config, tabId));
  void chrome.storage.session.remove([`watchActive:${tabId}`, `watchBlocked:${tabId}`]);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url) return;
  void globalThis.LiveWatch.tabNavigated(tabId, change.url);
  void AudioWatch.tabNavigated(tabId, change.url);
  const video = WatchCore.youtubeUrl(change.url);
  const active = creatingTabs.get(tabId);
  if (active && active.videoId !== video?.id) controllers.get(`create:${tabId}:${active.requestId}`)?.abort();
  // Cleanup also handles hard navigation where the old content script cannot send stop.
  void (async () => {
    const config = await settings();
    const state = await chrome.storage.session.get(null);
    await Promise.allSettled(Object.entries(state).filter(([key, record]) => key.startsWith(SESSION_PREFIX) && record.tabId === tabId && record.videoId !== video?.id)
      .map(([key]) => stopRecord(key.slice(SESSION_PREFIX.length), config)));
  })();
});
