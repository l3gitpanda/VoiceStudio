"""/ws/vc — the Live Voice WebSocket.

Engine replaced by an in-process identity converter (no sidecar, no GPU);
one end-to-end test runs the real Seed-VC adapter against the echo sidecar.
Covers: opt-in gate, handshake guard (origin, non-loopback), start-schema
validation, consent, busy slot, binary framing limits, the converted round
trip, stop/cancel releasing the slot, CPU fallback, status and settings.
"""
import json
import sys
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from services.vc.base import StreamingVCBackend, VCTarget

SR = 22_050


class _Identity(StreamingVCBackend):
    id = "fake-vc"
    device_name = "cuda"
    delay_s = 0.0

    @property
    def sample_rate(self):
        return SR

    @classmethod
    def is_available(cls):
        return True, "ready"

    def prepare(self, reference):
        assert Path(reference.path).is_file()
        return VCTarget(cache_key=reference.cache_key, ref_seconds=1.0, cached=False,
                        device=self.device_name)

    def infer_window(self, window, *, head_samples, out_samples, tail_samples):
        time.sleep(self.delay_s)
        return window[head_samples:head_samples + out_samples].copy()


@pytest.fixture()
def vc():
    """The VC modules the running app actually reads. Other suites purge and
    re-import backend packages, so a module bound at collection time can be a
    stale twin: patching it would leave the router on the real engine."""
    from main import app

    route = next(r for r in app.router.routes if getattr(r, "path", "") == "/ws/vc")
    live = route.endpoint.__globals__
    return SimpleNamespace(registry=live["registry"], session=live["vc_session"],
                           CPU_PARAMS=live["CPU_PARAMS"])


@pytest.fixture()
def fake_engine(monkeypatch, vc):
    backend = _Identity()
    monkeypatch.setattr(vc.registry, "backend_class", lambda engine_id: _Identity)
    monkeypatch.setattr(vc.registry, "get_backend", lambda engine_id=None: backend)
    monkeypatch.setenv("OMNIVOICE_REALTIME_VC", "1")
    yield backend
    assert not vc.session.busy(), "a session leaked the one-per-process slot"


@pytest.fixture(autouse=True)
def _db():
    from core.db import init_db

    init_db()


@pytest.fixture()
def client():
    from main import app

    return TestClient(app, client=("127.0.0.1", 50000))


def _profile(kind="clone", verified=1, with_audio=True):
    from core.config import VOICES_DIR
    from core.db import db_conn

    pid = uuid.uuid4().hex[:12]
    name = f"{pid}.wav" if with_audio else ""
    if with_audio:
        Path(VOICES_DIR).mkdir(parents=True, exist_ok=True)
        t = np.arange(SR * 2) / SR
        sf.write(Path(VOICES_DIR) / name, (0.3 * np.sin(2 * np.pi * 200 * t)).astype(np.float32), SR)
    with db_conn() as conn:
        conn.execute(
            "INSERT INTO voice_profiles (id, name, kind, verified_own_voice, ref_audio_path, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (pid, "Me", kind, verified, name, time.time()),
        )
    return pid


def _error(ws):
    frame = ws.receive_json()
    assert frame["type"] == "error", frame
    with pytest.raises(WebSocketDisconnect) as closed:
        ws.receive_text()
    return frame["code"], closed.value.code


def _start(ws, pid, **extra):
    ws.send_text(json.dumps({"type": "start", "profile_id": pid, "gate_db": -90.0, **extra}))
    assert ws.receive_json() == {"type": "status", "stage": "loading"}
    ready = ws.receive_json()
    assert ready["type"] == "ready", ready
    return ready


def _pcm(samples):
    return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()


def test_off_by_default(client, monkeypatch):
    monkeypatch.delenv("OMNIVOICE_REALTIME_VC", raising=False)
    with client.websocket_connect("/ws/vc") as ws:
        assert _error(ws) == ("vc_disabled", 1008)


def test_cross_site_origin_is_refused_before_accept(client, fake_engine):
    with pytest.raises(WebSocketDisconnect) as closed:
        with client.websocket_connect("/ws/vc", headers={"origin": "https://evil.example"}):
            pass
    assert closed.value.code == 1008


def test_non_loopback_clients_need_a_credential(fake_engine):
    from main import app

    lan = TestClient(app, client=("192.168.1.50", 50000))
    with pytest.raises(WebSocketDisconnect) as closed:
        with lan.websocket_connect("/ws/vc"):
            pass
    assert closed.value.code == 1008


@pytest.mark.parametrize("start", [
    "not json",
    json.dumps([1, 2]),
    json.dumps({"type": "start"}),
    json.dumps({"type": "start", "profile_id": "../../etc"}),
    json.dumps({"type": "start", "profile_id": "abc", "block_ms": 5}),
    json.dumps({"type": "start", "profile_id": "abc", "steps": "10"}),
    json.dumps({"type": "start", "profile_id": "abc", "evil": 1}),
    json.dumps({"type": "start", "profile_id": "abc", "pad": "x" * 5000}),
])
def test_hostile_start_requests_are_refused(client, fake_engine, start):
    with client.websocket_connect("/ws/vc") as ws:
        ws.send_text(start)
        code, close = _error(ws)
    assert code in ("bad_request", "frame_too_large") and close in (1008, 1009)


