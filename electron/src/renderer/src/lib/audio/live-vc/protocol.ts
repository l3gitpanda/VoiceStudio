/**
 * Wire shapes for the Live Voice WebSocket (`/ws/vc`, backend
 * `api/routers/vc_stream.py`) and the PCM helpers both directions use.
 */

export interface LiveVoiceParams {
  block_ms: number;
  crossfade_ms: number;
  context_ms: number;
  lookahead_ms: number;
  steps: number;
  cfg_rate: number;
  max_prompt_s: number;
  gate_db: number;
}

export interface LiveVoiceReady {
  type: 'ready';
  engine: string;
  sample_rate: number;
  block_samples: number;
  device: string;
  algorithmic_latency_ms: number;
  params: LiveVoiceParams;
  voice: { id: string; name: string; ref_seconds: number };
  warning?: 'cpu_slow';
}

export interface LiveVoiceStats {
  type: 'stats';
  infer_ms_p50: number;
  infer_ms_p95: number;
  rtf: number;
  blocks_in: number;
  blocks_out: number;
  dropped_in: number;
  dropped_out: number;
  queue_blocks: number;
}

export interface LiveVoiceStatus {
  enabled: boolean;
  env_pinned: boolean;
  engine: string;
  available: boolean;
  reason: string;
  install_supported: boolean;
  install_reason: string;
  busy: boolean;
  defaults: { gpu: LiveVoiceParams; cpu: LiveVoiceParams };
  limits: Record<keyof LiveVoiceParams, [number, number]>;
}

/** Quality presets; `auto` lets the backend pick (GPU defaults, CPU fallback). */
export const QUALITY_PRESETS = {
  auto: {},
  fast: { block_ms: 180, context_ms: 2500, steps: 4, cfg_rate: 0 },
  balanced: { block_ms: 180, context_ms: 2500, steps: 10, cfg_rate: 0.7 },
  quality: { block_ms: 300, context_ms: 2500, steps: 15, cfg_rate: 0.7 },
  cpu: { block_ms: 800, context_ms: 1000, steps: 4, cfg_rate: 0, max_prompt_s: 2 },
} as const satisfies Record<string, Partial<LiveVoiceParams>>;

export type QualityPreset = keyof typeof QUALITY_PRESETS;

/** Error codes the backend sends; each has a `liveVoice.error_<code>` string. */
export const ERROR_CODES = [
  'vc_disabled',
  'vc_not_installed',
  'voice_not_found',
  'voice_reference_missing',
  'vc_busy',
  'bad_request',
  'frame_too_large',
  'too_fast',
  'engine_failed',
] as const;

export type LiveVoiceErrorCode = (typeof ERROR_CODES)[number] | 'connection_lost' | 'mic_failed';

export function knownErrorCode(code: unknown): LiveVoiceErrorCode {
  return typeof code === 'string' && (ERROR_CODES as readonly string[]).includes(code)
    ? (code as LiveVoiceErrorCode)
    : 'engine_failed';
}

export function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

export function pcm16ToFloat(buffer: ArrayBuffer): Float32Array {
  const pcm = new Int16Array(buffer, 0, Math.floor(buffer.byteLength / 2));
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] / 32768;
  return out;
}
