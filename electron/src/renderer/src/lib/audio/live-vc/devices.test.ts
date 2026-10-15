import { afterEach, expect, it, vi } from 'vitest';
import { hostOs, listAudioDevices, needsLabelPermission, supportsOutputSelection } from './devices';
import { floatToPcm16, knownErrorCode, pcm16ToFloat, QUALITY_PRESETS } from './protocol';

afterEach(() => vi.unstubAllGlobals());

const device = (kind: string, deviceId: string, label = '') => ({ kind, deviceId, label }) as MediaDeviceInfo;

it('splits inputs from outputs and hides the browser alias entries', async () => {
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => [
        device('audioinput', 'default', 'Default'),
        device('audioinput', 'mic-1', 'USB Mic'),
        device('audiooutput', 'communications', 'Comms'),
        device('audiooutput', 'cable', 'CABLE Input'),
        device('videoinput', 'cam', 'Camera'),
      ],
    },
  });
  const { inputs, outputs } = await listAudioDevices();
  expect(inputs.map((d) => d.deviceId)).toEqual(['mic-1']);
  expect(outputs.map((d) => d.deviceId)).toEqual(['cable']);
});

it('works without media devices at all', async () => {
  vi.stubGlobal('navigator', {});
  expect(await listAudioDevices()).toEqual({ inputs: [], outputs: [] });
});

it('asks for names only when every device is unnamed', () => {
  expect(needsLabelPermission([device('audioinput', 'a'), device('audiooutput', 'b')])).toBe(true);
  expect(needsLabelPermission([device('audioinput', 'a', 'Mic')])).toBe(false);
  expect(needsLabelPermission([])).toBe(false);
});

it('detects output selection support', () => {
  vi.stubGlobal('AudioContext', class { setSinkId() {} });
  expect(supportsOutputSelection()).toBe(true);
});

it('maps the platform to per-OS cable guidance', () => {
  expect(hostOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
  expect(hostOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
  expect(hostOs('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux');
});

it('round-trips PCM16 and clamps out-of-range samples', () => {
  const pcm = floatToPcm16(new Float32Array([2, -2, 0]));
  expect(Array.from(new Int16Array(pcm))).toEqual([32767, -32768, 0]);
  expect(Array.from(pcm16ToFloat(new Int16Array([16384]).buffer))).toEqual([0.5]);
});

it('only trusts known error codes and keeps presets within the backend bounds', () => {
  expect(knownErrorCode('vc_busy')).toBe('vc_busy');
  expect(knownErrorCode('constructor')).toBe('engine_failed');
  for (const preset of Object.values(QUALITY_PRESETS)) {
    const p = preset as Record<string, number>;
    if (p.block_ms !== undefined) expect(p.block_ms).toBeGreaterThanOrEqual(80);
    if (p.steps !== undefined) expect(p.steps).toBeLessThanOrEqual(30);
  }
});
