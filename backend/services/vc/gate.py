"""The Live Voice opt-in.

Off by default on every platform. Turned on by the Settings toggle (stored in
prefs.json) or pinned by ``OMNIVOICE_REALTIME_VC`` — the env var wins, as for
every other prefs-backed setting. Resolved per call, so a toggle applies
without a restart.
"""
from __future__ import annotations

REALTIME_VC_PREF = "realtime_vc_enabled"
REALTIME_VC_ENV = "OMNIVOICE_REALTIME_VC"


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def realtime_vc_enabled() -> bool:
    try:
        from core import prefs

        return _truthy(prefs.resolve(REALTIME_VC_PREF, env=REALTIME_VC_ENV, default=False))
    except Exception:  # noqa: BLE001 — an unreadable setting means "off"
        return False


def env_pinned() -> bool:
    import os

    return bool(os.environ.get(REALTIME_VC_ENV, "").strip())
