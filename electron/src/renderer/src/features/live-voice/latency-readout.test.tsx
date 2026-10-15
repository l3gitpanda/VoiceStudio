import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));

import { estimateTotalMs, INPUT_LATENCY_ESTIMATE_MS, LatencyReadout } from './latency-readout';
import type { LiveVoiceReady, LiveVoiceStats } from '@/lib/audio/live-vc/protocol';

const ready: LiveVoiceReady = {
  type: 'ready', engine: 'seed-vc', sample_rate: 22050, block_samples: 3969, device: 'cuda',
  algorithmic_latency_ms: 260, params: {} as LiveVoiceReady['params'],
  voice: { id: 'v', name: 'V', ref_seconds: 3 },
};
const stats: LiveVoiceStats = {
  type: 'stats', infer_ms_p50: 120, infer_ms_p95: 160, rtf: 0.67,
  blocks_in: 5, blocks_out: 5, dropped_in: 0, dropped_out: 0, queue_blocks: 0,
};
const playback = { fillMs: 60, underruns: 2, droppedMs: 0, outputLatencyMs: 30, droppedSendFrames: 0 };

afterEach(() => cleanup());

it('adds every stage of the path into the total estimate', () => {
  expect(estimateTotalMs(ready, stats, playback)).toBe(INPUT_LATENCY_ESTIMATE_MS + 260 + 120 + 60 + 30);
  expect(estimateTotalMs(ready, null, null)).toBe(INPUT_LATENCY_ESTIMATE_MS + 260);
});

it('shows the device, the parts and gaps, and warns when the model falls behind', () => {
  const { rerender } = render(<LatencyReadout ready={ready} stats={stats} playback={playback} />);
  expect(screen.getByTestId('live-voice-total-latency')).toHaveTextContent('{"value":490}');
  expect(screen.getByText('CUDA')).toBeInTheDocument();
  expect(screen.getByText('0.67')).toBeInTheDocument();
  expect(screen.queryByText('liveVoice.falling_behind')).not.toBeInTheDocument();
  rerender(<LatencyReadout ready={ready} stats={{ ...stats, rtf: 1.3, dropped_in: 4 }} playback={playback} />);
  expect(screen.getByText('liveVoice.falling_behind')).toBeInTheDocument();
});