def test_unknown_voice(client, fake_engine):
    with client.websocket_connect("/ws/vc") as ws:
        ws.send_text(json.dumps({"type": "start", "profile_id": "nosuchvoice"}))
        assert _error(ws) == ("voice_not_found", 1008)


def test_unverified_clone_needs_consent(client, fake_engine):
    pid = _profile(kind="clone", verified=0)
    with client.websocket_connect("/ws/vc") as ws:
        ws.send_text(json.dumps({"type": "start", "profile_id": pid}))
        assert _error(ws) == ("voice_consent_required", 1008)


def test_profile_without_reference_audio(client, fake_engine):
    pid = _profile(kind="clone", verified=1, with_audio=False)
    with client.websocket_connect("/ws/vc") as ws:
        ws.send_text(json.dumps({"type": "start", "profile_id": pid}))
        assert _error(ws) == ("voice_reference_missing", 1008)


def test_engine_not_installed(client, fake_engine, monkeypatch, vc):
    class _Missing(_Identity):
        @classmethod
        def is_available(cls):
            return False, "not installed"

    monkeypatch.setattr(vc.registry, "backend_class", lambda engine_id: _Missing)
    with client.websocket_connect("/ws/vc") as ws:
        ws.send_text(json.dumps({"type": "start", "profile_id": _profile()}))
        assert _error(ws) == ("vc_not_installed", 1008)


@pytest.mark.parametrize("kind,verified", [("clone", 1), ("design", 0)])
def test_round_trip_converts_and_stop_closes_cleanly(client, fake_engine, kind, verified):
    pid = _profile(kind=kind, verified=verified)
    with client.websocket_connect("/ws/vc") as ws:
        ready = _start(ws, pid, block_ms=200)
        assert ready["sample_rate"] == SR and ready["device"] == "cuda" and "warning" not in ready
        assert ready["voice"] == {"id": pid, "name": "Me", "ref_seconds": 1.0}
        block = ready["block_samples"]
        x = (0.25 * np.sin(np.arange(block * 4) / 5.0)).astype(np.float32)
        for i in range(4):
            ws.send_bytes(_pcm(x[i * block:(i + 1) * block]))
        received = b""
        while len(received) < block * 4 * 2:
            msg = ws.receive()
            if msg.get("bytes"):
                received += msg["bytes"]
        out = np.frombuffer(received, "<i2").astype(np.float32) / 32768.0
        s = fake_engine.streamer
        delay = s.crossfade + s.search + s.tail_samples
        expected = np.concatenate([np.zeros(delay, np.float32), x])[: out.size]
        np.testing.assert_allclose(out, expected, atol=2e-4)
        ws.send_text(json.dumps({"type": "stop"}))
        while True:
            frame = ws.receive()
            if frame.get("text") and json.loads(frame["text"])["type"] == "stats":
                break
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == 1000


def test_cancel_by_closing_releases_the_slot(client, fake_engine, vc):
    pid = _profile()
    with client.websocket_connect("/ws/vc") as ws:
        ready = _start(ws, pid)
        ws.send_bytes(_pcm(np.zeros(ready["block_samples"], np.float32)))
    deadline = time.monotonic() + 5
    while vc.session.busy() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not vc.session.busy()


def test_a_cancelled_handler_keeps_its_own_cancellation():
    """Exiting mid-stream cancels the handler (server shutdown, the test
    client's teardown) while it is still unwinding its pump. The handler must
    surface the canceller's CancelledError, not a child's: anyio recognises
    its own cancel by the message and treats anything else as foreign."""
    import asyncio

    from api.routers import vc_stream

    class _Ws:
        async def receive(self):
            return {"type": "websocket.disconnect"}

    class _SlowToCancel:
        async def get(self):
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await asyncio.sleep(0.2)  # still unwinding when the handler is cancelled
                raise

    session = SimpleNamespace(outbox=_SlowToCancel(), error=None, stats=dict)
    seen = []

    async def handler():
        try:
            await vc_stream._pump(_Ws(), session, SR)
        except asyncio.CancelledError as exc:
            seen.append(exc.args)
            raise

    async def main():
        task = asyncio.ensure_future(handler())
        await asyncio.sleep(0.05)
        task.cancel("Cancelled via cancel scope test")
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    assert seen == [("Cancelled via cancel scope test",)]


def test_second_session_is_busy(client, fake_engine, vc):
    holder = object()
    assert vc.session.claim(holder)
    try:
        with client.websocket_connect("/ws/vc") as ws:
            ws.send_text(json.dumps({"type": "start", "profile_id": _profile()}))
            assert _error(ws) == ("vc_busy", 1013)
    finally:
        vc.session.release(holder)


