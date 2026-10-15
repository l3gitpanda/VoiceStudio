import { useSyncExternalStore } from 'react';
import { apiJson } from '@/lib/api/client';

/**
 * Whether the opt-in Live Voice workspace is on, for the navigation shell.
 * Read once from `GET /api/settings/realtime-vc` when first needed and
 * updated by the Settings toggle; any failure (e.g. a remote web client
 * without settings access) reads as off.
 */
let enabled = false;
let loaded = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function setLiveVoiceEnabled(value: boolean): void {
  loaded = true;
  if (enabled === value) return;
  enabled = value;
  emit();
}

async function load(): Promise<void> {
  loaded = true;
  try {
    const state = await apiJson<{ enabled: boolean }>('/api/settings/realtime-vc');
    setLiveVoiceEnabled(state.enabled === true);
  } catch {
    /* stays off */
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!loaded) void load();
  return () => listeners.delete(listener);
}

export function useLiveVoiceEnabledFlag(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => false);
}
