/**
 * Live Voice playback: a jitter buffer between the network and the output
 * device.
 *
 * Converted audio arrives one model block at a time (about 180 ms on a GPU,
 * 800 ms with the CPU settings), each block a little early or late, while the
 * output device pulls 128 frames at a steady clock. So the buffer is sized
 * from the block, not fixed:
 *
 *  - On (re)start it plays `jitterMs` of silence first. That is the slack a
 *    late block can use up; without it the first block plays out just as the
 *    next one is due and any delay is an audible gap.
 *  - Only a backlog past two blocks plus slack is trimmed (a stall that
 *    released a burst, or clock drift between the microphone and the output,
 *    a virtual cable especially), back to one block plus slack. A fixed
 *    ceiling below one block would throw most of every block away.
 *  - An underrun plays silence, is counted, and re-arms the lead-in.
 *
 * Stats are posted every ~0.5 s.
 *
 * Messages in: Float32Array (samples), or {type: 'reset'}.
 * Messages out: {type: 'stats', fillMs, underruns, droppedMs}.
 */
class LiveVoiceJitterBuffer {
  constructor(sampleRate, { chunkMs = 20, jitterMs = 60, capacityMs = 4000 } = {}) {
    const samples = (ms) => Math.max(1, Math.round((ms / 1000) * sampleRate));
    this.sampleRate = sampleRate;
    this.lead = samples(jitterMs);
    this.trimTo = samples(chunkMs) + this.lead;
    this.max = 2 * this.trimTo;
    this.capacity = Math.max(2 * this.max, samples(capacityMs));
    this.ring = new Float32Array(this.capacity);
    this.read = 0;
    this.size = 0;
    this.primed = false;
    this.leadLeft = 0;
    this.underruns = 0;
    this.dropped = 0;
  }

  reset() {
    this.read = 0;
    this.size = 0;
    this.primed = false;
    this.leadLeft = 0;
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
      const excess = this.size - this.trimTo;
      this.read = (this.read + excess) % this.capacity;
      this.size -= excess;
      this.dropped += excess;
    }
    if (!this.primed && this.size > 0) {
      this.primed = true;
      this.leadLeft = this.lead;
    }
  }

  pull(out) {
    if (!this.primed) {
      out.fill(0);
      return;
    }
    let i = Math.min(out.length, this.leadLeft);
    out.fill(0, 0, i);
    this.leadLeft -= i;
    const n = Math.min(out.length - i, this.size);
    for (let k = 0; k < n; k += 1) {
      out[i + k] = this.ring[(this.read + k) % this.capacity];
    }
    this.read = (this.read + n) % this.capacity;
    this.size -= n;
    i += n;
    if (i < out.length) {
      out.fill(0, i);
      this.underruns += 1;
      this.primed = false; // the next audio starts with the lead-in again
    }
  }

  stats() {
    return {
      type: 'stats',
      fillMs: (1000 * (this.size + this.leadLeft)) / this.sampleRate,
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
