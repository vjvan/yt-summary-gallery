(function (scope) {
  'use strict';
  const CHUNK_SECONDS = 12;
  const MAX_BYTES = 2 * 1024 * 1024;
  function unsafeClock(clock, videoId, now = Date.now()) {
    if (!clock || clock.videoId !== videoId) return '影片已切換。';
    if (!clock.visible) return '分頁不在前景，已停止收音。';
    if (clock.ad) return '進入廣告，已停止收音。';
    if (clock.paused || clock.ended || clock.seeking) return '影片暫停、結束或跳轉，已停止收音。';
    if (clock.rate !== 1) return '實驗版只支援 1 倍速。';
    if (!Number.isFinite(clock.time) || clock.time < 0 || !Number.isFinite(clock.observedAt) || Math.abs(now - clock.observedAt) > 2000) return '影片時鐘已失效。';
    return null;
  }
  function roundTime(value) { return Math.round(value * 1e6) / 1e6; }
  function maxChunks(value) { return Math.min(20, Math.max(2, Math.floor(Number(value) || 2))); }
  function validBoundary(start, end) { return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end - start >= 11 && end - start <= 13.5; }
  function validRun(value) { return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value); }
  function validBase64(value) { return typeof value === 'string' && value.length > 0 && value.length <= Math.ceil(MAX_BYTES / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(value); }
  const helpers = { CHUNK_SECONDS, MAX_BYTES, unsafeClock, roundTime, maxChunks, validBoundary, validRun, validBase64 };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  scope.AudioWatchCore = helpers;
})(globalThis);
