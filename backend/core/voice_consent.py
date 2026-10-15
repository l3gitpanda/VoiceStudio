"""Which saved voices the app may speak *as*, live or on the user's behalf.

One rule, shared by every feature that puts a saved voice in front of other
people in real time — outbound phone calls and the live voice changer: the
user's own voice, verified with the recorded consent statement
(``POST /profiles/{id}/consent``), or a designed voice, which belongs to no
real person. Gallery, community and archetype voices are stored as clone rows
without a consent recording, so they are refused until the user records one.

Plain local synthesis (Generate, Convert) does not consult this rule; see
``api/routers/profiles.py`` for the consent flow itself.
"""
from __future__ import annotations


def may_speak_as(row) -> bool:
    """True when ``row`` (a ``voice_profiles`` row) is the user's verified
    voice or a designed voice."""
    kind = row["kind"] or "clone"
    return bool(row["verified_own_voice"]) or kind == "design"
