import { useTranslation } from 'react-i18next';
import type { PlaybackStats } from '@/lib/audio/live-vc/engine';
import type { LiveVoiceReady, LiveVoiceStats } from '@/lib/audio/live-vc/protocol';

/** Rough capture-side latency (device + Chromium input buffering). */
export const INPUT_LATENCY_ESTIMATE_MS = 20;

export function estimateTotalMs(
  ready: LiveVoiceReady,
  stats: LiveVoiceStats | null,
  playback: PlaybackStats | null,
): number {
  return Math.round(
    INPUT_LATENCY_ESTIMATE_MS +
      ready.algorithmic_latency_ms +
      (stats?.infer_ms_p50 ?? 0) +
      (playback?.fillMs ?? 0) +
      (playback?.outputLatencyMs ?? 0),
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

export function LatencyReadout({
  ready,
  stats,
  playback,
}: {
  ready: LiveVoiceReady;
  stats: LiveVoiceStats | null;
  playback: PlaybackStats | null;
}) {
  const { t } = useTranslation();
  const ms = (value: number) => t('liveVoice.ms', { value: Math.round(value) });
  const behind = (stats?.rtf ?? 0) >= 1 || (stats?.dropped_in ?? 0) > 0;
  return (
    <section className="space-y-3 rounded-lg border p-4" aria-label={t('liveVoice.latency')}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{t('liveVoice.latency')}</h3>
        <span className="text-lg font-semibold tabular-nums" data-testid="live-voice-total-latency">
          {ms(estimateTotalMs(ready, stats, playback))}
        </span>
      </div>
      <dl className="space-y-1">
        <Row label={t('liveVoice.compute_device')} value={ready.device.toUpperCase()} />
        <Row label={t('liveVoice.latency_algorithmic')} value={ms(ready.algorithmic_latency_ms)} />
        <Row label={t('liveVoice.latency_inference')} value={stats ? `${ms(stats.infer_ms_p50)} / ${ms(stats.infer_ms_p95)}` : '–'} />
        <Row label={t('liveVoice.realtime_factor')} value={stats ? stats.rtf.toFixed(2) : '–'} />
        <Row label={t('liveVoice.latency_buffer')} value={playback ? ms(playback.fillMs) : '–'} />
        <Row label={t('liveVoice.latency_device')} value={playback ? ms(playback.outputLatencyMs) : '–'} />
        <Row label={t('liveVoice.dropped')} value={String((stats?.dropped_in ?? 0) + (stats?.dropped_out ?? 0))} />
        <Row label={t('liveVoice.underruns')} value={String(playback?.underruns ?? 0)} />
      </dl>
      {ready.warning === 'cpu_slow' && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {t('liveVoice.cpu_warning')}
        </p>
      )}
      {behind && (
        <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
          {t('liveVoice.falling_behind')}
        </p>
      )}
    </section>
  );
}
