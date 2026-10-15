import { useSyncExternalStore } from 'react';
import { QUALITY_PRESETS, type QualityPreset } from '@/lib/audio/live-vc/protocol';

/** Per-viewer Live Voice choices (devices, voice, quality), remembered locally. */
export interface LiveVoiceSettings {
  inputDeviceId: string;
  outputDeviceId: string;
  profileId: string;
  preset: QualityPreset;
  monitor: boolean;
}

const STORAGE_KEY = 'voicestudio.live-voice.v1';
const DEFAULTS: LiveVoiceSettings = {
  inputDeviceId: '',
  outputDeviceId: '',
  profileId: '',
  preset: 'auto',
  monitor: false,
};
let current = read();
const listeners = new Set<() => void>();

function read(): LiveVoiceSettings {
  if (typeof localStorage === 'undefined') return DEFAULTS;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<LiveVoiceSettings>;
    const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 256) : '');
    return {
      inputDeviceId: str(raw.inputDeviceId),
      outputDeviceId: str(raw.outputDeviceId),
      profileId: str(raw.profileId),
      preset: raw.preset && raw.preset in QUALITY_PRESETS ? raw.preset : 'auto',
      monitor: raw.monitor === true,
    };
  } catch {
    return DEFAULTS;
  }
}

export function getLiveVoiceSettings(): LiveVoiceSettings {
  return current;
}

export function setLiveVoiceSettings(patch: Partial<LiveVoiceSettings>): void {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* private window or blocked storage: the choice still applies this session */
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveVoiceSettings(): LiveVoiceSettings {
  return useSyncExternalStore(subscribe, getLiveVoiceSettings, () => DEFAULTS);
}
