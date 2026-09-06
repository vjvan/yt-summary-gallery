/* global chrome, LiveCore, AudioContext, AudioWorkletNode */
globalThis.LiveOffscreenAudio = (() => {
  'use strict';
  let active = null;
  async function stop(runId) {
    if (!active || (runId && active.runId !== runId)) return { partialSeconds: 0 };
    const record = active; active = null; clearInterval(record.heartbeat);
    record.worklet?.port.postMessage('stop'); record.worklet?.disconnect(); record.source?.disconnect();
    record.stream?.getTracks().forEach(track => track.stop());
    await record.context?.close().catch(() => {});
    return { partialSeconds: record.partialSeconds || 0 };
  }
  async function error(record, message) {
    if (active !== record) return;
    const result = await stop(record.runId);
    await chrome.runtime.sendMessage({ type: 'LIVE_CAPTURE_ERROR', runId: record.runId, error: message, ...result }).catch(() => {});
  }
  async function start(message) {
    if (!LiveCore.validId(message.runId) || typeof message.streamId !== 'string') throw new Error('直播收音來源無效。');
    await stop(); await globalThis.WatchOffscreenAudio?.stop();
    const record = { runId: message.runId, partialSeconds: 0, lastAck: Date.now(), posting: false }; active = record;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } }, video: false });
      if (active !== record) { stream.getTracks().forEach(track => track.stop()); return; }
      record.stream = stream;
      if (stream.getVideoTracks().length || !stream.getAudioTracks().length) throw new Error('必須是分頁音訊，不可含影片或麥克風。');
      record.context = new AudioContext(); record.source = record.context.createMediaStreamSource(stream);
      record.source.connect(record.context.destination); // Keep original Discord tab audible.
      await record.context.audioWorklet.addModule(chrome.runtime.getURL('live-worklet.js'));
      if (active !== record) return;
      record.worklet = new AudioWorkletNode(record.context, 'live-pcm-segmenter', { numberOfInputs: 1, numberOfOutputs: 0 });
      record.source.connect(record.worklet);
      record.worklet.port.onmessage = event => {
        if (active !== record) return;
        const data = event.data;
        if (data.type === 'clock') { record.partialSeconds = data.partialSeconds; return; }
        if (data.type !== 'segment') return;
        try {
          const bytes = LiveCore.wav(data.samples, data.sampleRate); let binary = '';
          for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
          void chrome.runtime.sendMessage({ type: 'LIVE_CAPTURED', runId: record.runId, sequence: data.sequence, start: LiveCore.roundTime(data.startSample / data.sampleRate), end: LiveCore.roundTime(data.endSample / data.sampleRate), gapReason: data.gapReason, base64: btoa(binary) }).then(result => {
            if (active === record && !result?.ok) void error(record, result?.error || '音訊排程失敗；已停止，未處理片段不會偷偷略過。');
          }).catch(() => { void error(record, '直播控制程式中斷，未處理音訊已停止。'); });
        } catch (cause) { void error(record, cause.message); }
      };
      record.worklet.onprocessorerror = () => { void error(record, 'PCM 音訊處理器中斷。'); };
      stream.getTracks().forEach(track => track.addEventListener('ended', () => { void error(record, 'Chrome 已結束或撤銷分頁音訊擷取。'); }));
      let timer;
      try { await Promise.race([record.context.resume(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('分頁聲音無法恢復，請再次手動開始。')), 2000); })]); }
      finally { clearTimeout(timer); }
      if (active !== record) return;
      record.heartbeat = setInterval(() => {
        if (Date.now() - record.lastAck > 6000) { void error(record, '直播控制訊號中斷超過 6 秒，已停止音軌。'); return; }
        record.worklet.port.postMessage('clock');
        if (record.posting) return;
        record.posting = true;
        void chrome.runtime.sendMessage({ type: 'LIVE_HEARTBEAT', runId: record.runId, partialSeconds: record.partialSeconds }).then(result => {
          if (active !== record) return;
          if (!result?.ok || !result.data?.active) { void stop(record.runId); return; }
          record.lastAck = Date.now();
        }).catch(() => { void error(record, '無法聯絡直播控制程式，已停止音軌。'); }).finally(() => { record.posting = false; });
      }, 1000);
    } catch (cause) { await stop(record.runId); throw new Error(`${cause.message} 若授權已過期，請重新開啟擴充功能並手動開始。`); }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.tab || (sender.url && sender.url !== chrome.runtime.getURL('background.js')) || message?.target !== 'offscreen' || !message.type?.startsWith('LIVE_OFFSCREEN_')) return false;
    (message.type === 'LIVE_OFFSCREEN_START' ? start(message) : message.type === 'LIVE_OFFSCREEN_STOP' ? stop(message.runId) : Promise.reject(new Error('未知的直播音訊操作。')))
      .then(data => respond({ ok: true, ...data }), cause => respond({ ok: false, error: cause.message }));
    return true;
  });
  return { stop };
})();
