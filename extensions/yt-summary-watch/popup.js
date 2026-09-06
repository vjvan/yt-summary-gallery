/* global chrome, WatchCore */
'use strict';
const byId = id => document.getElementById(id);
let serverStatus = null;
function status(text, error = false) { byId('status').textContent = text; byId('status').classList.toggle('error', error); }
function audioStatus(text, error = false) { byId('audioStatus').textContent = text; byId('audioStatus').classList.toggle('error', error); status(text, error); }
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '擴充功能尚未就緒，請重新載入。');
  return response.data;
}
function translationReady(value) { return !!(value?.translationReady ?? value?.translationConfigured); }
function applyServerStatus(value) {
  serverStatus = value;
  const local = WatchCore.isLocalProcessing(value);
  const unlimited = WatchCore.isUnlimitedLocal(value);
  byId('localFullPrefetchLabel').hidden = !local;
  byId('localFullPrefetch').disabled = !local;
  byId('maxBatchesLabel').hidden = local;
  byId('cloudLimitHelp').hidden = local;
  byId('maxBatches').disabled = local;
  byId('maxChunksLabel').hidden = unlimited;
  byId('maxChunks').disabled = unlimited;
  byId('processingStatus').textContent = !value ? '尚未確認後端模式；不會自行改用雲端。請測試連線。'
    : local ? `全本機、不按批次收費、${unlimited ? '持續翻譯至停止（不限總批數）' : '依本機工作設定處理'}。模型：${value.translationModel || '本機模型'}。字幕與收音不送外部翻譯 API；模型未就緒時不回退雲端。`
      : `雲端模型：${value.translationModel || '已設定的供應商'}。字幕與另行同意的音訊會送供應商，可能產生 API 費用；保留批次上限。`;
  if (value?.translationStatusMessage) byId('processingStatus').textContent += ` ${value.translationStatusMessage}`;
  byId('consentText').textContent = local
    ? '我同意在這台電腦上處理原文字幕、前後文與術語。全本機不按批次收費，整片預譯開啟時載入後立即處理，暫停及切分頁仍會持續耗用本機算力；仍每批 8 段並一次只處理一批，可用原文模式或全部停用停止。'
    : '我同意將這支影片的原文字幕、標題與術語傳送至設定的雲端模型供應商，並接受上述批次上限及可能的 API 費用。';
  byId('audioConsentText').textContent = local
    ? '我同意本次擷取原分頁音訊，在這台電腦上進行語音辨識與繁中翻譯。不傳外部 API、不按片段收費，可持續至停止。此同意只限這一次，不沿用字幕自動模式或之前的收音同意。'
    : '我同意本次將原分頁音訊送交 OpenAI 進行語音辨識與繁中翻譯，可能產生兩階段 API 費用，以上述片段上限為限。此同意只限這一次，不沿用字幕自動模式或之前的收音同意。';
  byId('autoModeText').textContent = `自動模式（選用）：在功能啟用期間，已開啟及之後開啟／切換的 YouTube 影片，${local ? '依整片預譯設定在載入後或播放時開始' : '在播放時自動開始'}，沿用以上${local ? '本機處理同意；直到你停止' : '雲端同意與上限'}。不會自動開始收音。`;
  byId('enable').disabled = !translationReady(value);
  byId('audioStart').disabled = !value?.audioConfigured || !translationReady(value);
}
async function load() {
  try {
    const settings = await send({ type: 'POPUP_SETTINGS' });
    for (const key of ['server', 'token', 'maxBatches', 'mode']) byId(key).value = settings[key];
    byId('localFullPrefetch').checked = settings.localFullPrefetch !== false;
    for (const key of ['consent', 'autoMode']) byId(key).checked = settings[key];
    status(settings.enabled ? (settings.autoMode ? '已啟用自動字幕模式。' : '已啟用手動選擇的影片。') : '目前未啟用字幕或收音。');
    if (settings.token) applyServerStatus(await send({ type: 'POPUP_STATUS' }));
    else applyServerStatus(null);
  } catch (error) { applyServerStatus(null); status(error.message, true); }
}
for (const key of ['server', 'token']) byId(key).addEventListener('input', () => { applyServerStatus(null); byId('audioConsent').checked = false; });
byId('settings').addEventListener('submit', async event => {
  event.preventDefault();
  byId('enable').disabled = true;
  try {
    if (!serverStatus) throw new Error('請先測試連線，確認後端是全本機或雲端模式。');
    const settings = WatchCore.boundedSettings({ server: byId('server').value, token: byId('token').value,
      maxBatches: byId('maxBatches').value, mode: byId('mode').value, consent: byId('consent').checked,
      autoMode: byId('autoMode').checked, localFullPrefetch: byId('localFullPrefetch').checked, enabled: true });
    if (!settings.consent) throw new Error('請先勾選目前模式的字幕處理同意。');
    if (settings.token.length < 16 || /^sk-/.test(settings.token)) throw new Error('請使用本機 /watch 的配對權杖，不是模型 API key。');
    const result = await send({ type: 'POPUP_ENABLE', settings, expectedProcessingMode: WatchCore.isLocalProcessing(serverStatus) ? 'local' : 'cloud' });
    status(WatchCore.isLocalProcessing(serverStatus) && settings.localFullPrefetch ? '已啟用本機整片預譯：載入英文字幕後立即處理，暫停／切分頁仍繼續耗用算力。切至原文模式或全部停用可停止。' : result.message);
  } catch (error) { status(error.message, true); }
  finally { byId('enable').disabled = !translationReady(serverStatus); }
});
byId('disable').addEventListener('click', async () => {
  try { await send({ type: 'POPUP_DISABLE' }); status(WatchCore.isLocalProcessing(serverStatus) ? '已全部停用本機字幕與收音。' : '已全部停用。已送出的雲端請求仍可能計費。'); }
  catch (error) { status(error.message, true); }
});
byId('pair').addEventListener('click', async () => {
  byId('pair').disabled = true;
  try {
    const result = await send({ type: 'POPUP_PAIR', server: byId('server').value, token: byId('token').value });
    applyServerStatus(result);
    status(`已配對 ${byId('server').value}。翻譯：${translationReady(result) ? '已就緒' : '尚未就緒'}；收音辨識：${result.audioConfigured ? '已設定' : '未設定'}。尚未啟用字幕或收音。`);
  } catch (error) { applyServerStatus(null); status(error.message, true); }
  finally { byId('pair').disabled = false; }
});
byId('audioStart').addEventListener('click', async () => {
  const consent = byId('audioConsent').checked;
  byId('audioConsent').checked = false;
  byId('audioStart').disabled = true;
  audioStatus('正在檢查配對、目前處理模式、影片與收音權限…');
  try {
    if (!serverStatus) throw new Error('請先測試連線，確認後端處理模式。');
    if (!consent) throw new Error('每次收音前請重新勾選目前模式的分頁音訊處理同意。');
    const unlimited = WatchCore.isUnlimitedLocal(serverStatus);
    const maxChunks = unlimited ? 0 : Number(byId('maxChunks').value);
    if (!unlimited && (!Number.isInteger(maxChunks) || maxChunks < 2 || maxChunks > 20)) throw new Error('雲端收音請設定 2–20 段上限。');
    const result = await send({ type: 'POPUP_AUDIO_START', confirmAudio: true, maxChunks, expectedProcessingMode: WatchCore.isLocalProcessing(serverStatus) ? 'local' : 'cloud' });
    audioStatus(result.message || '收音工作未啟動。');
  } catch (error) { audioStatus(error.message, true); }
  finally { byId('audioStart').disabled = !serverStatus?.audioConfigured || !translationReady(serverStatus); }
});
byId('audioStop').addEventListener('click', async () => {
  byId('audioConsent').checked = false;
  try { await send({ type: 'POPUP_AUDIO_STOP' }); audioStatus(WatchCore.isLocalProcessing(serverStatus) ? '已停止本機收音，未完成片段已丟棄。' : '已停止收音，未完成片段已丟棄；已送出的雲端辨識仍可能計費。'); }
  catch (error) { audioStatus(error.message, true); }
});
void load();
