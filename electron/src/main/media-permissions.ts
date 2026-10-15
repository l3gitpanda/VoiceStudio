import type { Session } from 'electron';
import { systemAudioGate } from './system-audio';
import { isTrustedRenderer } from './trusted-renderer';

const TRUSTED_RENDERER_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  // Live Voice routes converted audio to a chosen output (setSinkId).
  'speaker-selection',
]);

export function allowsRendererPermission(
  permission: string,
  requestingUrl: string,
  mediaTypes: readonly string[] | undefined,
  devOrigin?: string,
  isMainFrame = true,
  systemAudioArmed = false,
): boolean {
  if (!isMainFrame || !isTrustedRenderer(requestingUrl, devOrigin)) return false;
  // A display capture is only the carrier for armed system-audio loopback
  // (system-audio.ts); its video track is dropped by the renderer.
  if (permission === 'display-capture') return systemAudioArmed;
  if (permission !== 'media') return TRUSTED_RENDERER_PERMISSIONS.has(permission);
  return !mediaTypes?.includes('video') || systemAudioArmed;
}

/**
 * Electron requires both handlers for complete Chromium permission handling.
 * VoiceStudio grants its trusted renderer audio capture and the small set of
 * browser permissions its existing controls use; every foreign origin and
 * camera request remains denied.
 */
export function installRendererPermissions(session: Session, devOrigin?: string): void {
  session.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      allowsRendererPermission(
        permission,
        details.requestingUrl || requestingOrigin || webContents?.getURL() || '',
        details.mediaType ? [details.mediaType] : undefined,
        devOrigin,
        details.isMainFrame,
        systemAudioGate.isArmed(),
      ),
  );
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const request = details as Electron.MediaAccessPermissionRequest;
    callback(
      allowsRendererPermission(
        permission,
        details.requestingUrl || request.securityOrigin || webContents.getURL(),
        request.mediaTypes,
        devOrigin,
        details.isMainFrame,
        systemAudioGate.isArmed(),
      ),
    );
  });
}
