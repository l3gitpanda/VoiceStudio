"""One consent rule for speaking *as* a saved voice (calls and Live Voice)."""
import pytest

from core.voice_consent import may_speak_as


@pytest.mark.parametrize("kind,verified,allowed", [
    ("clone", 1, True),
    ("clone", 0, False),
    (None, 0, False),       # legacy rows without a kind are clones
    ("design", 0, True),
    ("design", 1, True),
])
def test_rule(kind, verified, allowed):
    assert may_speak_as({"kind": kind, "verified_own_voice": verified}) is allowed


def test_calls_use_the_same_rule(monkeypatch):
    from services.telephony import calls

    seen = []
    monkeypatch.setattr("core.voice_consent.may_speak_as", lambda row: seen.append(row) or False)

    class _Conn:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def execute(self, *_):
            class _R:
                def fetchone(self):
                    return {"id": "p", "name": "P", "kind": "clone", "verified_own_voice": 1}

            return _R()

    monkeypatch.setattr("core.db.db_conn", lambda: _Conn())
    with pytest.raises(calls.CallError) as err:
        calls.eligible_profile("p")
    assert seen and err.value.args  # refused because the shared rule said no
