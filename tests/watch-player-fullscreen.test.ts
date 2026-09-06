import test from 'node:test';
import assert from 'node:assert/strict';
import { enterCaptionFullscreen } from '../lib/watch/player-fullscreen';
test('fullscreen targets the caption wrapper with receiver intact', async () => {
  let calls = 0;
  const wrapper = { async requestFullscreen() { assert.equal(this, wrapper); calls++; } };
  assert.equal(await enterCaptionFullscreen(wrapper, true), true);
  assert.equal(calls, 1);
});
test('unsupported or rejected fullscreen requests retain an explicit page-mode fallback', async () => {
  let calls = 0;
  const wrapper = { async requestFullscreen() { calls++; throw Error('blocked by embedding policy'); } };
  assert.equal(await enterCaptionFullscreen(wrapper, false), false);
  assert.equal(calls, 0);
  assert.equal(await enterCaptionFullscreen({}, true), false);
  assert.equal(await enterCaptionFullscreen(wrapper, true), false);
  assert.equal(calls, 1);
});
