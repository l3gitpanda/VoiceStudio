import { beforeAll, describe, expect, it } from 'vitest';

type Buffer = {
  push(samples: Float32Array): void;
  pull(out: Float32Array): void;
  reset(): void;
  stats(): { fillMs: number; underruns: number; droppedMs: number };
};
type BufferClass = new (sampleRate: number, options?: object) => Buffer;

let JitterBuffer: BufferClass;

beforeAll(async () => {
  // The shipped worklet file itself (registerProcessor is absent here, so only
  // the buffer class is defined and exposed).
  // @ts-expect-error -- the shipped worklet is plain JS without type declarations
  await import('../../../../../../public/vc-playback-worklet.js');
  JitterBuffer = (globalThis as unknown as { LiveVoiceJitterBuffer: BufferClass }).LiveVoiceJitterBuffer;
});

const SR = 1000; // 1 sample per ms keeps the arithmetic readable

describe('live voice jitter buffer', () => {
  const play = (b: Buffer, ms: number) => {
    const out = new Float32Array(ms);
    b.pull(out);
    return out;
  };

  it('opens with the lead-in silence, then plays in order', () => {
    const b = new JitterBuffer(SR, { chunkMs: 50, jitterMs: 10 });
    expect(play(b, 5).every((v) => v === 0)).toBe(true); // nothing yet
    b.push(Float32Array.from({ length: 50 }, (_, i) => i + 1));
    expect(b.stats().fillMs).toBe(60);
    expect(Array.from(play(b, 15))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5]);
  });

  it('plays a whole CPU-sized block instead of trimming it to the slack', () => {
    // Regression: a fixed 240 ms ceiling dropped all but 60 ms of every
    // 800 ms block, so CPU sessions played in short bursts.
    const b = new JitterBuffer(SR, { chunkMs: 800, jitterMs: 300 });
    b.push(new Float32Array(800).fill(1));
    expect(b.stats().droppedMs).toBe(0);
    play(b, 300); // the lead-in
    expect(play(b, 800).every((v) => v === 1)).toBe(true);
  });

  it('rides out a block that lands late by up to the slack', () => {
    const b = new JitterBuffer(SR, { chunkMs: 180, jitterMs: 72 });
    b.push(new Float32Array(180).fill(1));
    play(b, 180 + 50); // the next block is 50 ms late
    b.push(new Float32Array(180).fill(2));
    play(b, 180);
    expect(b.stats().underruns).toBe(0);
  });

  it('counts an underrun and starts the next audio with the lead-in again', () => {
    const b = new JitterBuffer(SR, { chunkMs: 20, jitterMs: 5 });
    b.push(new Float32Array(20).fill(1));
    const out = play(b, 30);
    expect(Array.from(out.slice(25))).toEqual([0, 0, 0, 0, 0]);
    expect(b.stats().underruns).toBe(1);
    b.push(new Float32Array(10).fill(2));
    expect(Array.from(play(b, 6))).toEqual([0, 0, 0, 0, 0, 2]);
  });

  it('trims a backlog past two blocks back to one block plus slack, oldest first', () => {
    const b = new JitterBuffer(SR, { chunkMs: 40, jitterMs: 10 });
    b.push(Float32Array.from({ length: 130 }, (_, i) => i));
    expect(b.stats().droppedMs).toBe(80);
    expect(b.stats().fillMs).toBe(60); // 50 kept + the 10 ms lead-in
    expect(play(b, 11)[10]).toBe(80); // the newest 50 samples were kept
  });

  it('reset empties the buffer and re-primes', () => {
    const b = new JitterBuffer(SR, { chunkMs: 10, jitterMs: 5 });
    b.push(new Float32Array(20).fill(1));
    b.reset();
    expect(play(b, 5).every((v) => v === 0)).toBe(true);
    expect(b.stats().fillMs).toBe(0);
  });
});
