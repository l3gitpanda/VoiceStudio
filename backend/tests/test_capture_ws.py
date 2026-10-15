"""Tests for the streaming ASR WebSocket helpers.

Only tests the pure-Python helper functions (no GPU needed).
The WebSocket endpoint itself requires the full app, which we
skip in CI — it's integration-tested via the browser.
"""
# conftest.py puts `backend/` on sys.path. capture_ws imports its heavy deps
# (model_manager / asr_backend / ffmpeg_utils) lazily inside handlers, so no
# stubbing is needed — the old empty-ModuleType stubs leaked process-wide at
# collection time and broke every later `from services.ffmpeg_utils import
# find_ffmpeg` in mixed runs (see conftest.py).
from api.routers.capture_ws import _chunks_to_wav, MIN_BUFFER_BYTES


class TestChunksToWav:
    def test_empty_returns_none(self):
        assert _chunks_to_wav([]) is None

    def test_tiny_returns_none(self):
        assert _chunks_to_wav([b"\x00" * 10]) is None

    def test_below_100_bytes_returns_none(self):
        assert _chunks_to_wav([b"\x00" * 99]) is None


class TestConstants:
    def test_min_buffer_bytes_reasonable(self):
        """MIN_BUFFER_BYTES should be at least 0.25s of 16-bit mono 16kHz."""
        # 16kHz * 2 bytes * 0.25s = 8000
        assert MIN_BUFFER_BYTES >= 8000

    def test_partial_interval_positive(self):
        from api.routers.capture_ws import PARTIAL_INTERVAL_S
        assert PARTIAL_INTERVAL_S > 0

    def test_silence_timeout_positive(self):
        from api.routers.capture_ws import SILENCE_TIMEOUT_S
        assert SILENCE_TIMEOUT_S > 0


class TestLoopbackGuard:
    """Guard against regressing the dictation WebSocket's handshake contract.

    Why: the /ws/transcribe socket streams the user's live microphone audio.
    Any process that could open it without a check could exfiltrate dictation
    in real time. The check is the ``require_ws_dictation`` route dependency
    (api.ws_guards), which FastAPI runs before the handler, so a refused peer
    never reaches ``accept()``. These tests need no app: they read the route
    declarations and call the guard directly. tests/test_ws_route_guards.py
    covers every WebSocket route end to end.
    """

    def _src(self):
        from pathlib import Path
        return (
            Path(__file__).resolve().parent.parent
            / "api" / "routers" / "capture_ws.py"
        ).read_text(encoding="utf-8")

    def test_both_dictation_routes_declare_the_guard(self):
        assert self._src().count("dependencies=[Depends(require_ws_dictation)]") == 2, (
            "capture_ws.py must declare require_ws_dictation on both "
            "@router.websocket routes (/ws/transcribe and the platform stream). "
            "Without it any device that reaches the backend can stream the "
            "user's microphone."
        )

    @staticmethod
    def _websocket(host, headers=()):
        from types import SimpleNamespace

        from starlette.websockets import WebSocket

        scope = {
            "type": "websocket",
            "path": "/ws/transcribe",
            "query_string": b"",
            "headers": [(k.encode(), v.encode()) for k, v in headers],
            "client": (host, 1),
            "app": SimpleNamespace(state=SimpleNamespace(network_share=None)),
        }
        return WebSocket(scope, receive=None, send=None)

    def _guard(self, websocket):
        import asyncio

        from api.ws_guards import require_ws_dictation

        asyncio.run(require_ws_dictation(websocket))

    def test_non_loopback_peer_is_closed_with_1008(self, monkeypatch):
        import pytest
        from fastapi import WebSocketException

        monkeypatch.delenv("OMNIVOICE_API_KEY", raising=False)
        monkeypatch.delenv("OMNIVOICE_TRUSTED_NETWORKS", raising=False)
        with pytest.raises(WebSocketException) as refused:
            self._guard(self._websocket("10.0.0.5"))
        assert refused.value.code == 1008
        assert refused.value.reason == "loopback origin required"

    def test_cross_site_browser_is_closed_with_1008(self):
        import pytest
        from fastapi import WebSocketException

        with pytest.raises(WebSocketException) as refused:
            self._guard(self._websocket("127.0.0.1", [("origin", "https://evil.example")]))
        assert refused.value.code == 1008

    def test_loopback_native_client_passes(self):
        self._guard(self._websocket("127.0.0.1"))
