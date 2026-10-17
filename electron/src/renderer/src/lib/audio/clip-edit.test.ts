import { describe, expect, it } from 'vitest';
import {
  clipPeaks,
  clipSeconds,
  clipToWav,
  editedClipName,
  keepRange,
  removeRange,
  type Clip,
} from './clip-edit';

// 2 s at 1 kHz: +0.5 for the first second, -0.5 for the second.
const RATE = 1000;
function steps(): Clip {
  const samples = new Float32Array(2 * RATE);
  samples.fill(0.5, 0, RATE).fill(-0.5, RATE);
  return { samples, sampleRate: RATE };
}

describe('keepRange', () => {
  it('keeps exactly the selected samples and fades only the new edges', () => {
    const kept = keepRange(steps(), 0.5, 1.5);
    expect(kept.samples.length).toBe(RATE);
    expect(kept.sampleRate).toBe(RATE);
    // 5 ms edge fades at 1 kHz: the first and last 5 samples ramp.
    expect(kept.samples[0]).toBe(0);
    expect(kept.samples[5]).toBe(0.5);
    expect(kept.samples[499]).toBe(0.5);
    expect(kept.samples[500]).toBe(-0.5);
    expect(kept.samples.at(-1)).toBeCloseTo(0);
    expect(kept.samples.at(-6)).toBe(-0.5);
  });

  it('leaves an original edge untouched and never changes its input', () => {
    const clip = steps();
    const kept = keepRange(clip, 0, 1);
    expect(kept.samples[0]).toBe(0.5);
    expect(clip.samples[0]).toBe(0.5);
    expect(clip.samples.length).toBe(2 * RATE);
  });
});

describe('removeRange', () => {
  it('cuts the selection out and crossfades the join', () => {
    const cut = removeRange(steps(), 0.5, 1.5);
    // 0.5 s from each side, less the 10 ms the crossfade overlaps.
    expect(clipSeconds(cut)).toBeCloseTo(0.99);
    expect(cut.samples[0]).toBe(0.5);
    expect(cut.samples.at(-1)).toBe(-0.5);
    const join = cut.samples.slice(489, 501);
    for (let i = 1; i < join.length; i++) expect(join[i]).toBeLessThan(join[i - 1]);
  });

  it('fades in where a cut from the start leaves a new beginning', () => {
    const cut = removeRange(steps(), 0, 0.5);
    expect(cut.samples.length).toBe(1500);
    expect(cut.samples[0]).toBe(0);
    expect(cut.samples[5]).toBe(0.5);
    expect(cut.samples.at(-1)).toBe(-0.5);
  });

  it('refuses to cut the whole clip away', () => {
    expect(() => removeRange(steps(), 0, 2)).toThrow(RangeError);
    expect(() => removeRange(steps(), 0.01, 1.99)).toThrow(RangeError);
  });
});

it('rejects empty, inverted and non-finite selections', () => {
  for (const [start, end] of [
    [1, 1],
    [1.5, 1],
    [NaN, 1],
    [0, Infinity],
    [1, 1.01],
  ])
    expect(() => keepRange(steps(), start, end)).toThrow(RangeError);
});

it('encodes 16-bit mono PCM at the clip rate', async () => {
  const bytes = await clipToWav(steps()).arrayBuffer();
  const view = new DataView(bytes);
  expect(bytes.byteLength).toBe(44 + 2 * RATE * 2);
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(RATE);
  expect(view.getUint16(34, true)).toBe(16);
});

it('draws the loudest sample of each bucket', () => {
  const peaks = clipPeaks(steps(), 2);
  expect(Array.from(peaks)).toEqual([0.5, 0.5, 0.5, 0.5]);
});

it('names an edit after its source without stacking suffixes', () => {
  expect(editedClipName('voice.mp3')).toBe('voice-edited.wav');
  expect(editedClipName('voice-edited.wav')).toBe('voice-edited.wav');
  expect(editedClipName('take.one.webm')).toBe('take.one-edited.wav');
  expect(editedClipName('.wav')).toBe('clip-edited.wav');
});
