/* Pure bounded PCM segmentation helpers; shared by the AudioWorklet and tests. */
(function (scope) {
  'use strict';
  const MAX_QUEUE_SECONDS = 30;
  function discordUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port || url.username || url.password || url.search || url.hash) return null;
      const match = /^\/channels\/(@me|[1-9][0-9]{16,19})\/([1-9][0-9]{16,19})\/?$/.exec(url.pathname);
      return match ? `https://discord.com/channels/${match[1]}/${match[2]}` : null;
    } catch { return null; }
  }
  const roundTime = value => Math.round(value * 1e6) / 1e6;
  const validId = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
  function ready(status) { return status?.processingMode === 'local' && status.audioConfigured === true && (status.translationReady ?? status.translationConfigured) === true; }
  function wav(samples, rate) {
    if (!(samples instanceof Float32Array) || !Number.isInteger(rate) || rate < 8000 || rate > 96000 || !samples.length || samples.length > rate * 8) throw new Error('PCM 格式不正確。');
    const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
    const str = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
    str(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); str(8, 'WAVE'); str(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) { const value = Math.max(-1, Math.min(1, samples[i] || 0)); view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }
    return bytes;
  }
  class Segmenter {
    constructor(rate, emit) {
      this.rate = rate; this.emit = emit; this.position = 0; this.sequence = 0; this.previousEnd = 0;
      this.pre = new Float32Array(Math.round(rate * 0.3)); this.preCount = 0; this.preIndex = 0;
      this.parts = []; this.length = 0; this.start = 0; this.silence = 0;
    }
    get partialSeconds() { return this.length / this.rate; }
    push(input) {
      let offset = 0;
      while (offset < input.length) {
        const available = this.length ? this.rate * 8 - this.length : input.length - offset;
        const block = input.subarray(offset, offset + Math.min(available, input.length - offset));
        let energy = 0; for (const value of block) energy += value * value;
        const speech = Math.sqrt(energy / Math.max(1, block.length)) >= 0.012;
        if (!this.length && speech) {
          const pre = new Float32Array(this.preCount);
          for (let i = 0; i < pre.length; i++) pre[i] = this.pre[(this.preIndex - this.preCount + i + this.pre.length) % this.pre.length];
          this.start = this.position - pre.length; this.parts = pre.length ? [pre] : []; this.length = pre.length; this.preCount = 0;
        }
        if (this.length || speech) {
          // Account for pre-roll when the first speech block approaches the hard bound.
          const take = Math.min(block.length, this.rate * 8 - this.length);
          this.parts.push(block.slice(0, take)); this.length += take;
          this.silence = speech ? 0 : this.silence + take;
          offset += take; this.position += take;
          if (this.length >= this.rate * 8 || (this.length >= this.rate * 3 && this.silence >= this.rate * 0.6) || (this.length >= this.rate * 6 && this.silence >= this.rate * 0.2)) this.flush();
        } else {
          for (const value of block) { this.pre[this.preIndex] = value; this.preIndex = (this.preIndex + 1) % this.pre.length; this.preCount = Math.min(this.pre.length, this.preCount + 1); }
          offset += block.length; this.position += block.length;
        }
      }
    }
    flush() {
      if (!this.length) return;
      const samples = new Float32Array(this.length); let at = 0;
      for (const part of this.parts) { samples.set(part, at); at += part.length; }
      this.emit({ sequence: this.sequence++, startSample: this.start, endSample: this.position, gapReason: this.start > this.previousEnd ? 'silence' : undefined, samples });
      this.previousEnd = this.position; this.parts = []; this.length = 0; this.silence = 0; this.preCount = 0;
    }
  }
  const api = { MAX_QUEUE_SECONDS, discordUrl, roundTime, validId, ready, wav, Segmenter };
  scope.LiveCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
