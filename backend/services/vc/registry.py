"""Voice-conversion model registry.

Adapters load lazily (importing one must not import torch or spawn anything)
and are kept as one instance per id, so a warm sidecar survives between
sessions until the shared idle reaper shuts it down.
"""
from __future__ import annotations

import importlib
import threading

from services.vc.base import VoiceConversionBackend

DEFAULT_ENGINE = "seed-vc"
ENGINE_ENV = "OMNIVOICE_VC_ENGINE"

#: id -> (module, class name).
_LAZY: dict[str, tuple[str, str]] = {
    "seed-vc": ("engines.seedvc_subprocess", "SeedVCBackend"),
}

_instances: dict[str, VoiceConversionBackend] = {}
_lock = threading.Lock()


def engine_ids() -> list[str]:
    return list(_LAZY)


def active_engine_id() -> str:
    import os

    requested = os.environ.get(ENGINE_ENV, "").strip()
    return requested if requested in _LAZY else DEFAULT_ENGINE


def backend_class(engine_id: str) -> type[VoiceConversionBackend]:
    try:
        module, name = _LAZY[engine_id]
    except KeyError:
        raise ValueError(f"unknown voice-conversion engine: {engine_id!r}") from None
    return getattr(importlib.import_module(module), name)


def get_backend(engine_id: str | None = None) -> VoiceConversionBackend:
    engine_id = engine_id or active_engine_id()
    with _lock:
        backend = _instances.get(engine_id)
        if backend is None:
            backend = backend_class(engine_id)()
            _instances[engine_id] = backend
        return backend


def reset() -> None:
    """Shut down and forget every instance (tests, engine uninstall)."""
    with _lock:
        backends = list(_instances.values())
        _instances.clear()
    for backend in backends:
        try:
            backend.shutdown()
        except Exception:  # noqa: BLE001
            pass
