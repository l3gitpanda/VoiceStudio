/**
 * "System audio" as a recording input: what this computer plays, captured by
 * Windows loopback (src/main/system-audio.ts). Opt-in from Settings → Live
 * Voice; Linux lists each output's "Monitor of …" source as a normal input
 * instead, and macOS has no loopback without a driver such as BlackHole.
 */
import { getBridge } from '@/components/bridge';
import { useLiveVoiceSettings } from '@/lib/store/live-voice-settings';

/** Pseudo device id for the picker entry; never a real deviceId. */
export const SYSTEM_AUDIO_DEVICE_ID = 'voicestudio:system-audio';

export function systemAudioSupported(): boolean {
  const bridge = getBridge();
  return (
    bridge?.app.platform === 'win32' &&
    typeof bridge.permissions?.armSystemAudio === 'function' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  );
}

/** Whether pickers should offer system audio: turned on, and possible here. */
export function useSystemAudioOffered(): boolean {
  const { systemAudio } = useLiveVoiceSettings();
  return systemAudio && systemAudioSupported();
}

/** A picker value that is no longer offered falls back to the default input. */
export function effectiveInputId(deviceId: string, offered: boolean): string {
  return deviceId === SYSTEM_AUDIO_DEVICE_ID && !offered ? '' : deviceId;
}

export async function captureSystemAudio(): Promise<MediaStream> {
  const bridge = getBridge();
  if (!bridge || !(await bridge.permissions.armSystemAudio())) {
    throw new DOMException('System audio capture is not available on this computer.', 'NotSupportedError');
  }
  // Chromium only hands out loopback with a display capture; the screen track
  // is a carrier and is dropped before anything reads it.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  for (const track of stream.getVideoTracks()) {
    track.stop();
    stream.removeTrack(track);
  }
  if (!stream.getAudioTracks().length) {
    for (const track of stream.getTracks()) track.stop();
    throw new DOMException('No system audio was captured.', 'NotFoundError');
  }
  return stream;
}
