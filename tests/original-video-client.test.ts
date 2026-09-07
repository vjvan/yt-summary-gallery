import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalVideoSelectionError, originalVideoUploadHeaders, ORIGINAL_VIDEO_MAX_BYTES } from '../lib/original-video-client';
test('original MP4 selection rejects empty, non-MP4, invalid and oversized files', () => {
  for (const file of [null, { name: 'film.mov', size: 10 }, { name: 'film.mp4', size: 0 }, { name: 'film.mp4', size: NaN }, { name: 'film.mp4', size: ORIGINAL_VIDEO_MAX_BYTES + 1 }]) assert.ok(originalVideoSelectionError(file));
  assert.equal(originalVideoSelectionError({ name: 'film.MP4', size: 10 }), '');
});
test('both explicit confirmations are required; no implicit rights or timeline consent', () => {
  for (const flags of [[false, false], [true, false], [false, true]]) assert.throws(() => originalVideoUploadHeaders(10, flags[0], flags[1]));
  assert.deepEqual(originalVideoUploadHeaders(10, true, true), { 'Content-Type': 'video/mp4', 'X-File-Size': '10', 'X-Confirm-Rights': 'true', 'X-Confirm-Same-Timeline': 'true' });
  assert.throws(() => originalVideoUploadHeaders(ORIGINAL_VIDEO_MAX_BYTES + 1, true, true));
});
