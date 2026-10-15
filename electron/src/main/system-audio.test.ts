import { describe, expect, it } from 'vitest';
import type { DesktopCapturerSource } from 'electron';
import {
  ARM_MS,
  createSystemAudioGate,
  handleArmRequest,
  installSystemAudioCapture,
  SYSTEM_AUDIO_CHANNEL,
} from './system-audio';
import { allowsRendererPermission } from './media-permissions';

const APP = 'app://voicestudio/index.html';
const SCREEN = { id: 'screen:0:0', name: 'Screen' } as DesktopCapturerSource;

function setup(platform: NodeJS.Platform = 'win32') {
  let clock = 1000;
  const gate = createSystemAudioGate(() => clock);
  const handlers = new Map<string, (event: { senderFrame: { url: string } | null }) => unknown>();
  let onDisplayMedia: ((request: object, callback: (streams: object) => void) => void) | null = null;
  installSystemAudioCapture(
    { setDisplayMediaRequestHandler: (handler) => (onDisplayMedia = handler as typeof onDisplayMedia) },
    { handle: (channel, listener) => handlers.set(channel, listener as never) },
    async () => SCREEN,
    undefined,
    platform,
    gate,
  );
  const arm = (url = APP) => handlers.get(SYSTEM_AUDIO_CHANNEL)!({ senderFrame: { url } });
  const request = (url = APP, audioRequested = true) =>
    new Promise<object>((resolve) => onDisplayMedia!({ frame: { url }, audioRequested, videoRequested: true }, resolve));
  return { gate, arm, request, advance: (ms: number) => (clock += ms) };
}

describe('system audio capture', () => {
  it('answers one armed request from the app with a screen carrier and loopback audio', async () => {
    const env = setup();
    expect(env.arm()).toBe(true);
    await expect(env.request()).resolves.toEqual({ video: SCREEN, audio: 'loopback' });
    await expect(env.request()).resolves.toEqual({}); // the grant was used up
  });

  it('refuses unarmed, expired, foreign and video-only requests', async () => {
    const env = setup();
    await expect(env.request()).resolves.toEqual({});
    env.arm();
    env.advance(ARM_MS + 1);
    await expect(env.request()).resolves.toEqual({});
    env.arm();
    await expect(env.request('https://evil.example/')).resolves.toEqual({});
    env.arm();
    await expect(env.request(APP, false)).resolves.toEqual({});
  });

  it('only arms from the app, and only on Windows', async () => {
    expect(setup().arm('https://evil.example/')).toBe(false);
    const mac = setup('darwin');
    expect(mac.arm()).toBe(false);
    await expect(mac.request()).resolves.toEqual({});
    const gate = createSystemAudioGate();
    expect(handleArmRequest({ senderFrame: null } as never, gate, undefined, 'win32')).toBe(false);
    expect(gate.isArmed()).toBe(false);
  });

  it('allows display capture permission only while armed', () => {
    expect(allowsRendererPermission('display-capture', APP, undefined)).toBe(false);
    expect(allowsRendererPermission('media', APP, ['video', 'audio'])).toBe(false);
    expect(allowsRendererPermission('display-capture', APP, undefined, undefined, true, true)).toBe(true);
    expect(allowsRendererPermission('media', APP, ['video', 'audio'], undefined, true, true)).toBe(true);
    expect(allowsRendererPermission('display-capture', 'https://evil.example/', undefined, undefined, true, true)).toBe(false);
  });
});
