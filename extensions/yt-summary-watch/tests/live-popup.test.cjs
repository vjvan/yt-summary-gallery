/* eslint-disable @typescript-eslint/no-require-imports -- Popup consent and control mocks only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const nodes = {}, messages = [], timers = [];
  const url = 'https://discord.com/channels/123456789012345678/234567890123456789';
  for (const id of ['liveSource', 'liveStatus', 'liveStart', 'liveStop', 'liveOpen', 'liveConsent', 'liveRefresh', 'live-title', 'server', 'token']) nodes[id] = { events: {}, textContent: '', checked: false, addEventListener(type, fn) { this.events[type] = fn; } };
  const context = vm.createContext({ byId: id => nodes[id], setInterval(fn) { timers.push(fn); }, async send(message) {
    messages.push(message);
    return { ready: true, active: message.type === 'POPUP_LIVE_START', source: { url, tabId: 7, title: '來源' }, message: message.type === 'POPUP_LIVE_STOP' ? '已停止' : '收音狀態', providerMessage: '本機已就緒' };
  } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../live-popup.js'), 'utf8'), context);
  return { nodes, messages, async click(id) { await nodes[id].events.click(); await settle(); } };
}
test('Discord popup never auto-starts and consent is consumed on every manual start', async () => {
  const h = harness(); await settle();
  assert.deepEqual(h.messages.map(message => message.type), ['POPUP_LIVE_PREPARE']); assert.equal(h.nodes.liveConsent.checked, false);
  assert.match(h.nodes.liveSource.textContent, /discord.com\/channels/);
  await h.click('liveStart'); assert.equal(h.messages.some(message => message.type === 'POPUP_LIVE_START'), false);
  h.nodes.liveConsent.checked = true; await h.click('liveStart');
  assert.equal(h.messages.at(-1).type, 'POPUP_LIVE_START'); assert.equal(h.messages.at(-1).confirmAudio, true); assert.equal(h.nodes.liveConsent.checked, false);
  assert.equal(h.messages.at(-1).sourceTabId, 7);
  await h.click('liveStop'); assert.equal(h.messages.at(-1).type, 'POPUP_LIVE_STOP'); assert.match(h.nodes.liveStatus.textContent, /已停止/);
  await h.click('liveOpen'); assert.equal(h.messages.at(-1).type, 'POPUP_LIVE_OPEN');
});
