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
  it('stays silent until the target fill is reached, then plays in order', () => {
    const b = new JitterBuffer(SR, { targetMs: 60, maxMs: 240 });
    const out = new Float32Array(10);
    b.push(Float32Array.from({ length: 50 }, (_, i) => i + 1));
    b.pull(out);
    expect(Array.from(out)).toEqual(new Array(10).fill(0));
    b.push(Float32Array.from({ length: 20 }, (_, i) => i + 51));
    b.pull(out);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(b.stats().fillMs).toBe(60);
  });

  it('counts an underrun and refills before playing again', () => {
    const b = new JitterBuffer(SR, { targetMs: 20, maxMs: 100 });
    b.push(new Float32Array(25).fill(1));
    const out = new Float32Array(30);
    b.pull(out);
    expect(Array.from(out.slice(25))).toEqual([0, 0, 0, 0, 0]);
    expect(b.stats().underruns).toBe(1);
    b.push(new Float32Array(10).fill(2));
    b.pull(out);
    expect(out.every((v) => v === 0)).toBe(true); // below target again: wait
  });

  it('drops the oldest audio back to the target when clocks drift and it grows', () => {
    const b = new JitterBuffer(SR, { targetMs: 50, maxMs: 100 });
    b.push(Float32Array.from({ length: 130 }, (_, i) => i));
    expect(b.stats().fillMs).toBe(50);
    expect(b.stats().droppedMs).toBe(80);
    const out = new Float32Array(1);
    b.pull(out);
    expect(out[0]).toBe(80); // the newest 50 samples were kept
  });

  it('reset empties the buffer and re-primes', () => {
    const b = new JitterBuffer(SR, { targetMs: 10, maxMs: 50 });
    b.push(new Float32Array(20).fill(1));
    b.reset();
    const out = new Float32Array(5);
    b.pull(out);
    expect(out.every((v) => v === 0)).toBe(true);
    expect(b.stats().fillMs).toBe(0);
  });
});
