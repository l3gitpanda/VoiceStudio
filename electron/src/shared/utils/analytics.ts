/**
 * Product analytics — removed. This build sends no telemetry of any kind.
 *
 * There is no analytics SDK, destination token or analytics host in this
 * codebase; tests/test_telemetry_removed.py fails if any of them comes back.
 * The exports below keep existing callers (error boundary, global error
 * recovery, route breadcrumbs, consent components) compiling as inert no-ops,
 * so nothing has to be re-wired and no caller can transmit anything.
 *
 * The backend reports analytics as unavailable, so the consent prompt, banner
 * and Settings → Privacy toggle never render.
 */

export const ANALYTICS_EXCEPTION_STAGES = [
  'renderer:uncaught',
  'renderer:rejection',
  'renderer:react-boundary',
  'renderer:task',
] as const;

export type AnalyticsExceptionStage = (typeof ANALYTICS_EXCEPTION_STAGES)[number];

/** Storage keys the removed posthog-js client wrote (`ph_<token>_posthog`,
 *  `__ph_opt_in_out_<token>`). */
const LEGACY_STORAGE_KEY = /^(?:ph_.*_posthog|__ph_opt_in_out_.*)$/;

/** Remove the anonymous id and opt-in flag an older build may have stored. */
export function purgeLegacyAnalyticsStorage(): void {
  for (const storage of [globalThis.localStorage, globalThis.sessionStorage]) {
    try {
      if (!storage) continue;
      const stale: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key && LEGACY_STORAGE_KEY.test(key)) stale.push(key);
      }
      for (const key of stale) storage.removeItem(key);
    } catch {
      /* storage unavailable — nothing to clean */
    }
  }
}

/** Always false: this build has no analytics destination. */
export function analyticsAvailable(): boolean {
  return false;
}

/** No-op. */
export async function enableAnalytics(): Promise<void> {}

/** Nothing to stop; clears state left by older builds. */
export function disableAnalytics(): void {
  purgeLegacyAnalyticsStorage();
}

/** No-op. */
export function capture(_event: string, _props?: Record<string, unknown>): void {}

/** No-op. */
export function capturePageview(_screen: string): void {}

/** No-op. */
export function captureException(_error: unknown, _stage: AnalyticsExceptionStage): void {}

/** Always resolves false: analytics can never start. */
export async function initAnalyticsFromConsent(
  _fetchState?: () => Promise<{ opted_in?: boolean; available?: boolean }>,
): Promise<boolean> {
  purgeLegacyAnalyticsStorage();
  return false;
}
