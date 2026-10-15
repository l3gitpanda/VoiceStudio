"""seed-vc: Seed-VC real-time voice conversion from its own venv (Live Voice).

Seed-VC (Plachtaa/seed-vc, ``seed-uvit-tat-xlsr-tiny``) converts a live
microphone stream into a target voice from a 1-30 s reference, zero-shot.
Its code and weights are GPL-3.0, so nothing of it is vendored here: the
one-click installer (``services.sidecar_install.SPECS["seed-vc"]``) checks
out a reviewed commit into ``DATA_DIR/engines/seed-vc/`` with a venv of its
own, and this module runs the model there in a sidecar.

The split of work:

* parent (this module + ``services.vc``): block framing, look-ahead, SOLA
  crossfade, reference decoding, queues and the WebSocket;
* sidecar (``main.py``): load the model, compute the target voice, convert
  one window per ``vc_infer`` request.

So another window-based converter can replace Seed-VC by implementing the
same three sidecar ops; nothing else changes.
"""
from __future__ import annotations

import base64
import logging
import math
import os
import time
from pathlib import Path

import numpy as np

from services.subprocess_backend import PARENT_INBOUND_OPS, SubprocessBackend
from services.vc.base import (
    StreamingVCBackend,
    VCError,
    VCReference,
    VCTarget,
)

logger = logging.getLogger("omnivoice.vc.seedvc")

VENV_ENV_VAR = "OMNIVOICE_SEEDVC_DIR"
SAMPLE_RATE = 22_050
#: Converting one window must finish well inside this, or the GPU is wedged.
INFER_TIMEOUT_S = 30.0


def own_venv_python() -> "Path | None":
    """The venv the one-click installer made for Seed-VC, if any."""
    from services.sidecar_install import engine_venv_python

    return engine_venv_python(VENV_ENV_VAR)


def cache_dir() -> Path:
    from core.config import DATA_DIR

    return Path(DATA_DIR) / "vc_cache" / "seed-vc"


def _env_seconds(name: str, default: float, floor: float) -> float:
    try:
        value = float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default
    return max(floor, value) if math.isfinite(value) else default


class SeedVCSidecar(SubprocessBackend):
    """Process lifecycle and framing for the Seed-VC sidecar.

    Reuses ``SubprocessBackend`` for spawn, containment, the ready handshake,
    the receive watchdog, stderr scrubbing and the idle reaper. It is not a
    TTS engine and is never registered as one; ``request`` replaces
    ``generate`` and does not take a GPU-pool slot, so a live session never
    queues behind a text-to-speech job.
    """

    id = "seed-vc"
    display_name = "Seed-VC (live voice changer)"
    gpu_compat = ("cuda", "mps", "cpu")
    parent_inbound_ops = PARENT_INBOUND_OPS | {"vc_prepared", "vc_audio"}
    spawn_ready_timeout_s = 60.0
    _DEFAULT_SAMPLE_RATE = SAMPLE_RATE

    @property
    def recv_timeout_s(self) -> float:
        # The first prepare downloads ~1.5 GB of weights; progress frames
        # re-arm this deadline while it runs.
        return _env_seconds("OMNIVOICE_SEEDVC_RECV_TIMEOUT_S", 900.0, 30.0)

    @property
    def sample_rate(self) -> int:
        return SAMPLE_RATE

    @property
    def supported_languages(self) -> list[str]:
        return []

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        if own_venv_python() is None:
            return False, "Seed-VC is not installed. Install it from Live Voice."
        return True, "ready"

    @classmethod
    def venv_python(cls) -> Path:
        py = own_venv_python()
        if py is None:
            raise RuntimeError("Seed-VC's environment is missing. Reinstall it from Live Voice.")
        return py

    @classmethod
    def sidecar_script(cls) -> Path:
        return Path(__file__).resolve().parent / "main.py"

    def request(self, msg: dict, *, timeout_s: float, respawn: bool = True) -> dict:
        """Send one request and return its terminal reply (progress frames
        are skipped; each re-arms the deadline). Raises ``VCError``.

        ``respawn=False`` refuses to start a new process: the prepared target
        voice lives in the one that answered ``vc_prepare``, and a fresh one
        would convert against nothing."""
        with self._lock:
            if not respawn and (self._proc is None or self._proc.poll() is not None):
                raise VCError("engine_failed", "The voice changer engine stopped. Start Live Voice again.")
            try:
                self._spawn()
            except Exception as exc:  # noqa: BLE001
                raise VCError("engine_failed", _first_line(exc)) from exc
            proc = self._proc
            started = time.monotonic()
            try:
                self._send(msg)
                reply = self._recv_with_timeout(timeout_s)
                while reply is not None and reply.get("op") == "progress":
                    reply = self._recv_with_timeout(timeout_s)
            except (RuntimeError, OSError) as exc:
                self._reap_unusable_process(proc)
                raise VCError("engine_failed", _first_line(exc)) from exc
            if not reply:
                reason = self._generate_failure_reason(time.monotonic() - started, timeout_s)
                self._reap_unusable_process(proc)
                raise VCError("engine_failed", reason)
        if reply.get("op") == "error":
            stage = str(reply.get("stage") or "unknown")
            message = str(reply.get("message") or "unknown sidecar error")
            trace = str(reply.get("traceback") or "").strip()
            logger.error("[seed-vc] sidecar %s error: %s%s", stage, message,
                         f"\n{trace[:20_000]}" if trace else "")
            raise VCError("engine_failed", f"Seed-VC {stage} error: {message}"[:300])
        if "vram_mb" in reply:
            try:
                self._vram_mb = float(reply["vram_mb"] or 0)
            except (TypeError, ValueError):
                pass
        return reply


