/* global chrome, WatchCore, AudioWatchCore */
(() => {
  'use strict';
  const MAX_REPLAY_CLIPS = 100;
  const MAX_REPLAY_CUES = 500;
  let state = null;
  let video = null;
  let host = null;
  let transcript = null;
  let status = null;
  let subtitle = null;
  let postingClock = false;
  const videoEvents = ['pause', 'seeking', 'ratechange', 'ended', 'play', 'timeupdate'];
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || '分頁收音控制已中斷。');
    return response.data;
  }
  function attachVideo() {
    const found = document.getElementById('movie_player')?.querySelector('video.html5-main-video') || null;
    if (found === video) return;
    if (video) for (const name of videoEvents) video.removeEventListener(name, tick);
    video = found;
    if (video) for (const name of videoEvents) video.addEventListener(name, tick);
  }
  function getClock() {
    attachVideo();
    const player = document.getElementById('movie_player');
    return { videoId: WatchCore.youtubeUrl(location.href)?.id || null, time: AudioWatchCore.roundTime(video?.currentTime ?? NaN), observedAt: Date.now(), rate: video?.playbackRate ?? 0, paused: video?.paused ?? true, ended: video?.ended ?? false, seeking: video?.seeking ?? false, visible: document.visibilityState === 'visible', ad: Boolean(player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) };
  }
  function setStatus(text) { if (status) status.textContent = text; }
  function clear() { host?.remove(); host = null; state = null; transcript = null; status = null; subtitle = null; }
  function stop(reason, erase = false, notify = true) {
    const previous = state;
    if (previous) previous.active = false;
    if (subtitle) subtitle.textContent = '';
    setStatus(reason);
    if (notify && previous) void send({ type: 'AUDIO_STOP', runId: previous.runId, reason, clear: erase }).catch(() => {});
    if (erase) clear();
  }
  function timeLabel(value) { return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`; }
  function makePanel() {
    const player = document.getElementById('movie_player');
    if (!player) return;
    host?.remove();
    host = document.createElement('div');
    Object.assign(host.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '2147483001' });
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{all:initial}.panel{position:absolute;right:12px;top:12px;width:min(370px,65%);max-height:52%;overflow:auto;background:rgba(10,20,33,.94);border:1px solid #90b8de80;border-radius:9px;padding:12px;box-sizing:border-box;color:#fff;font:12px/1.5 system-ui,sans-serif;pointer-events:auto}.heading{display:flex;justify-content:space-between;gap:6px;align-items:center;font-weight:700}.status{color:#b9dafa;margin:8px 0}.help{color:#a8b7c8;font-size:10px}.entry{border-top:1px solid #ffffff25;margin-top:8px;padding-top:8px}.zh{font-size:13px;white-space:pre-wrap}.en{font-size:11px;color:#b1becd;white-space:pre-wrap}button{border:1px solid #647c93;border-radius:4px;background:#203a53;color:#fff;font:11px system-ui,sans-serif;padding:4px 6px;cursor:pointer}.subtitle{position:absolute;bottom:17%;left:5%;width:90%;text-align:center;white-space:pre-wrap;color:#fff;font:600 clamp(16px,2vw,28px)/1.4 system-ui,sans-serif;text-shadow:0 1px 3px #000;background:rgba(0,0,0,.82);border-radius:5px}.subtitle:empty{display:none}';
    const panel = document.createElement('section'); panel.className = 'panel'; panel.setAttribute('aria-label', '收音逐字稿（延遲）');
    const heading = document.createElement('div'); heading.className = 'heading';
    const title = document.createElement('span'); title.textContent = '收音逐字稿（延遲）';
    const stopButton = document.createElement('button'); stopButton.textContent = '停止收音'; stopButton.addEventListener('click', () => stop('使用者已停止收音。'));
    const closeButton = document.createElement('button'); closeButton.textContent = '關閉'; closeButton.addEventListener('click', () => stop('已關閉收音逐字稿。', true));
    heading.append(title, stopButton, closeButton);
    status = document.createElement('div'); status.className = 'status'; status.setAttribute('role', 'status');
    const help = document.createElement('p'); help.className = 'help'; help.textContent = '每段 12 秒；等待辨識時不新增錄音，可能有空段。點時間可回放，但會停止收音。翻譯只有在對應影片時間才疊到畫面上。即時回放只保留最近 100 個片段／500 句（先達者）；汰除舊資料不會停止收音。';
    transcript = document.createElement('div');
    panel.append(heading, status, help, transcript);
    subtitle = document.createElement('div'); subtitle.className = 'subtitle';
    root.append(style, panel, subtitle); player.append(host);
  }
  function addResult(message) {
    if (!state?.active || state.runId !== message.runId || state.videoId !== WatchCore.youtubeUrl(location.href)?.id) return;
    const resultCues = message.result?.cues;
    if (!Array.isArray(resultCues) || !resultCues.every(WatchCore.validCue)) return;
    const cues = resultCues.slice(-MAX_REPLAY_CUES);
    const entry = document.createElement('div'); entry.className = 'entry';
    const replay = document.createElement('button'); replay.textContent = `${timeLabel(message.start)}–${timeLabel(message.end)} ↻ 回放`;
    replay.addEventListener('click', () => { stop('回放已辨識片段；收音已停止。'); if (video) { video.currentTime = message.start; void video.play().catch(() => {}); } });
    const zh = document.createElement('p'); zh.className = 'zh'; zh.textContent = cues.map(cue => cue.text).join('\n');
    const en = document.createElement('p'); en.className = 'en'; en.textContent = (message.result.originalCues || []).filter(WatchCore.validCue).slice(-MAX_REPLAY_CUES).map(cue => cue.text).join('\n');
    entry.append(replay, zh, en); transcript?.append(entry);
    state.entries.push({ entry, cues });
    state.cueCount += cues.length;
    while (state.entries.length > MAX_REPLAY_CLIPS || state.cueCount > MAX_REPLAY_CUES) {
      const removed = state.entries.shift();
      state.cueCount -= removed.cues.length;
      removed.entry.remove();
    }
    state.cues.clear();
    for (const item of state.entries) for (const cue of item.cues) state.cues.set(cue.id, cue);
    setStatus(`保留最近 ${state.entries.length} 個片段／${state.cues.size} 句字幕（最多 100 片段／500 句）；這是延遲結果，不代表目前正在說的內容。`);
    render();
  }
  function render() {
    if (!state || !subtitle) return;
    const clock = getClock();
    if (clock.videoId !== state.videoId || clock.ad || clock.seeking || clock.ended) { subtitle.textContent = ''; return; }
    subtitle.textContent = WatchCore.currentCues([...state.cues.values()], clock.time).map(cue => cue.text).join('\n');
  }
  function tick() {
    if (!state) return;
    const clock = getClock();
    if (clock.videoId !== state.videoId) { stop('影片已切換，已清除收音結果。', true); return; }
    render();
    if (!state.active) return;
    const reason = AudioWatchCore.unsafeClock(clock, state.videoId);
    if (reason) { stop(reason); return; }
    if (postingClock) return;
    postingClock = true;
    const current = state;
    void send({ type: 'AUDIO_CLOCK', runId: current.runId, clock }).then(result => {
      if (state === current && current.active && !result.active) stop('收音工作已結束；需再次手動同意才能開始。', false, false);
    }).catch(error => { if (state === current) stop(error.message); }).finally(() => { postingClock = false; });
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !message?.type?.startsWith('AUDIO_')) return false;
    if (message.type === 'AUDIO_GET_CLOCK') { respond(getClock()); return false; }
    if (message.type === 'AUDIO_STARTED' && AudioWatchCore.validRun(message.runId) && message.videoId === WatchCore.youtubeUrl(location.href)?.id) {
      clear(); state = { runId: message.runId, videoId: message.videoId, active: true, cues: new Map(), entries: [], cueCount: 0 }; makePanel(); setStatus('已手動啟用收音（12 秒片段，1 倍速）。'); tick();
    } else if (state?.runId === message.runId) {
      if (message.type === 'AUDIO_STATUS') setStatus(message.text);
      else if (message.type === 'AUDIO_RESULT') addResult(message);
      else if (message.type === 'AUDIO_STOPPED') stop(message.reason, message.clear, false);
    }
    respond({ ok: true }); return false;
  });
  document.addEventListener('visibilitychange', tick);
  document.addEventListener('yt-navigate-start', () => { if (state) stop('影片導航已開始，停止收音。', true); });
  window.addEventListener('pagehide', () => { if (state) stop('分頁已離開，停止收音。', true); });
  setInterval(tick, 500);
})();
