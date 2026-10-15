"""Handshake guards shared by every WebSocket route on the main app.

The share-PIN gate (``NetworkAccessMiddleware``) covers HTTP only, and the
API-key gate (``BearerKeyMiddleware``) is inert unless ``OMNIVOICE_API_KEY`` is
set. A WebSocket route therefore authorizes its own handshake, and these route
dependencies are the one place that happens. They run before the handler, so a
refused peer never reaches ``accept()``. ``tests/test_ws_route_guards.py`` fails
when a WebSocket route ships without one of them.

- ``require_ws_consumer``: streams any authenticated consumer may use
  (``/ws/events``, ``/ws/tts``). It admits the same principals as the HTTP
  ``require_consumer`` gate: loopback, a trusted network, the share PIN, the
  API key, or an admin session or ticket. Bare server mode (no key and no PIN)
  keeps its open consumption policy.
- ``require_ws_dictation``: the microphone stream. It admits loopback, a
  trusted network, or a remote admin credential. A share PIN is not enough.

Use them as ``@router.websocket(path, dependencies=[Depends(guard)])``.
"""
from __future__ import annotations

from fastapi import WebSocket, WebSocketException, status

from api.dependencies import consumer_authorized, is_local_host, ws_remote_authorized


def _refuse(reason: str) -> WebSocketException:
    # 1008 = policy violation, raised before accept() so the handshake is closed.
    return WebSocketException(code=status.WS_1008_POLICY_VIOLATION, reason=reason)


def _require_allowed_origin(websocket: WebSocket) -> None:
    """Refuse an ambient cross-site browser handshake before any trust check.

    A browser page can open a WebSocket to localhost whatever its own origin,
    and it attaches cookies to it. Native clients send no ``Origin`` and pass;
    this backend's own origin and the configured UI origins pass (#1646).
    """
    if websocket.headers.get("origin"):
        from core.csrf import origin_allowed

        if not origin_allowed(websocket):
            raise _refuse("browser origin not allowed")


async def require_ws_consumer(websocket: WebSocket) -> None:
    """Admit local clients and authenticated consumers (PIN, key, session)."""
    _require_allowed_origin(websocket)
    if not consumer_authorized(websocket):
        raise _refuse("authentication required")


async def require_ws_dictation(websocket: WebSocket) -> None:
    """Admit local clients and remote admin credentials, never a share PIN.

    Without this check, any device that reaches the backend could stream the
    user's microphone. A non-loopback client that presents the API key or an
    admin session is the thin-client dictation case (Wave 2.3): the microphone
    is on the user's machine and the GPU is here.
    """
    _require_allowed_origin(websocket)
    host = websocket.client.host if websocket.client else None
    if not is_local_host(host) and not ws_remote_authorized(websocket):
        raise _refuse("loopback origin required")


#: Every guard a WebSocket route may declare. The route-coverage test accepts
#: exactly these.
WEBSOCKET_GUARDS = frozenset({require_ws_consumer, require_ws_dictation})
