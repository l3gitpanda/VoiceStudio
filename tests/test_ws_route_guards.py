"""Every WebSocket route authorises its own handshake (api.ws_guards).

The share-PIN gate (``NetworkAccessMiddleware``) only covers HTTP, and the
API-key gate (``BearerKeyMiddleware``) is inert unless ``OMNIVOICE_API_KEY`` is
set. With LAN sharing on, ``/ws/tts`` and ``/ws/events`` accepted a handshake
from a LAN peer presenting no PIN, key or admin session, which let that peer
synthesize speech in any saved voice and read the app's event stream. Only
``/ws/transcribe`` carried an inline guard.

These tests pin:

1. Behaviour. An anonymous LAN peer is refused on every WebSocket route. The
   clients that should connect still do: loopback, a trusted network, the
   share PIN (consumption streams only, never dictation), the API key and a
   ``ws_ticket``. Bare server mode keeps its open consumption policy, the same
   policy the HTTP ``require_consumer`` gate applies.
2. Structure. Every WebSocket route the app serves runs one of the shared
   guards, or sits in a justified allowlist. A new route cannot ship without
   one.
"""
import os

os.environ.setdefault("OMNIVOICE_MODEL", "test")
os.environ.setdefault("OMNIVOICE_DISABLE_FILE_LOG", "1")

import pytest
from starlette.websockets import WebSocketDisconnect

PIN = "246810"
KEY = "s3cret-key"
LAN_PEER = ("192.168.1.50", 50000)
LOOPBACK = ("127.0.0.1", 1)
#: The share listener as a LAN peer addresses it. An IP literal ``Host`` passes
#: the DNS-rebinding check, so the route guard is what decides. (Starlette's
#: ``websocket_connect`` ignores ``base_url``; every URL here is absolute.)
SHARE_HOST = "192.168.1.10:3901"
SHARE_ORIGIN = f"http://{SHARE_HOST}"
#: Close reasons the route guards send. Asserting them proves a refusal came
#: from the route, not from a middleware or the startup gate.
CONSUMER_REFUSAL = "authentication required"
DICTATION_REFUSAL = "loopback origin required"
CONSUMER_ROUTES = ("/ws/tts", "/ws/events")
DICTATION_ROUTES = ("/ws/transcribe", "/v1/audio/transcriptions/stream")


@pytest.fixture(autouse=True)
def _clean_auth(monkeypatch):
    from main import app
    from services import network_share
    from services.admin_sessions import admin_session_store

    for name in (
        "OMNIVOICE_API_KEY",
        "OMNIVOICE_SERVER_MODE",
        "OMNIVOICE_TRUSTED_NETWORKS",
        "OMNIVOICE_ALLOWED_ORIGINS",
    ):
        monkeypatch.delenv(name, raising=False)
    admin_session_store.clear()
    app.state.network_share = network_share.ShareState()
    yield
    app.state.network_share = network_share.ShareState()
    admin_session_store.clear()


@pytest.fixture
def lan_share():
    """LAN sharing on: the share listener is up and a PIN is set."""
    from main import app
    from services import network_share

    app.state.network_share = network_share.ShareState(
        enabled=True, share_port=3901, pin=PIN, lan_addresses=["192.168.1.10"]
    )


def _client(client=LAN_PEER):
    from fastapi.testclient import TestClient
    from main import app

    return TestClient(app, client=client)


def _url(path, host=SHARE_HOST):
    return f"ws://{host}{path}"


def _refusal(client, path, host=SHARE_HOST, **kwargs) -> WebSocketDisconnect | None:
    """The handshake's close, or None when the route accepted it."""
    try:
        with client.websocket_connect(_url(path, host), **kwargs):
            return None
    except WebSocketDisconnect as exc:
        return exc


def _assert_refused(client, path, reason=None, **kwargs) -> None:
    refusal = _refusal(client, path, **kwargs)
    assert refusal is not None, f"{path} accepted a handshake it must refuse"
    assert refusal.code == 1008
    if reason is not None:
        assert refusal.reason == reason, f"{path} was refused by another layer"


