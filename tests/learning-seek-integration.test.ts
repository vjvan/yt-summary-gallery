import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('evidence navigation mounts a player that consumes its timestamp, not TranscriptView without that prop',()=>{
 const source=fs.readFileSync('app/card/[id]/page.tsx','utf8');
 const callback=source.slice(source.indexOf('onSeek={(seconds) => {'),source.indexOf('{/* === CAROUSEL VIEW === */}'));
 assert.match(callback,/setInitialSeekSec\(seconds\)/); assert.match(callback,/setView\("carousel"\)/); assert.doesNotMatch(callback,/playerSeekRef\.current/);
 const overlay=fs.readFileSync('components/YouTubePlayerWithOverlay.tsx','utf8');
 assert.match(overlay,/Number\.isFinite\(initialSeekSec\)/);assert.match(overlay,/Math\.floor\(initialSeekSec\)/);assert.ok(overlay.includes('&start=${start}'));
});
