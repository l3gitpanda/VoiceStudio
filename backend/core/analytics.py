"""Product analytics — removed. This build sends no telemetry of any kind.

There is no analytics SDK, no destination token, and no analytics host in this
codebase; ``tests/test_telemetry_removed.py`` fails if any of them comes back.
The functions below keep the old call sites (generation, error journal,
startup, Settings → Privacy) working as inert no-ops, so nothing has to be
re-wired and an upstream change that still calls them cannot leak data.

The only real work left is housekeeping for installs that opted in under an
older build: ``record_startup_lifecycle`` turns the old consent off, forgets
the random installation id and lifecycle markers, and deletes the
``analytics_info.json`` file the uninstall scripts once read to send an
``app_uninstalled`` ping.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

logger = logging.getLogger("omnivoice.analytics")

#: Prefs keys written by the removed analytics client. Purged on startup.
_LEGACY_PREF_KEYS = (
    "analytics_enabled",
    "analytics_install_recorded",
    "analytics_last_version",
    "installation_id",
)

#: File the removed client kept next to prefs.json for the uninstall ping.
UNINSTALL_PING_INFO_BASENAME = "analytics_info.json"


def token_configured() -> bool:
    """No analytics destination exists in this build."""
    return False


def user_opted_in() -> bool:
    return False


def user_prompted() -> bool:
    """Reported as already answered so no consent prompt is ever shown."""
    return True


def enabled() -> bool:
    return False


def set_opted_in(enabled: bool) -> None:  # noqa: ARG001 — kept for the settings route
    """Opting in is impossible; any request only clears leftover state."""
    purge_legacy_state()


def capture(event: str, properties: Optional[dict] = None) -> None:  # noqa: ARG001
    """No-op. Nothing is ever transmitted."""


def record_error_event(error_class: str, fingerprint: str, stage: str = "") -> None:  # noqa: ARG001
    """No-op. Nothing is ever transmitted."""


def record_startup_lifecycle(crash_record: Optional[dict] = None) -> None:  # noqa: ARG001
    """Called once at startup. Sends nothing; removes old analytics state."""
    purge_legacy_state()


def shutdown() -> None:
    """No client exists, so there is nothing to flush."""


def purge_legacy_state() -> None:
    """Remove consent, ids and the uninstall-ping file left by older builds.
    Never raises."""
    try:
        from core import prefs

        for key in _LEGACY_PREF_KEYS:
            if prefs.get(key) is not None:
                prefs.delete(key)
    except Exception:  # noqa: BLE001 — housekeeping must never break startup
        logger.debug("analytics prefs cleanup failed (non-fatal)", exc_info=True)
    try:
        from core.config import DATA_DIR

        os.remove(os.path.join(DATA_DIR, UNINSTALL_PING_INFO_BASENAME))
    except FileNotFoundError:
        pass
    except Exception:  # noqa: BLE001
        logger.debug("analytics_info cleanup failed (non-fatal)", exc_info=True)