def _first_line(exc: BaseException) -> str:
    from core.scrub import scrub_text

    text = str(exc).strip()
    return scrub_text(text.splitlines()[0] if text else type(exc).__name__)[:300]


def _encode(pcm: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(pcm, dtype="<f4").tobytes()).decode("ascii")


class SeedVCBackend(StreamingVCBackend):
    """Seed-VC behind :class:`StreamingVCBackend`."""

    id = "seed-vc"
    display_name = "Seed-VC"
    transport_cls: type[SeedVCSidecar] = SeedVCSidecar

    def __init__(self, transport: "SeedVCSidecar | None" = None) -> None:
        self._transport = transport or self.transport_cls()
        self._device = "cpu"
        super().__init__()

    @property
    def sample_rate(self) -> int:
        return SAMPLE_RATE

    @property
    def device(self) -> str:
        return self._device

    @property
    def vram_mb(self) -> float:
        return float(getattr(self._transport, "_vram_mb", 0.0) or 0.0)

    @classmethod
    def is_available(cls) -> tuple[bool, str]:
        return cls.transport_cls.is_available()

    def prepare(self, reference: VCReference) -> VCTarget:
        from services.vc.targets import load_reference_pcm

        prompt = load_reference_pcm(reference, SAMPLE_RATE, self.params.max_prompt_s)
        cache = cache_dir()
        cache.mkdir(parents=True, exist_ok=True)
        reply = self._transport.request(
            {
                "op": "vc_prepare",
                "prompt_b64": _encode(prompt),
                "cache_dir": str(cache),
                "cache_key": f"{reference.cache_key}-{int(self.params.max_prompt_s * 1000)}",
            },
            timeout_s=self._transport.recv_timeout_s,
        )
        if reply.get("op") != "vc_prepared":
            raise VCError("engine_failed", "Seed-VC returned an unexpected reply.")
        self._device = str(reply.get("device") or "cpu")
        self.reset()
        return VCTarget(
            cache_key=reference.cache_key,
            ref_seconds=round(prompt.shape[0] / SAMPLE_RATE, 2),
            cached=bool(reply.get("cached")),
            device=self._device,
        )

    def infer_window(self, window, *, head_samples, out_samples, tail_samples):
        reply = self._transport.request(
            {
                "op": "vc_infer",
                "pcm_b64": _encode(window),
                "head_samples": int(head_samples),
                "out_samples": int(out_samples),
                "tail_samples": int(tail_samples),
                "steps": int(self.params.steps),
                "cfg_rate": float(self.params.cfg_rate),
            },
            timeout_s=_env_seconds("OMNIVOICE_SEEDVC_INFER_TIMEOUT_S", INFER_TIMEOUT_S, 2.0),
            respawn=False,
        )
        if reply.get("op") != "vc_audio":
            raise VCError("engine_failed", "Seed-VC returned an unexpected reply.")
        pcm = np.frombuffer(base64.b64decode(reply.get("pcm_b64", "")), dtype="<f4")
        if pcm.shape[0] != out_samples or not np.isfinite(pcm).all():
            raise VCError("engine_failed", "Seed-VC returned malformed audio.")
        return pcm.astype(np.float32)

    def shutdown(self) -> None:
        self._transport.shutdown()


__all__ = ["SAMPLE_RATE", "SeedVCBackend", "SeedVCSidecar", "VENV_ENV_VAR", "cache_dir", "own_venv_python"]
