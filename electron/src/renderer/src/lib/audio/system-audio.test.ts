import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureSystemAudio,
  effectiveInputId,
  SYSTEM_AUDIO_DEVICE_ID,
  systemAudioSupported,
} from './system-audio';

function track(kind: 'audio' | 'video') {
  return { kind, stop: vi.fn() };
}

function stubWindows({ armed = true, audio = true } = {}) {
  const video = track('video');
  const sound = track('audio');
  const tracks = audio ? [video, sound] : [video];
  const stream = {
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getTracks: () => [...tracks],
    removeTrack: (t: { kind: string }) => tracks.splice(tracks.indexOf(t as never), 1),
  };
  const getDisplayMedia = vi.fn(async () => stream);
  const armSystemAudio = vi.fn(async () => armed);
  vi.stubGlobal('voicestudio', { app: { platform: 'win32' }, permissions: { armSystemAudio } });
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });
  return { video, sound, stream, getDisplayMedia, armSystemAudio };
}

afterEach(() => vi.unstubAllGlobals());

describe('system audio input', () => {
  it('is offered only on Windows with the bridge', () => {
    expect(systemAudioSupported()).toBe(false);
    stubWindows();
    expect(systemAudioSupported()).toBe(true);
    vi.stubGlobal('voicestudio', { app: { platform: 'linux' }, permissions: { armSystemAudio: vi.fn() } });
    expect(systemAudioSupported()).toBe(false);
  });

  it('arms the grant, then keeps only the audio of the display capture', async () => {
    const env = stubWindows();
    const stream = await captureSystemAudio();
    expect(env.armSystemAudio).toHaveBeenCalledBefore(env.getDisplayMedia);
    expect(env.getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    expect(env.video.stop).toHaveBeenCalled();
    expect(stream.getVideoTracks()).toHaveLength(0);
    expect(stream.getAudioTracks()).toEqual([env.sound]);
  });

  it('refuses without a grant and releases a capture that carries no audio', async () => {
    const refused = stubWindows({ armed: false });
    await expect(captureSystemAudio()).rejects.toThrow(/not available/);
    expect(refused.getDisplayMedia).not.toHaveBeenCalled();
    const silent = stubWindows({ audio: false });
    await expect(captureSystemAudio()).rejects.toThrow(/No system audio/);
    expect(silent.video.stop).toHaveBeenCalled();
  });

  it('falls back to the default input when system audio is no longer offered', () => {
    expect(effectiveInputId(SYSTEM_AUDIO_DEVICE_ID, false)).toBe('');
    expect(effectiveInputId(SYSTEM_AUDIO_DEVICE_ID, true)).toBe(SYSTEM_AUDIO_DEVICE_ID);
    expect(effectiveInputId('mic-1', false)).toBe('mic-1');
  });
});
