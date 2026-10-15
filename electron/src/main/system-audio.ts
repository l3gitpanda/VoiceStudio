import type { DesktopCapturerSource, IpcMainInvokeEvent, Session } from 'electron';
import { isTrustedRenderer } from './trusted-renderer';

/**
 * "System audio" as a recording input: Windows loopback of everything the
 * default output device plays. Chromium only offers it through
 * getDisplayMedia, so the renderer arms one request over IPC and the next
 * display-media request from the trusted renderer within ARM_MS is answered
 * with a screen source (which the renderer drops at once) plus loopback audio.
 * Any other request, unarmed or from another origin, is refused, so this never
 * becomes a screen-capture path.
 */
export const ARM_MS = 5000;

export function systemAudioSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

interface ArmState {
  until: number;
}

export function createSystemAudioGate(now: () => number = Date.now) {
  let armed: ArmState | null = null;
  return {
    arm(): void {
      armed = { until: now() + ARM_MS };
    },
    /** True while armed; does not consume the grant. */
    isArmed(): boolean {
      return armed !== null && now() <= armed.until;
    },
    /** Consumes the grant: true once per arm, inside its window. */
    take(): boolean {
      const ok = armed !== null && now() <= armed.until;
      armed = null;
      return ok;
    },
  };
}

export type SystemAudioGate = ReturnType<typeof createSystemAudioGate>;

export const systemAudioGate = createSystemAudioGate();

export function handleArmRequest(
  event: Pick<IpcMainInvokeEvent, 'senderFrame'>,
  gate: SystemAudioGate,
  devOrigin?: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const url = event.senderFrame?.url ?? '';
  if (!systemAudioSupported(platform) || !isTrustedRenderer(url, devOrigin)) return false;
  gate.arm();
  return true;
}

export const SYSTEM_AUDIO_CHANNEL = 'permissions:armSystemAudio';

export function installSystemAudioCapture(
  session: Pick<Session, 'setDisplayMediaRequestHandler'>,
  ipc: { handle(channel: string, listener: (event: IpcMainInvokeEvent) => unknown): void },
  getScreen: () => Promise<DesktopCapturerSource | undefined>,
  devOrigin?: string,
  platform: NodeJS.Platform = process.platform,
  gate: SystemAudioGate = systemAudioGate,
): void {
  ipc.handle(SYSTEM_AUDIO_CHANNEL, (event) => handleArmRequest(event, gate, devOrigin, platform));
  session.setDisplayMediaRequestHandler((request, callback) => {
    const trusted = !!request.frame && isTrustedRenderer(request.frame.url, devOrigin);
    if (!gate.take() || !trusted || !request.audioRequested || !systemAudioSupported(platform)) {
      callback({});
      return;
    }
    getScreen().then(
      (screen) => callback(screen ? { video: screen, audio: 'loopback' } : {}),
      () => callback({}),
    );
  });
}
