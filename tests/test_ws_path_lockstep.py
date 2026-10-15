"""Every first-party WebSocket path is allowlisted in all seven places.

A WebSocket route the UI opens must be listed in the backend ticket allowlist
(``services/admin_sessions._ALLOWED_WS_PATHS``) and in each Electron layer
that resolves or type-checks the URL: the shared web-auth set, the renderer's
path type, the main-process IPC check and the supervisor/remote/preload
signatures. A path missing from any one fails silently in that build (#1769:
the live dub preview over /ws/tts). The shared set in authSession.ts is the
source list; this test holds the others to it.
"""
import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_SOURCE = _ROOT / "electron/src/shared/api/authSession.ts"
_MIRRORS = [
    "electron/src/renderer/src/lib/api/websocket.ts",
    "electron/src/main/ipc.ts",
    "electron/src/main/backend.ts",
    "electron/src/main/remote-backend.ts",
    "electron/src/preload/index.d.ts",
]


def _first_party_paths() -> list[str]:
    match = re.search(r"const ALLOWED_WS_PATHS = new Set\(\[([^\]]*)\]\)", _SOURCE.read_text(encoding="utf-8"))
    assert match, "ALLOWED_WS_PATHS moved; update this test"
    paths = re.findall(r"'(/[^']+)'", match.group(1))
    assert paths
    return paths


@pytest.mark.parametrize("path", _first_party_paths())
def test_backend_mints_tickets_for_every_first_party_path(path):
    from services.admin_sessions import _ALLOWED_WS_PATHS

    assert path in _ALLOWED_WS_PATHS


@pytest.mark.parametrize("mirror", _MIRRORS)
def test_every_electron_layer_lists_every_path(mirror):
    text = (_ROOT / mirror).read_text(encoding="utf-8")
    missing = [p for p in _first_party_paths() if f"'{p}'" not in text]
    assert not missing, f"{mirror} does not allow {missing}"


@pytest.mark.parametrize("path", _first_party_paths())
def test_every_first_party_path_is_a_live_route(path):
    from main import app

    assert path in {getattr(r, "path", None) for r in app.routes}
