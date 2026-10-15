"""Live Voice — real-time voice conversion over ``/ws/vc``.

Opt-in (``services.vc.gate``) and off by default. One session per backend.

Protocol (every frame from the client is treated as hostile):

    → text {"type": "start", "profile_id": str, block_ms?, crossfade_ms?,
            context_ms?, lookahead_ms?, steps?, cfg_rate?, max_prompt_s?,
            gate_db?}                        (≤ 4 KiB, unknown keys refused)
    ← text {"type": "status", "stage": "loading" | "preparing_voice"}
    ← text {"type": "ready", "sample_rate", "block_samples", "device",
            "algorithmic_latency_ms", "params", "voice", "warning"?}
    → binary  mono int16 LE PCM at ``sample_rate``, ≤ 1 s per frame
    ← binary  converted mono int16 LE PCM at ``sample_rate``
    ← text {"type": "stats", ...}            about once a second
    → text {"type": "reset"} | {"type": "stop"}
    ← text {"type": "error", "code", "detail"}  then close

Closes: 1000 stop, 1008 policy (origin, auth, disabled, consent, too fast),
1009 oversized frame, 1011 engine failure, 1013 busy.

Converted audio is sent as produced. Input is dropped oldest-first when the
model falls behind and output is dropped oldest-first when the client does,
so latency never grows; both are counted in ``stats``. The output is not
watermarked (owner decision for this fork; see docs/features/live-voice.md).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Literal, Optional

import numpy as np
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from api.dependencies import require_local
from api.ws_guards import admit_local_or_authorized
from services.vc import gate, registry
from services.vc import session as vc_session
from services.vc.base import CPU_PARAMS, LIMITS, VCError, VCStreamParams
from services.vc.targets import PROFILE_ID_RE, resolve_target

router = APIRouter()
logger = logging.getLogger("omnivoice.vc")

WS_PATH = "/ws/vc"
MAX_TEXT_BYTES = 4096
MAX_FRAME_SECONDS = 1.0
START_TIMEOUT_S = 30.0
STATS_INTERVAL_S = 1.0

_CLOSE = {
    "vc_disabled": 1008, "voice_consent_required": 1008, "too_fast": 1008,
    "bad_request": 1008, "voice_not_found": 1008, "voice_reference_missing": 1008,
    "vc_not_installed": 1008, "frame_too_large": 1009, "vc_busy": 1013,
    "engine_failed": 1011,
}


def _bounded(name: str, kind=int):
    low, high = LIMITS[name]
    return Field(None, ge=kind(low), le=kind(high))


class StartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    type: Literal["start"]
    profile_id: str = Field(..., pattern=PROFILE_ID_RE.pattern)
    block_ms: Optional[int] = _bounded("block_ms")
    crossfade_ms: Optional[int] = _bounded("crossfade_ms")
    context_ms: Optional[int] = _bounded("context_ms")
    lookahead_ms: Optional[int] = _bounded("lookahead_ms")
    steps: Optional[int] = _bounded("steps")
    cfg_rate: Optional[float] = _bounded("cfg_rate", float)
    max_prompt_s: Optional[float] = _bounded("max_prompt_s", float)
    gate_db: Optional[float] = _bounded("gate_db", float)

    def params(self, base: VCStreamParams) -> VCStreamParams:
        chosen = {k: v for k, v in self.model_dump().items() if k in LIMITS and v is not None}
        return VCStreamParams(**{**base.__dict__, **chosen}).clamped()

    def chose_quality(self) -> bool:
        return any(getattr(self, k) is not None for k in ("block_ms", "context_ms", "steps", "cfg_rate"))


# ── status ─────────────────────────────────────────────────────────────────


@router.get("/vc/status", dependencies=[Depends(require_local)])
def vc_status():
    """Whether Live Voice is on, installed and free, plus its parameter bounds."""
    from services import sidecar_install

    engine = registry.active_engine_id()
    try:
        available, reason = registry.backend_class(engine).is_available()
    except Exception:  # noqa: BLE001 — a broken engine reads as unavailable
        available, reason = False, "The voice changer engine could not be loaded."
    spec = sidecar_install.get_spec(engine)
    install_ok, install_reason = sidecar_install.host_support(spec) if spec else (False, "")
    return {
        "enabled": gate.realtime_vc_enabled(),
        "env_pinned": gate.env_pinned(),
        "engine": engine,
        "available": bool(available),
        "reason": "" if available else reason,
        "install_supported": bool(install_ok),
        "install_reason": "" if install_ok else install_reason,
        "busy": vc_session.busy(),
        "defaults": {"gpu": VCStreamParams().__dict__, "cpu": CPU_PARAMS.__dict__},
        "limits": {k: list(v) for k, v in LIMITS.items()},
    }


# ── WebSocket ──────────────────────────────────────────────────────────────


async def _send_error(ws: WebSocket, code: str, detail: str) -> None:
    try:
        await ws.send_text(json.dumps({"type": "error", "code": code, "detail": detail}))
        await ws.close(code=_CLOSE.get(code, 1011))
    except Exception:  # noqa: BLE001 — the client may already be gone
        pass


def _text_json(msg: dict) -> dict:
    text = msg.get("text")
    if text is None:
        raise VCError("bad_request", "Expected a JSON text frame.")
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise VCError("frame_too_large", "Control frame is too large.")
    try:
        data = json.loads(text)
    except ValueError:
        raise VCError("bad_request", "Control frame is not JSON.") from None
    if not isinstance(data, dict):
        raise VCError("bad_request", "Control frame must be a JSON object.")
    return data


async def _receive_start(ws: WebSocket) -> Optional[StartRequest]:
    try:
        msg = await asyncio.wait_for(ws.receive(), START_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise VCError("bad_request", "No start request received.") from None
    if msg.get("type") == "websocket.disconnect":
        return None
    try:
        return StartRequest.model_validate(_text_json(msg))
    except ValidationError:
        raise VCError("bad_request", "Invalid start request.") from None


def _pcm16_to_float(data: bytes, sample_rate: int) -> np.ndarray:
    if len(data) % 2:
        raise VCError("bad_request", "Audio frames must be 16-bit PCM.")
    if len(data) > int(MAX_FRAME_SECONDS * sample_rate) * 2:
        raise VCError("frame_too_large", "Audio frame is longer than one second.")
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


def _float_to_pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


async def _reader(ws: WebSocket, session: vc_session.VCSession, sample_rate: int) -> str:
    while True:
        msg = await ws.receive()
        if msg.get("type") == "websocket.disconnect":
            return "disconnect"
        data = msg.get("bytes")
        if data is not None:
            if data:
                session.feed(_pcm16_to_float(data, sample_rate))
            continue
        control = _text_json(msg).get("type")
        if control == "stop":
            return "stop"
        if control == "reset":
            session.request_reset()
        elif control != "ping":
            raise VCError("bad_request", "Unknown control message.")


async def _writer(ws: WebSocket, session: vc_session.VCSession) -> str:
    while True:
        out = await session.outbox.get()
        if out is None:
            err = session.error or VCError("engine_failed", "The voice changer stopped.")
            raise err
        await ws.send_bytes(_float_to_pcm16(out))


async def _stats(ws: WebSocket, session: vc_session.VCSession) -> str:
    while True:
        await asyncio.sleep(STATS_INTERVAL_S)
        await ws.send_text(json.dumps(session.stats()))


async def _pump(ws: WebSocket, session: vc_session.VCSession, sample_rate: int) -> str:
    tasks = [
        asyncio.ensure_future(_reader(ws, session, sample_rate)),
        asyncio.ensure_future(_writer(ws, session)),
        asyncio.ensure_future(_stats(ws, session)),
    ]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        return next(iter(done)).result()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def _prepare(backend, params: VCStreamParams, reference, quality_chosen: bool):
    backend.configure(params)
    target = backend.prepare(reference)
    if target.device == "cpu" and not quality_chosen:
        # No accelerator and no explicit quality: fall back to settings a CPU
        # can sustain, at the cost of latency (reported in the ready frame).
        cpu = VCStreamParams(**{**CPU_PARAMS.__dict__,
                                "crossfade_ms": params.crossfade_ms,
                                "lookahead_ms": params.lookahead_ms,
                                "gate_db": params.gate_db})
        backend.configure(cpu)
        if cpu.max_prompt_s != params.max_prompt_s:
            target = backend.prepare(reference)  # the prompt length changes its cost
    return target


@router.websocket(WS_PATH)
async def ws_vc(websocket: WebSocket):
    if not await admit_local_or_authorized(websocket):
        return
    await websocket.accept()
    owner = object()
    claimed = False
    preparing: Optional[asyncio.Future] = None
    session: Optional[vc_session.VCSession] = None
    try:
        if not gate.realtime_vc_enabled():
            raise VCError("vc_disabled", "Turn on Live Voice in Settings first.")
        start = await _receive_start(websocket)
        if start is None:
            return
        engine = registry.active_engine_id()
        available, _ = registry.backend_class(engine).is_available()
        if not available:
            raise VCError("vc_not_installed", "Install the voice changer engine first.")
        reference, voice_name = await asyncio.to_thread(resolve_target, start.profile_id)
        if not vc_session.claim(owner):
            raise VCError("vc_busy", "Live Voice is already running in another window.")
        claimed = True
        backend = registry.get_backend(engine)
        await websocket.send_text(json.dumps({"type": "status", "stage": "loading"}))
        preparing = asyncio.get_running_loop().run_in_executor(
            None, _prepare, backend, start.params(VCStreamParams()), reference, start.chose_quality()
        )
        # Shielded: a cancelled handler must not abandon a prepare that is
        # still using the engine; the slot is released once it finishes.
        target = await asyncio.shield(preparing)
        session = vc_session.VCSession(backend, asyncio.get_running_loop())
        session.start()
        ready = {
            "type": "ready",
            "engine": engine,
            "sample_rate": backend.sample_rate,
            "block_samples": backend.block_samples,
            "device": target.device,
            "algorithmic_latency_ms": round(backend.algorithmic_latency_ms, 1),
            "params": backend.params.__dict__,
            "voice": {"id": start.profile_id, "name": voice_name, "ref_seconds": target.ref_seconds},
        }
        if target.device == "cpu":
            ready["warning"] = "cpu_slow"
        await websocket.send_text(json.dumps(ready))
        how = await _pump(websocket, session, backend.sample_rate)
        if how == "stop":
            await websocket.send_text(json.dumps(session.stats()))
            await websocket.close(code=1000)
    except WebSocketDisconnect:
        pass
    except VCError as exc:
        await _send_error(websocket, exc.code, exc.detail)
    except Exception as exc:  # noqa: BLE001 — never leak a traceback to the client
        logger.exception("live voice session failed")
        await _send_error(websocket, "engine_failed", type(exc).__name__)
    finally:
        # No awaits here: a cancelled handler would skip them and leak the
        # one-per-process slot. Release happens when the engine is idle.
        release = lambda *_: vc_session.release(owner)  # noqa: E731
        if session is not None:
            session.close(release)
        elif preparing is not None and not preparing.done():
            preparing.add_done_callback(release)
        elif claimed:
            release()
