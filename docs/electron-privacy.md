# Electron privacy and retention

> **Historical context:** this page was written while the Electron and Tauri apps
> coexisted. Mentions of Tauri helpers, pages, tests and regression results describe
> that migration period; the Tauri shell has since been removed and the shared code
> now lives in `electron/src/shared/`. Existing Tauri installs: see the
> [migration guide](electron-migration.md).

Settings > Privacy exposes the existing invisible-watermark setting and generation-history retention. Product analytics has been removed: the app contains no analytics SDK, token or host, never shows a consent prompt, and sends no telemetry. On startup it deletes consent flags, the random installation id and the uninstall-ping file left by older builds, and the renderer clears the old posthog-js storage keys. `tests/test_telemetry_removed.py` fails if any analytics dependency, token or host returns.

Watermark controls appear when the backend reports AudioSeal available and affect new audio through the existing marking path. No audio producer bypasses `mark_synthetic`. Unavailable features do not display inert toggles, and failed saves preserve confirmed state.

Translation privacy classification is shared with Tauri. Unknown or unavailable backend data does not claim offline operation. The existing `libretranslate` identifier is an alias for the backend's local Argos branch, not an assumption about an external LibreTranslate service. The Translation link opens engine settings.

Retention supports 0 (unlimited), validates whole-number limits up to 100000 and explains that cleanup removes old unstarred takes and their audio after generation. A more restrictive cap requires inline confirmation. Raising the cap or disabling cleanup saves directly. No records or files are deleted by simply opening settings or editing the input.

`electron/tests/privacy-settings-smoke.mjs` covers watermark changes, failed writes, availability, retention confirmation/cancel, unlimited retention and reload with mocked endpoints. Tauri privacy regressions pass after sharing classification. Live read-only checks verified the watermark and retention schemas without changing the user's privacy preferences or deleting data.

AudioSeal receives 16 kHz audio for embedding and detection, including with
AudioSeal 0.2, which no longer resamples internally. Processing remains bounded
by chunk size. Only the watermark residual is resampled back and added to the
original signal, retaining its sample rate, length, and high-frequency content.
