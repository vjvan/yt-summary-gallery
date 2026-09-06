/* global AudioWorkletProcessor, registerProcessor, sampleRate */
import './live-core.js';
class LivePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super(); this.active = true;
    this.segmenter = new globalThis.LiveCore.Segmenter(sampleRate, segment => {
      this.port.postMessage({ type: 'segment', ...segment, sampleRate }, [segment.samples.buffer]);
    });
    this.port.onmessage = event => {
      if (event.data === 'stop') this.active = false;
      if (event.data === 'clock') this.port.postMessage({ type: 'clock', samples: this.segmenter.position, partialSeconds: this.segmenter.partialSeconds });
    };
  }
  process(inputs) {
    if (!this.active) return false;
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    const mono = new Float32Array(channels[0].length);
    for (const channel of channels) for (let i = 0; i < mono.length; i++) mono[i] += (channel[i] || 0) / channels.length;
    this.segmenter.push(mono);
    return true;
  }
}
registerProcessor('live-pcm-segmenter', LivePcmProcessor);
