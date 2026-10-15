"""Shared WebSocket handshake guard.

WebSocket dependency injection differs across FastAPI versions, so routes
check the handshake inline before ``accept()``. This is the same check
``/ws/transcribe`` performs (#1646 review), factored out for new routes.
"""
from __future__ import annotations

from fastapi import WebSocket

from api.dependencies import is_local_host, ws_remote_authorized


async def admit_local_or_authorized(websocket: WebSocket) -> bool:
    """Refuse ambient cross-site handshakes and non-loopback clients without
    a remote admin credential. Closes with 1008 and returns False on refusal;
    native clients (no ``Origin``) and the app's own origins pass."""
    if websocket.headers.get("origin"):
        from core.csrf import origin_allowed

        if not origin_allowed(websocket):
            await websocket.close(code=1008, reason="browser origin not allowed")
            return False
    host = websocket.client.host if websocket.client else None
    if not is_local_host(host) and not ws_remote_authorized(websocket):
        await websocket.close(code=1008, reason="loopback origin required")
        return False
    return True
