/* global chrome, AudioWatchCore */
(() => {
  'use strict';
  let active = null;
  async function stop(runId) {
    if (!active || (runId && active.runId !== runId)) return;
    const previous = active; active = null;
    clearTimeout(previous.timer); clearInterval(previous.watchdog);
    if (previous.recorder?.state !== 'inactive') { try { previous.recorder?.stop(); } catch { /* already stopped */ } }
    previous.stream?.getTracks().forEach(track => track.stop());
    previous.source?.disconnect();
    await previous.output?.close().catch(() => {});
  }
  async function notify(message) { return chrome.runtime.sendMessage(message); }
  async function start(message) {
    if (!AudioWatchCore.validRun(message.runId) || typeof message.streamId !== 'string') throw new Error('無效的收音請求。');
    await stop(); await globalThis.LiveOffscreenAudio?.stop();
    const record = { runId: message.runId, stream: null, output: null, source: null, recorder: null, lastHeartbeat: Date.now(), busy: false };
    active = record;
    try {
      // Only the explicitly selected tab. NEVER request microphone or video.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } }, video: false });
      if (active !== record) { stream.getTracks().forEach(track => track.stop()); return; }
      record.stream = stream;
      if (stream.getVideoTracks().length || !stream.getAudioTracks().length) throw new Error('分頁音訊來源不正確。');
      record.output = new AudioContext();
      record.source = record.output.createMediaStreamSource(stream);
      record.source.connect(record.output.destination); // Preserve the user's tab audio.
      let resumeTimer;
      try { await Promise.race([record.output.resume(), new Promise((_, reject) => { resumeTimer = setTimeout(() => reject(new Error('無法恢復分頁聲音，已停止收音。')), 2000); })]); }
      finally { clearTimeout(resumeTimer); }
      stream.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (active === record) { void stop(record.runId); void notify({ type: 'AUDIO_CAPTURE_ERROR', runId: record.runId, error: 'Chrome 已結束分頁收音。' }); }
      }));
      record.watchdog = setInterval(() => {
        if (Date.now() - record.lastHeartbeat > 2500) {
          void stop(record.runId);
          void notify({ type: 'AUDIO_CAPTURE_ERROR', runId: record.runId, error: '影片控制訊號中斷，已停止收音。' });
        }
      }, 500);
    } catch (error) { await stop(record.runId); throw error; }
  }
  async function recordChunk(message) {
    const state = active;
    if (!state || state.runId !== message.runId || state.busy || !state.stream || !Number.isFinite(message.start)) throw new Error('收音器尚未就緒。');
    state.busy = true;
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('Chrome 未支援所需的完整 WebM 音訊片段。');
    const chunks = [];
    const recorder = new MediaRecorder(state.stream, { mimeType, audioBitsPerSecond: 64000 });
    state.recorder = recorder;
    const chunkId = crypto.randomUUID();
    const startedAt = performance.now();
    let complete = false;
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { void stop(state.runId); void notify({ type: 'AUDIO_CAPTURE_ERROR', runId: state.runId, error: '音訊片段建立失敗。' }); };
    recorder.onstop = async () => {
      if (active !== state || !complete) return; // Discard every partial/interrupted clip.
      try {
        const blob = new Blob(chunks, { type: mimeType });
        if (!blob.size || blob.size > AudioWatchCore.MAX_BYTES) throw new Error('音訊片段超過 2 MB 上限或沒有內容。');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
        if (active !== state) return;
        // One complete MediaRecorder file; no naked timeslice fragments and no queue.
        await notify({ type: 'AUDIO_CAPTURED', runId: state.runId, chunkId, start: message.start, duration: (performance.now() - startedAt) / 1000, mimeType, base64: btoa(binary) });
      } catch (error) { await stop(state.runId); void notify({ type: 'AUDIO_CAPTURE_ERROR', runId: state.runId, error: error.message }); }
    };
    recorder.start(); // No timeslice: each new recorder produces its own header/trailer.
    state.timer = setTimeout(() => {
      if (active !== state || recorder.state !== 'recording') return;
      complete = true; recorder.stop();
    }, AudioWatchCore.CHUNK_SECONDS * 1000);
  }
  globalThis.WatchOffscreenAudio = { stop };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    const trusted = sender.id === chrome.runtime.id && !sender.tab && (!sender.url || sender.url === chrome.runtime.getURL('background.js'));
    if (!trusted || message?.target !== 'offscreen' || !message.type?.startsWith('OFFSCREEN_')) return false;
    (async () => {
      if (message.type === 'OFFSCREEN_START') await start(message);
      else if (message.type === 'OFFSCREEN_STOP') await stop(message.runId);
      else if (message.type === 'OFFSCREEN_RECORD') await recordChunk(message);
      else if (message.type === 'OFFSCREEN_RELEASE' && active?.runId === message.runId && active.recorder?.state === 'inactive') active.busy = false;
      else if (message.type === 'OFFSCREEN_HEARTBEAT' && active?.runId === message.runId) active.lastHeartbeat = Date.now();
      else throw new Error('未知的分頁音訊操作。');
      return { ok: true };
    })().then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  });
})();