def _assert_accepted(client, path, host=SHARE_HOST, **kwargs) -> None:
    if path.startswith("/ws/tts"):
        # An empty request gets the handler's own error frame, which proves
        # the handshake reached the route body.
        with client.websocket_connect(_url(path, host), **kwargs) as ws:
            ws.send_json({})
            assert ws.receive_json()["type"] == "error"
        return
    refusal = _refusal(client, path, host, **kwargs)
    assert refusal is None, (
        f"{path} refused an authorised client: {refusal.code} {refusal.reason!r}"
    )


def _guard_reason(path):
    return CONSUMER_REFUSAL if path in CONSUMER_ROUTES else DICTATION_REFUSAL


# ── 1. Behaviour ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("path", CONSUMER_ROUTES + DICTATION_ROUTES)
def test_lan_peer_without_credentials_is_refused(lan_share, path):
    _assert_refused(_client(), path, _guard_reason(path))


@pytest.mark.parametrize("path", CONSUMER_ROUTES)
def test_lan_peer_without_credentials_is_refused_without_a_pin(path):
    # A desktop backend bound beyond loopback with no PIN or key configured
    # still keeps its consumption streams to local and authenticated clients.
    _assert_refused(_client(), path, CONSUMER_REFUSAL)


@pytest.mark.parametrize("path", CONSUMER_ROUTES)
def test_wrong_pin_is_refused(lan_share, path):
    _assert_refused(_client(), path, CONSUMER_REFUSAL, headers={"X-OmniVoice-Pin": "000000"})


@pytest.mark.parametrize("path", CONSUMER_ROUTES)
def test_loopback_still_connects(lan_share, path):
    _assert_accepted(_client(client=LOOPBACK), path, host="127.0.0.1:3900")


@pytest.mark.parametrize("path", CONSUMER_ROUTES)
def test_trusted_network_still_connects(lan_share, monkeypatch, path):
    monkeypatch.setenv("OMNIVOICE_TRUSTED_NETWORKS", "192.168.1.0/24")
    _assert_accepted(_client(), path)


@pytest.mark.parametrize("path", CONSUMER_ROUTES)
@pytest.mark.parametrize("transport", ["header", "cookie", "query"])
def test_share_pin_guest_still_connects_to_consumer_streams(lan_share, path, transport):
    client = _client()
    kwargs = {"headers": {"Origin": SHARE_ORIGIN}}
    if transport == "header":
        kwargs["headers"]["X-OmniVoice-Pin"] = PIN
    elif transport == "cookie":
        # The PIN gate sets ``ov_pin`` on the guest's first HTTP request; the
        # browser then sends it on the same-site WebSocket handshake.
        client.cookies.set("ov_pin", PIN)
    else:
        path = f"{path}?pin={PIN}"
    _assert_accepted(client, path, **kwargs)


@pytest.mark.parametrize("path", DICTATION_ROUTES)
def test_share_pin_does_not_authorise_dictation(lan_share, path):
    _assert_refused(_client(), path, DICTATION_REFUSAL, headers={"X-OmniVoice-Pin": PIN})


@pytest.mark.parametrize("path", CONSUMER_ROUTES)
def test_api_key_client_still_connects(lan_share, monkeypatch, path):
    monkeypatch.setenv("OMNIVOICE_API_KEY", KEY)
    _assert_accepted(_client(), f"{path}?api_key={KEY}")
    _assert_accepted(_client(), path, headers={"Authorization": f"Bearer {KEY}"})


@pytest.mark.parametrize("path", CONSUMER_ROUTES)
def test_ws_ticket_client_still_connects(lan_share, monkeypatch, path):
    from services.admin_sessions import admin_session_store

    monkeypatch.setenv("OMNIVOICE_API_KEY", KEY)
    session = admin_session_store.issue(KEY)
    ticket = admin_session_store.issue_ws_ticket(session.token, path, KEY).token
    _assert_accepted(_client(), f"{path}?ws_ticket={ticket}", headers={"Origin": SHARE_ORIGIN})


@pytest.mark.parametrize("path", CONSUMER_ROUTES)
def test_cross_site_origin_is_refused_even_with_a_credential(lan_share, path):
    _assert_refused(
        _client(),
        path,
        headers={"Origin": "https://evil.example", "X-OmniVoice-Pin": PIN},
    )


