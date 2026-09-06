import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { followTranscriptCue, nextTranscriptFollowState, transcriptFollowTop } from '../lib/watch/transcript-follow';

test('manual browsing pauses following until explicit resume, new video or cue click', () => {
  let following = true;
  following = nextTranscriptFollowState(following, 'manual-scroll');
  assert.equal(following, false);
  assert.equal(nextTranscriptFollowState(following, 'playback-update'), false);
  for (const action of ['resume', 'cue-seek', 'new-video'] as const) assert.equal(nextTranscriptFollowState(following, action), true);
});

test('visible current cue stays still instead of repeatedly scrolling while time advances', () => {
  assert.equal(transcriptFollowTop({ scrollTop: 200, clientHeight: 400, scrollHeight: 1400, cueTop: 260, cueHeight: 120 }), null);
  assert.equal(transcriptFollowTop({ scrollTop: 0, clientHeight: 400, scrollHeight: 300, cueTop: 160, cueHeight: 120 }), null);
});

test('later cue follows down and backward seek follows up with bounded panel positions', () => {
  const down = transcriptFollowTop({ scrollTop: 0, clientHeight: 400, scrollHeight: 1400, cueTop: 800, cueHeight: 120 });
  assert.equal(down, 702);
  assert.equal(transcriptFollowTop({ scrollTop: 800, clientHeight: 400, scrollHeight: 1400, cueTop: 0, cueHeight: 100 }), 0);
  assert.equal(transcriptFollowTop({ scrollTop: 0, clientHeight: 400, scrollHeight: 1400, cueTop: 1350, cueHeight: 50 }), 1000);
});

test('large rows align their observed top; invalid geometry never scrolls', () => {
  assert.equal(transcriptFollowTop({ scrollTop: 0, clientHeight: 300, scrollHeight: 1600, cueTop: 700, cueHeight: 600 }), 676);
  assert.equal(transcriptFollowTop({ scrollTop: 0, clientHeight: 0, scrollHeight: 1000, cueTop: 20, cueHeight: 10 }), null);
  assert.equal(transcriptFollowTop({ scrollTop: NaN, clientHeight: 300, scrollHeight: 1000, cueTop: 20, cueHeight: 10 }), null);
});

test('DOM adapter moves only the supplied transcript panel, not page/ancestors', () => {
  const scrolls: { top: number; behavior: 'auto' }[] = [];
  const panel = {
    scrollTop: 100, clientHeight: 320, scrollHeight: 1500, clientTop: 2,
    getBoundingClientRect: () => ({ top: 600 }),
    scrollTo(options: { top: number; behavior: 'auto' }) { scrolls.push(options); this.scrollTop = options.top; },
  };
  const row = { getBoundingClientRect: () => ({ top: 1202, height: 100 }) };
  assert.equal(followTranscriptCue(panel, row, false), false);
  assert.equal(scrolls.length, 0);
  assert.equal(followTranscriptCue(panel, row, true), true);
  assert.deepEqual(scrolls, [{ top: 623, behavior: 'auto' }]);
});

test('resume can reposition a currently visible cue without altering focus or document scrolling', () => {
  const geometry = { scrollTop: 200, clientHeight: 400, scrollHeight: 1400, cueTop: 400, cueHeight: 100 };
  assert.equal(transcriptFollowTop(geometry), null);
  assert.equal(transcriptFollowTop(geometry, true), 295);
  const client = fs.readFileSync(new URL('../components/WatchClient.tsx', import.meta.url), 'utf8');
  assert.match(client, /恢復自動跟隨/);
  assert.match(client, /onWheelCapture/);
  assert.match(client, /onTouchMove/);
  assert.match(client, /onKeyDownCapture/);
  assert.match(client, /max-h-\[320px\]/);
  assert.doesNotMatch(client, /scrollIntoView\(|window\.scroll(?:To|By)\(/);
});
