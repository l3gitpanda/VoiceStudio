/**
 * Live Voice playback: a jitter buffer between the network and the output
 * device.
 *
 * Converted blocks arrive in bursts (one per model step) while the output
 * device pulls 128 frames at a steady clock. The buffer keeps a small target
 * fill so bursts never run dry, and it controls drift: the microphone and the
 * output device (a virtual cable especially) run on different clocks, so the
 * fill slowly creeps. When it grows past `maxMs` the oldest audio is dropped
 * back to the target — latency never grows unbounded. An underrun plays
 * silence and is counted. Stats are posted every ~0.5 s.
 *
 * Messages in: Float32Array (samples), or {type: 'reset'}.
 * Messages out: {type: 'stats', fillMs, underruns, droppedMs}.
 */
class LiveVoiceJitterBuffer {
  constructor(sampleRate, { targetMs = 60, maxMs = 240, capacityMs = 2000 } = {}) {
    this.sampleRate = sampleRate;
    this.target = Math.round((targetMs / 1000) * sampleRate);
    this.max = Math.max(this.target + 1, Math.round((maxMs / 1000) * sampleRate));
    this.capacity = Math.max(this.max * 2, Math.round((capacityMs / 1000) * sampleRate));
    this.ring = new Float32Array(this.capacity);
    this.read = 0;
    this.size = 0;
    this.primed = false;
    this.underruns = 0;
    this.dropped = 0;
  }

  reset() {
    this.read = 0;
    this.size = 0;
    this.primed = false;
  }

  push(samples) {
    for (let i = 0; i < samples.length; i += 1) {
      if (this.size === this.capacity) {
        this.read = (this.read + 1) % this.capacity;
        this.size -= 1;
        this.dropped += 1;
      }
      this.ring[(this.read + this.size) % this.capacity] = samples[i];
      this.size += 1;
    }
    if (this.size > this.max) {
      const excess = this.size - this.target;
      this.read = (this.read + excess) % this.capacity;
      this.size -= excess;
      this.dropped += excess;
    }
    if (!this.primed && this.size >= this.target) this.primed = true;
  }

  pull(out) {
    if (!this.primed) {
      out.fill(0);
      return;
    }
    const n = Math.min(out.length, this.size);
    for (let i = 0; i < n; i += 1) {
      out[i] = this.ring[(this.read + i) % this.capacity];
    }
    this.read = (this.read + n) % this.capacity;
    this.size -= n;
    if (n < out.length) {
      out.fill(0, n);
      this.underruns += 1;
      this.primed = false; // refill to the target before playing again
    }
  }

  stats() {
    return {
      type: 'stats',
      fillMs: (1000 * this.size) / this.sampleRate,
      underruns: this.underruns,
      droppedMs: (1000 * this.dropped) / this.sampleRate,
    };
  }
}

if (typeof registerProcessor === 'function') {
  class LiveVoicePlayback extends AudioWorkletProcessor {
    constructor(options) {
      super();
      // `sampleRate` is the AudioWorkletGlobalScope's context rate.
      this.buffer = new LiveVoiceJitterBuffer(sampleRate, options?.processorOptions || {});
      this.sinceStats = 0;
      this.port.onmessage = (event) => {
        if (event.data instanceof Float32Array) this.buffer.push(event.data);
        else if (event.data && event.data.type === 'reset') this.buffer.reset();
      };
    }

    process(_inputs, outputs) {
      const output = outputs[0];
      if (!output || !output[0]) return true;
      this.buffer.pull(output[0]);
      for (let ch = 1; ch < output.length; ch += 1) output[ch].set(output[0]);
      this.sinceStats += output[0].length;
      if (this.sinceStats >= sampleRate / 2) {
        this.sinceStats = 0;
        this.port.postMessage(this.buffer.stats());
      }
      return true;
    }
  }
  registerProcessor('live-voice-playback', LiveVoicePlayback);
}

if (typeof globalThis !== 'undefined') globalThis.LiveVoiceJitterBuffer = LiveVoiceJitterBuffer;