@pytest.mark.parametrize("path", CONSUMER_ROUTES)
def test_bare_server_mode_keeps_its_open_consumption_policy(monkeypatch, path):
    # Docker without a key or PIN: the operator's port mapping is the boundary,
    # exactly as for the HTTP API (require_consumer).
    monkeypatch.setenv("OMNIVOICE_SERVER_MODE", "1")
    _assert_accepted(_client(client=("172.17.0.1", 1)), path, host="127.0.0.1:3900")


@pytest.mark.parametrize("path", CONSUMER_ROUTES)
def test_server_mode_with_a_pin_refuses_anonymous_peers(lan_share, monkeypatch, path):
    monkeypatch.setenv("OMNIVOICE_SERVER_MODE", "1")
    _assert_refused(_client(), path, CONSUMER_REFUSAL)
    _assert_accepted(_client(), path, headers={"X-OmniVoice-Pin": PIN})


@pytest.mark.parametrize("path", CONSUMER_ROUTES)
def test_bare_server_mode_refuses_an_invalid_credential(monkeypatch, path):
    # An explicit credential is authoritative: a wrong one never falls back
    # to the open policy (same rule as the HTTP gate).
    monkeypatch.setenv("OMNIVOICE_SERVER_MODE", "1")
    _assert_refused(_client(), f"{path}?api_key=wrong", CONSUMER_REFUSAL)


# ── 2. Structure ─────────────────────────────────────────────────────────

#: WebSocket routes on the main app that legitimately skip the shared guards.
#: Every entry needs a justification; ``test_ws_guard_allowlist_is_not_stale``
#: keeps the list honest. (The Twilio media stream is not here: it lives on
#: the telephony gateway's own ASGI app, never on ``main.app``, and
#: authenticates with Twilio's request signature.)
_UNGUARDED_ALLOWED: dict[str, str] = {}


def _websocket_routes(routes, prefix=""):
    """(path, route) for every WebSocket route, descending into mounts."""
    from starlette.routing import Mount, WebSocketRoute

    for route in routes:
        if isinstance(route, WebSocketRoute):
            yield prefix + route.path, route
        elif isinstance(route, Mount) and getattr(route, "routes", None):
            yield from _websocket_routes(route.routes, prefix + route.path)


def _guard_of(route):
    from api import ws_guards

    dependant = getattr(route, "dependant", None)
    stack = list(dependant.dependencies) if dependant is not None else []
    while stack:
        dep = stack.pop()
        if dep.call in ws_guards.WEBSOCKET_GUARDS:
            return dep.call
        stack.extend(dep.dependencies)
    return None


def test_every_websocket_route_runs_a_shared_guard():
    from main import app

    routes = list(_websocket_routes(app.routes))
    assert routes, "no WebSocket routes found; the walk is broken"
    unguarded = sorted(
        path for path, route in routes
        if _guard_of(route) is None and path not in _UNGUARDED_ALLOWED
    )
    assert unguarded == [], (
        "WebSocket route(s) without a handshake guard. Add "
        "dependencies=[Depends(require_ws_consumer)] (or require_ws_dictation) "
        f"from api.ws_guards: {unguarded}"
    )


def test_known_routes_keep_their_guard_tier():
    from api.ws_guards import require_ws_consumer, require_ws_dictation
    from main import app

    guards = {path: _guard_of(route) for path, route in _websocket_routes(app.routes)}
    for path in CONSUMER_ROUTES:
        assert guards[path] is require_ws_consumer, path
    for path in DICTATION_ROUTES:
        assert guards[path] is require_ws_dictation, path


def test_ws_guard_allowlist_is_not_stale():
    from main import app

    paths = {path for path, _route in _websocket_routes(app.routes)}
    assert set(_UNGUARDED_ALLOWED) <= paths


def test_every_websocket_route_refuses_an_anonymous_lan_peer(lan_share):
    """Behavioural twin of the structural check: whatever guard a route
    declares, the route itself refuses a credential-less LAN peer."""
    from main import app

    for path, _route in _websocket_routes(app.routes):
        if path in _UNGUARDED_ALLOWED or "{" in path:
            continue
        refusal = _refusal(_client(), path)
        assert refusal is not None, f"{path} accepted an anonymous LAN peer"
        assert refusal.code == 1008
        assert refusal.reason in {CONSUMER_REFUSAL, DICTATION_REFUSAL}, (
            f"{path} was refused by another layer, not a route guard"
        )
