/* eslint-disable @typescript-eslint/no-require-imports -- DOM mocks for bounded audio replay memory. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const folder = path.join(__dirname, '..');
const settle = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  let listener;
  const nodes = [], messages = [];
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.events = {}; this.children = []; this.textContent = ''; this.classList = { contains: () => false }; nodes.push(this); }
    append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; }
    attachShadow() { this.root = new Element('shadow'); return this.root; }
    setAttribute() {} addEventListener(name, fn) { this.events[name] = fn; } removeEventListener(name) { delete this.events[name]; }
    querySelector() { return video; }
  }
  const player = new Element('player'), video = new Element('video');
  Object.assign(video, { currentTime: 0, paused: false, ended: false, seeking: false, playbackRate: 1, async play() {} });
  const document = { visibilityState: 'visible', getElementById: () => player, createElement: tag => new Element(tag), addEventListener() {} };
  const context = vm.createContext({ console, document, URL, Date, setInterval() {}, window: { addEventListener() {} }, location: { href: 'https://www.youtube.com/watch?v=kfbWz9_bJoA' }, chrome: { runtime: { id: 'ext', onMessage: { addListener(fn) { listener = fn; } }, async sendMessage(message) { messages.push(message); return { ok: true, data: { active: true } }; } } } });
  for (const file of ['core.js', 'audio-core.js', 'audio-content.js']) vm.runInContext(fs.readFileSync(path.join(folder, file), 'utf8'), context);
  const runId = 'aabbccdd-1122-3344-5566-aabbccddeeff';
  const send = message => listener({ runId, videoId: 'kfbWz9_bJoA', ...message }, { id: 'ext' }, () => {});
  const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
  const attached = () => player.children.flatMap(child => child.root ? descendants(child.root) : []);
  return { send, video, messages, attached, start() { send({ type: 'AUDIO_STARTED' }); }, add(index, count = 1) {
    const start = index * 12, end = start + 12;
    const cues = Array.from({ length: count }, (_, part) => ({ id: `a${index}-${part}`, start, end, text: `翻譯 ${index}-${part}` }));
    send({ type: 'AUDIO_RESULT', start, end, result: { cues, originalCues: cues.map(cue => ({ ...cue, text: 'Source' })) } });
  } };
}
test('unlimited audio UI prunes old DOM and cues at 100 clips without stopping capture', async () => {
  const h = harness(); h.start(); await settle();
  for (let i = 0; i < 150; i++) h.add(i);
  const entries = h.attached().filter(node => node.className === 'entry');
  assert.equal(entries.length, 100); assert.match(entries[0].children[1].textContent, /翻譯 50-0/);
  assert.equal(h.attached().find(node => node.className === 'subtitle').textContent, ''); // Original time 0 was evicted.
  assert.equal(h.messages.some(message => message.type === 'AUDIO_STOP'), false);
  h.video.currentTime = 149 * 12; h.add(150);
  assert.equal(h.attached().find(node => node.className === 'subtitle').textContent, '翻譯 149-0');
  assert.match(h.attached().find(node => node.className === 'help').textContent, /100 個片段／500 句/);
});
test('audio replay also obeys 500-cue cap and ignores stale run results', async () => {
  const h = harness(); h.start(); await settle();
  for (let i = 0; i < 120; i++) h.add(i, 6);
  const entries = h.attached().filter(node => node.className === 'entry');
  assert.equal(entries.length, 83); assert.equal(entries.reduce((sum, entry) => sum + entry.children[1].textContent.split('\n').length, 0), 498);
  h.send({ type: 'AUDIO_RESULT', runId: 'old-run', start: 0, end: 1, result: { cues: [{ id: 'stale', start: 0, end: 1, text: 'stale' }] } });
  assert.equal(h.attached().filter(node => node.className === 'entry').length, 83);
  assert.equal(h.messages.some(message => message.type === 'AUDIO_STOP'), false);
});
