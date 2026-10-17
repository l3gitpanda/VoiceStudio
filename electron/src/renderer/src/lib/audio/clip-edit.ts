/**
 * Cut-and-trim operations behind the reference clip editor. A clip is mono
 * PCM in memory; every edit returns a new clip and never changes its input,
 * so the editor undoes by keeping the earlier clips.
 */
import { encodeWav } from '@shared/utils/audioTrim';
import { readWavInfo } from './wav-info';

export interface Clip {
  samples: Float32Array;
  sampleRate: number;
}

/** Shortest selection, and shortest result, the editor produces (seconds). */
export const MIN_CLIP_SECONDS = 0.05;
/** Longest source the editor opens: 10 min of 48 kHz samples is ~115 MB. */
export const EDITOR_MAX_SOURCE_SECONDS = 600;
// A cut out of the middle crossfades its two sides, and a new edge fades in
// or out, so no edit leaves a click for the engine to clone.
const JOIN_SECONDS = 0.01;
const EDGE_FADE_SECONDS = 0.005;
// Compressed sources (a WebM recording, an MP3) decode at 48 kHz: the
// recorder's native rate, and above what any engine reads from a reference.
const DEFAULT_SAMPLE_RATE = 48_000;

export function clipSeconds(clip: Clip): number {
  return clip.samples.length / clip.sampleRate;
}

function sampleSpan(clip: Clip, start: number, end: number): [number, number] {
  const index = (seconds: number) =>
    Math.min(clip.samples.length, Math.max(0, Math.round(seconds * clip.sampleRate)));
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new RangeError('Invalid clip range');
  const from = index(start);
  const to = index(end);
  if (to - from < Math.round(MIN_CLIP_SECONDS * clip.sampleRate))
    throw new RangeError('Invalid clip range');
  return [from, to];
}

function fadeEdges(samples: Float32Array, sampleRate: number, fadeIn: boolean, fadeOut: boolean) {
  const length = Math.min(Math.round(EDGE_FADE_SECONDS * sampleRate), samples.length >> 1);
  for (let i = 0; i < length; i++) {
    const gain = i / length;
    if (fadeIn) samples[i] *= gain;
    if (fadeOut) samples[samples.length - 1 - i] *= gain;
  }
}

/** Keep only `start`–`end` (seconds). */
export function keepRange(clip: Clip, start: number, end: number): Clip {
  const [from, to] = sampleSpan(clip, start, end);
  const samples = clip.samples.slice(from, to);
  fadeEdges(samples, clip.sampleRate, from > 0, to < clip.samples.length);
  return { samples, sampleRate: clip.sampleRate };
}

/** Cut `start`–`end` (seconds) out and join what is left on either side. */
export function removeRange(clip: Clip, start: number, end: number): Clip {
  const [from, to] = sampleSpan(clip, start, end);
  const { samples: source, sampleRate } = clip;
  const tail = source.length - to;
  if (from + tail < Math.round(MIN_CLIP_SECONDS * sampleRate))
    throw new RangeError('Nothing would be left');
  const join = Math.min(Math.round(JOIN_SECONDS * sampleRate), from, tail);
  const samples = new Float32Array(from + tail - join);
  samples.set(source.subarray(0, from - join));
  for (let i = 0; i < join; i++) {
    const weight = (i + 1) / (join + 1);
    samples[from - join + i] = source[from - join + i] * (1 - weight) + source[to + i] * weight;
  }
  samples.set(source.subarray(to + join), from);
  fadeEdges(samples, sampleRate, from === 0, tail === 0);
  return { samples, sampleRate };
}

/** Loudest sample per bucket, about `perSecond` buckets a second, for drawing. */
export function clipPeaks(clip: Clip, perSecond = 400): Float32Array {
  const { samples } = clip;
  const buckets = Math.max(1, Math.min(samples.length, Math.ceil(clipSeconds(clip) * perSecond)));
  const peaks = new Float32Array(buckets);
  const step = samples.length / buckets;
  for (let bucket = 0; bucket < buckets; bucket++) {
    let peak = 0;
    const end = Math.min(samples.length, Math.floor((bucket + 1) * step));
    for (let i = Math.floor(bucket * step); i < end; i++)
      peak = Math.max(peak, Math.abs(samples[i]));
    peaks[bucket] = peak;
  }
  return peaks;
}

/** 16-bit mono PCM WAV, which every engine and the profile store accept. */
export function clipToWav(clip: Clip): Blob {
  return new Blob([encodeWav(clip.samples, clip.sampleRate)], { type: 'audio/wav' });
}

/** Decode any clip the browser can play to mono, at a WAV's own sample rate. */
export async function decodeClip(blob: Blob): Promise<Clip> {
  const bytes = await blob.arrayBuffer();
  const native = readWavInfo(bytes)?.sampleRate;
  const sampleRate = native && native >= 8_000 && native <= 96_000 ? native : DEFAULT_SAMPLE_RATE;
  const decoded = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(bytes);
  const channels = decoded.numberOfChannels;
  if (channels === 1) return { samples: decoded.getChannelData(0), sampleRate };
  const samples = new Float32Array(decoded.length);
  for (let channel = 0; channel < channels; channel++) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) samples[i] += data[i] / channels;
  }
  return { samples, sampleRate };
}

/** `voice.mp3` → `voice-edited.wav`, without stacking suffixes on re-edits. */
export function editedClipName(name: string): string {
  const stem = name.replace(/\.[^./\\]+$/, '').replace(/-edited$/, '');
  return (stem || 'clip') + '-edited.wav';
}
