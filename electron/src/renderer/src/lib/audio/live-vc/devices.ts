/**
 * Audio device helpers for Live Voice. Output selection uses the standard
 * `setSinkId` API on every platform; a virtual cable (VB-Cable, BlackHole, a
 * PipeWire null sink) is just another output device here. Nothing is
 * installed by the app.
 */

export async function listAudioDevices(): Promise<{
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}> {
  const mediaDevices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') {
    return { inputs: [], outputs: [] };
  }
  const devices = await mediaDevices.enumerateDevices();
  const real = (d: MediaDeviceInfo) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
  return {
    inputs: devices.filter((d) => d.kind === 'audioinput' && real(d)),
    outputs: devices.filter((d) => d.kind === 'audiooutput' && real(d)),
  };
}

/** Device names stay blank until the page has microphone permission once. */
export function needsLabelPermission(devices: MediaDeviceInfo[]): boolean {
  return devices.length > 0 && devices.every((d) => !d.label);
}

export async function unlockDeviceLabels(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
}

type SinkCapable = { setSinkId?: (id: string) => Promise<void> };

/** True when output device selection works in this runtime. */
export function supportsOutputSelection(): boolean {
  const ctx = (globalThis as { AudioContext?: { prototype: SinkCapable } }).AudioContext;
  const media = (globalThis as { HTMLMediaElement?: { prototype: SinkCapable } }).HTMLMediaElement;
  return Boolean(ctx?.prototype.setSinkId || media?.prototype.setSinkId);
}

export type HostOs = 'mac' | 'windows' | 'linux';

export function hostOs(platform = typeof navigator === 'undefined' ? '' : navigator.userAgent): HostOs {
  if (/Mac/i.test(platform)) return 'mac';
  if (/Win/i.test(platform)) return 'windows';
  return 'linux';
}
