/* global byId, send */
(() => {
  'use strict';
  let snapshot = null, busy = false;
  function display(value) {
    value = { ...value, providerMessage: value.providerMessage ?? snapshot?.providerMessage };
    snapshot = value;
    byId('liveSource').textContent = `來源：${value.url || value.source?.url || '目前不是支援的 Discord 頻道頁面'}${value.title || value.source?.title ? `\n${value.title || value.source.title}` : ''}`;
    byId('liveStatus').textContent = value.message || value.providerMessage || '尚未收音。';
    if (!value.active && value.providerMessage) byId('liveStatus').textContent += ` ${value.providerMessage}`;
    byId('liveStart').disabled = busy || !value.ready || value.active;
  }
  async function refresh(prepare) {
    if (busy) return;
    try { const value = await send({ type: prepare ? 'POPUP_LIVE_PREPARE' : 'POPUP_LIVE_STATE' }); display(value); if (prepare && (value.source || value.active)) byId('live-title').scrollIntoView?.({ block: 'start' }); }
    catch (cause) { snapshot = null; byId('liveStart').disabled = true; byId('liveStatus').textContent = cause.message; }
  }
  byId('liveRefresh').addEventListener('click', () => { byId('liveConsent').checked = false; void refresh(true); });
  for (const id of ['server', 'token']) byId(id).addEventListener('input', () => { snapshot = null; byId('liveConsent').checked = false; byId('liveStart').disabled = true; });
  byId('liveStart').addEventListener('click', async () => {
    const consent = byId('liveConsent').checked; byId('liveConsent').checked = false;
    if (!consent) { byId('liveStatus').textContent = '每次開始前須重新勾選本次來源收音與背景持續收音同意。'; return; }
    if (!snapshot?.ready || !snapshot.source) { byId('liveStatus').textContent = '請先重新檢查 Discord 來源與全本機就緒。'; return; }
    const source = snapshot.source; busy = true; byId('liveStart').disabled = true;
    byId('liveStatus').textContent = '正在取得本次分頁音訊授權並建立全本機工作…';
    try { display(await send({ type: 'POPUP_LIVE_START', confirmAudio: true, sourceTabId: source.tabId, sourceUrl: source.url })); }
    catch (cause) { byId('liveStatus').textContent = `${cause.message} 請重新檢查後再次手動開始。`; }
    finally { busy = false; byId('liveStart').disabled = true; }
  });
  byId('liveStop').addEventListener('click', async () => {
    byId('liveConsent').checked = false;
    try { display(await send({ type: 'POPUP_LIVE_STOP' })); }
    catch (cause) { byId('liveStatus').textContent = `停止控制失敗：${cause.message} 請關閉來源分頁，Chrome 也會終止收音。`; }
  });
  byId('liveOpen').addEventListener('click', async () => {
    try { await send({ type: 'POPUP_LIVE_OPEN' }); }
    catch (cause) { byId('liveStatus').textContent = cause.message; }
  });
  void refresh(true);
  setInterval(() => { void refresh(false); }, 2000);
})();