@pytest.mark.parametrize("frame,code,close", [
    (b"\x00\x01\x02", "bad_request", 1008),
    (b"\x00\x00" * (SR + 1), "frame_too_large", 1009),
])
def test_binary_frames_are_bounded(client, fake_engine, frame, code, close):
    with client.websocket_connect("/ws/vc") as ws:
        _start(ws, _profile())
        ws.send_bytes(frame)
        while True:
            msg = ws.receive_json()
            if msg["type"] == "error":
                break
        assert msg["code"] == code
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
        assert closed.value.code == close


def test_unknown_control_messages_are_refused(client, fake_engine):
    with client.websocket_connect("/ws/vc") as ws:
        _start(ws, _profile())
        ws.send_text(json.dumps({"type": "launch_missiles"}))
        msg = ws.receive_json()
        while msg["type"] == "stats":
            msg = ws.receive_json()
        assert msg["code"] == "bad_request"


def test_cpu_host_falls_back_to_cpu_settings_with_a_warning(client, fake_engine, vc):
    fake_engine.device_name = "cpu"
    with client.websocket_connect("/ws/vc") as ws:
        ready = _start(ws, _profile())
        ws.send_text(json.dumps({"type": "stop"}))
    assert ready["warning"] == "cpu_slow"
    assert ready["params"]["block_ms"] == vc.CPU_PARAMS.block_ms
    assert ready["params"]["steps"] == vc.CPU_PARAMS.steps


def test_explicit_quality_is_honoured_on_cpu(client, fake_engine):
    fake_engine.device_name = "cpu"
    with client.websocket_connect("/ws/vc") as ws:
        ready = _start(ws, _profile(), block_ms=240, steps=6)
        ws.send_text(json.dumps({"type": "stop"}))
    assert ready["params"]["block_ms"] == 240 and ready["params"]["steps"] == 6


def test_end_to_end_with_the_echo_sidecar(client, monkeypatch, tmp_path, vc):
    """The real Seed-VC adapter, its sidecar transport and the WebSocket,
    with the stdlib echo sidecar as an identity model."""
    from engines import seedvc_subprocess as adapter

    class _Echo(adapter.SeedVCSidecar):
        @classmethod
        def is_available(cls):
            return True, "ready"

        @classmethod
        def venv_python(cls):
            return Path(sys.executable)

        @classmethod
        def sidecar_script(cls):
            return Path(adapter.__file__).resolve().parents[1] / "_echo" / "main.py"

    class _EchoBackend(adapter.SeedVCBackend):
        transport_cls = _Echo

    backend = _EchoBackend()
    monkeypatch.setattr(adapter, "cache_dir", lambda: tmp_path)
    monkeypatch.setattr(vc.registry, "backend_class", lambda engine_id: _EchoBackend)
    monkeypatch.setattr(vc.registry, "get_backend", lambda engine_id=None: backend)
    monkeypatch.setenv("OMNIVOICE_REALTIME_VC", "1")
    try:
        with client.websocket_connect("/ws/vc") as ws:
            ready = _start(ws, _profile(), block_ms=180, steps=4)
            assert ready["device"] == "cpu"
            block = ready["block_samples"]
            ws.send_bytes(_pcm(np.full(block * 2, 0.2, np.float32)))
            got = b""
            while len(got) < block * 2 * 2:
                msg = ws.receive()
                if msg.get("bytes"):
                    got += msg["bytes"]
            assert len(got) == block * 2 * 2
            ws.send_text(json.dumps({"type": "stop"}))
    finally:
        backend.shutdown()


def test_status_reports_gate_install_and_limits(client, monkeypatch):
    monkeypatch.delenv("OMNIVOICE_REALTIME_VC", raising=False)
    body = client.get("/vc/status").json()
    assert body["enabled"] is False and body["engine"] == "seed-vc"
    assert body["available"] is False and body["reason"]
    assert set(body["limits"]) >= {"block_ms", "steps", "gate_db"}
    assert body["defaults"]["cpu"]["block_ms"] > body["defaults"]["gpu"]["block_ms"]


def test_settings_toggle_persists_and_env_pins(client, monkeypatch):
    monkeypatch.delenv("OMNIVOICE_REALTIME_VC", raising=False)
    assert client.get("/api/settings/realtime-vc").json() == {"enabled": False, "env_pinned": False}
    assert client.put("/api/settings/realtime-vc", json={"enabled": True}).json()["enabled"] is True
    assert client.get("/vc/status").json()["enabled"] is True
    client.put("/api/settings/realtime-vc", json={"enabled": False})
    monkeypatch.setenv("OMNIVOICE_REALTIME_VC", "1")
    assert client.get("/api/settings/realtime-vc").json() == {"enabled": True, "env_pinned": True}
