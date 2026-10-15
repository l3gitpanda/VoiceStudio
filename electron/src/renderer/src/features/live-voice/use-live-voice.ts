import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiJson } from '@/lib/api/client';
import { LiveVoiceEngine, type LiveVoiceDeps, type PlaybackStats } from '@/lib/audio/live-vc/engine';
import {
  QUALITY_PRESETS,
  type LiveVoiceErrorCode,
  type LiveVoiceReady,
  type LiveVoiceStats,
  type LiveVoiceStatus,
} from '@/lib/audio/live-vc/protocol';
import type { LiveVoiceSettings } from '@/lib/store/live-voice-settings';

export const LIVE_VOICE_STATUS_KEY = ['live-voice-status'] as const;

export function useLiveVoiceStatus() {
  return useQuery({
    queryKey: LIVE_VOICE_STATUS_KEY,
    queryFn: ({ signal }) => apiJson<LiveVoiceStatus>('/vc/status', { signal }),
    refetchInterval: 15_000,
  });
}

export type LiveVoiceStage = 'idle' | 'connecting' | 'loading' | 'running';

export interface LiveVoiceError {
  code: LiveVoiceErrorCode;
  detail: string;
}

export function useLiveVoiceSession(deps?: LiveVoiceDeps) {
  const engine = useRef<LiveVoiceEngine | null>(null);
  const [stage, setStage] = useState<LiveVoiceStage>('idle');
  const [ready, setReady] = useState<LiveVoiceReady | null>(null);
  const [stats, setStats] = useState<LiveVoiceStats | null>(null);
  const [playback, setPlayback] = useState<PlaybackStats | null>(null);
  const [error, setError] = useState<LiveVoiceError | null>(null);
  const [bypass, setBypassState] = useState(false);

  useEffect(() => () => engine.current?.stop(), []);

  const start = useCallback(
    async (settings: LiveVoiceSettings) => {
      engine.current?.stop();
      setError(null);
      setReady(null);
      setStats(null);
      setPlayback(null);
      const next = new LiveVoiceEngine(
        {
          onStage: setStage,
          onReady: setReady,
          onStats: setStats,
          onPlayback: setPlayback,
          onError: (code, detail) => setError({ code, detail }),
          onStopped: () => {
            if (engine.current === next) engine.current = null;
            setStage('idle');
          },
        },
        deps,
      );
      engine.current = next;
      await next.start({
        profileId: settings.profileId,
        inputDeviceId: settings.inputDeviceId,
        outputDeviceId: settings.outputDeviceId,
        monitor: settings.monitor,
        bypass,
        params: QUALITY_PRESETS[settings.preset],
      });
    },
    [bypass, deps],
  );

  const stop = useCallback(() => engine.current?.stop(), []);
  const setBypass = useCallback((on: boolean) => {
    setBypassState(on);
    engine.current?.setBypass(on);
  }, []);
  const setMonitor = useCallback((on: boolean) => {
    void engine.current?.setMonitor(on);
  }, []);

  return { stage, ready, stats, playback, error, bypass, start, stop, setBypass, setMonitor, clearError: () => setError(null) };
}
