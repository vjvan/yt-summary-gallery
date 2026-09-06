/* eslint-disable @typescript-eslint/no-require-imports -- Standalone mock popup tests, no Chrome or model calls. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const folder = path.join(__dirname, '..');
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness(provider = {}) {
  const elements = {}, messages = [];
  for (const match of fs.readFileSync(path.join(folder, 'popup.html'), 'utf8').matchAll(/id="([^"]+)"/g)) elements[match[1]] = { value: '', checked: false, hidden: false, disabled: false, textContent: '', events: {}, classList: { toggle() {} }, addEventListener(name, handler) { this.events[name] = handler; } };
  elements.maxChunks.value = '2';
  const settings = { server: 'http://localhost:3000', token: 'existing-pairing-token-12345', enabled: false, consent: false, maxBatches: 10, autoMode: false, mode: 'bilingual' };
  const status = { version: 3, processingMode: 'local', unlimited: true, translationModel: 'local-mock', translationConfigured: true, translationReady: true, audioConfigured: true, ...provider };
  const context = vm.createContext({ URL, console, document: { getElementById: id => elements[id] }, chrome: { runtime: { async sendMessage(message) {
    messages.push(message);
    return { ok: true, data: message.type === 'POPUP_SETTINGS' ? settings : ['POPUP_STATUS', 'POPUP_PAIR'].includes(message.type) ? status : { message: '測試已啟動' } };
  } } } });
  vm.runInContext(fs.readFileSync(path.join(folder, 'core.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(folder, 'popup.js'), 'utf8'), context);
  return { elements, messages, status, async click(id) { await elements[id].events.click?.(); }, async submit() { await elements.settings.events.submit({ preventDefault() {} }); } };
}
test('opening popup reuses existing pairing, verifies server mode and hides local fee caps', async () => {
  const h = harness(); await settle();
  assert.deepEqual(h.messages.map(message => message.type), ['POPUP_SETTINGS', 'POPUP_STATUS']);
  assert.equal(h.elements.token.value, 'existing-pairing-token-12345');
  assert.equal(h.elements.maxBatchesLabel.hidden, true); assert.equal(h.elements.maxChunksLabel.hidden, true);
  assert.equal(h.elements.maxBatches.disabled, true); assert.equal(h.elements.maxChunks.disabled, true);
  assert.match(h.elements.processingStatus.textContent, /全本機、不按批次收費、持續翻譯至停止/);
  assert.equal(h.elements.enable.disabled, false);
  h.elements.consent.checked = true; await h.submit();
  assert.equal(h.messages.at(-1).expectedProcessingMode, 'local');
  assert.equal(h.messages.at(-1).settings.maxBatches, 10); // Legacy cloud preference is retained, never local authority.
});
test('local audio uses zero only after confirmed local status and each click consumes fresh consent', async () => {
  const h = harness(); await settle();
  await h.click('audioStart'); assert.equal(h.messages.some(message => message.type === 'POPUP_AUDIO_START'), false);
  h.elements.audioConsent.checked = true; await h.click('audioStart');
  assert.equal(h.messages.at(-1).type, 'POPUP_AUDIO_START'); assert.equal(h.messages.at(-1).maxChunks, 0); assert.equal(h.messages.at(-1).expectedProcessingMode, 'local');
  assert.equal(h.elements.audioConsent.checked, false); assert.equal(h.elements.audioStatus.textContent, '測試已啟動');
  const count = h.messages.length; await h.click('audioStart'); assert.equal(h.messages.length, count);
  assert.match(h.elements.audioStatus.textContent, /重新勾選/);
});
test('cloud retains finite inputs/fee consent; configured but unavailable local model stays disabled', async () => {
  const cloud = harness({ processingMode: 'cloud', unlimited: false }); await settle();
  assert.equal(cloud.elements.maxBatchesLabel.hidden, false); assert.equal(cloud.elements.maxChunksLabel.hidden, false);
  assert.match(cloud.elements.consentText.textContent, /可能的 API 費用/);
  cloud.elements.audioConsent.checked = true; await cloud.click('audioStart'); assert.equal(cloud.messages.at(-1).maxChunks, 2);
  const unavailable = harness({ translationReady: false, translationStatusMessage: '本機模型尚未下載' }); await settle();
  assert.equal(unavailable.elements.enable.disabled, true); assert.equal(unavailable.elements.audioStart.disabled, true);
  assert.match(unavailable.elements.processingStatus.textContent, /本機模型尚未下載/);
  assert.match(unavailable.elements.processingStatus.textContent, /不回退雲端/);
  assert.equal(unavailable.messages.some(message => /START|ENABLE/.test(message.type)), false);
});

test('local full-prefetch defaults on with explicit pause/compute disclosure and can be opted out; cloud hides it', async () => {
  const local = harness(); await settle();
  assert.equal(local.elements.localFullPrefetch.checked, true); assert.equal(local.elements.localFullPrefetchLabel.hidden, false);
  assert.match(local.elements.consentText.textContent, /暫停及切分頁仍會持續耗用本機算力/);
  assert.match(local.elements.autoModeText.textContent, /載入後或播放時開始/);
  await local.submit(); assert.equal(local.messages.some(m => m.type === 'POPUP_ENABLE'), false);
  local.elements.consent.checked = true; await local.submit();
  assert.equal(local.messages.at(-1).settings.localFullPrefetch, true); assert.equal(local.messages.at(-1).expectedProcessingMode, 'local');
  local.elements.localFullPrefetch.checked = false; await local.submit(); assert.equal(local.messages.at(-1).settings.localFullPrefetch, false);
  const cloud = harness({ processingMode: 'cloud', unlimited: false }); await settle();
  assert.equal(cloud.elements.localFullPrefetchLabel.hidden, true); assert.equal(cloud.elements.localFullPrefetch.disabled, true);
  assert.match(cloud.elements.autoModeText.textContent, /在播放時自動開始/); assert.match(cloud.elements.consentText.textContent, /可能的 API 費用/);
});
