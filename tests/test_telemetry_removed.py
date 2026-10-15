"""Product analytics is removed: no SDK, no token, no host, no event can leave.

Older builds shipped consent-gated PostHog analytics (backend + renderer + an
uninstall ping). This fork removes it entirely. These checks fail if any piece
comes back — for example through a merge from upstream — so "private" stays
true without anyone having to re-audit the tree.
"""
from __future__ import annotations

import json
import re
import subprocess
import tomllib
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[1]

_TOKEN_RE = re.compile(r"phc_[A-Za-z0-9]{20,}")
# Runtime trees only: tests, docs and CI history may mention the removal.
_RUNTIME_DIRS = ("backend/", "electron/src/", "scripts/", "deploy/", "omnivoice/")
_RUNTIME_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".html", ".sh", ".ps1"}
_SDK_PATTERNS = (
    re.compile(r"^\s*(from|import)\s+posthog\b", re.M),
    re.compile(r"""['"]posthog-js[/'"]"""),
    re.compile(r"(?:[a-z0-9-]+\.)+posthog\.com"),  # ingestion hosts, not a plain link
)


def _tracked() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=_REPO, capture_output=True, text=True, check=True
    ).stdout
    return [n for n in out.split("\0") if n]


def _runtime_sources():
    for name in _tracked():
        if not name.startswith(_RUNTIME_DIRS) or Path(name).suffix not in _RUNTIME_SUFFIXES:
            continue
        if ".test." in name or "/test/" in name or "/tests/" in name:
            continue
        path = _REPO / name
        if path.is_file():
            yield name, path.read_text(encoding="utf-8", errors="ignore")


def test_no_analytics_token_anywhere_but_the_gitleaks_history_allowlist():
    offenders = []
    for name in _tracked():
        if name in {".gitleaks.toml", "tests/test_gitleaks_allowlist.py"}:
            continue
        path = _REPO / name
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if _TOKEN_RE.search(text):
            offenders.append(name)
    assert not offenders, f"analytics token literal committed in: {offenders}"


def test_no_runtime_code_loads_an_analytics_sdk_or_host():
    offenders = [
        name
        for name, text in _runtime_sources()
        if any(p.search(text) for p in _SDK_PATTERNS)
    ]
    assert not offenders, f"analytics SDK/host referenced in runtime code: {offenders}"


def test_analytics_packages_are_not_dependencies():
    py = tomllib.loads((_REPO / "pyproject.toml").read_text(encoding="utf-8"))
    deps = py["project"]["dependencies"] + [
        d for extra in py["project"].get("optional-dependencies", {}).values() for d in extra
    ]
    assert not [d for d in deps if re.match(r"posthog\b", d, re.I)]
    assert 'name = "posthog"' not in (_REPO / "uv.lock").read_text(encoding="utf-8")

    for manifest in ("package.json", "electron/package.json"):
        pkg = json.loads((_REPO / manifest).read_text(encoding="utf-8"))
        names = {
            n
            for key in ("dependencies", "devDependencies", "optionalDependencies")
            for n in pkg.get(key, {})
        }
        assert not {n for n in names if "posthog" in n}, manifest
    assert "posthog" not in (_REPO / "bun.lock").read_text(encoding="utf-8")


def test_release_workflows_bake_no_analytics_destination():
    for wf in (_REPO / ".github/workflows").glob("*.y*ml"):
        assert "POSTHOG" not in wf.read_text(encoding="utf-8"), wf.name


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    from core import config, prefs

    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(prefs, "_PREFS_PATH", str(tmp_path / "prefs.json"))
    return tmp_path


def test_backend_module_can_never_enable_or_send(isolated, monkeypatch):
    from core import analytics, prefs

    monkeypatch.setenv("POSTHOG_PROJECT_TOKEN", "phc_" + "x" * 30)
    analytics.set_opted_in(True)
    assert not analytics.enabled()
    assert not analytics.token_configured()
    assert not analytics.user_opted_in()
    assert prefs.get("analytics_enabled") is None
    analytics.capture("speech_generated", {"text_length": 3})
    analytics.record_error_event("GPU_OOM", "fp", stage="generate")


def test_startup_purges_state_left_by_older_builds(isolated):
    from core import analytics, prefs

    for key, value in {
        "analytics_enabled": True,
        "analytics_install_recorded": True,
        "analytics_last_version": "0.5.0",
        "installation_id": "11111111-2222-3333-4444-555555555555",
    }.items():
        prefs.set_(key, value)
    info = isolated / analytics.UNINSTALL_PING_INFO_BASENAME
    info.write_text("{}")

    analytics.record_startup_lifecycle(None)

    for key in analytics._LEGACY_PREF_KEYS:
        assert prefs.get(key) is None, key
    assert not info.exists()


def test_settings_route_reports_analytics_unavailable(isolated):
    from api.routers.settings import _AnalyticsBody, get_analytics, set_analytics

    state = set_analytics(_AnalyticsBody(enabled=True))
    assert state == get_analytics()
    assert state["available"] is False
    assert state["enabled"] is False
    assert state["opted_in"] is False
    assert state["prompted"] is True


# ── No background calls to third parties ───────────────────────────────────


def test_backend_forces_library_telemetry_off():
    src = (_REPO / "backend/main.py").read_text(encoding="utf-8")
    block = src[src.index("Third-party library telemetry: always off"):]
    for var, value in (
        ("HF_HUB_DISABLE_TELEMETRY", "1"),
        ("DO_NOT_TRACK", "1"),
        ("GRADIO_ANALYTICS_ENABLED", "False"),
    ):
        assert f'("{var}", "{value}")' in block[:800], var
    # Must run before the first backend import (huggingface_hub reads env at import).
    assert src.index("Third-party library telemetry") < src.index("\nfrom ")


def test_desktop_shell_never_checks_for_updates_on_its_own():
    src = (_REPO / "electron/src/main/index.ts").read_text(encoding="utf-8")
    assert "updater.check(" not in src


def test_polled_token_status_never_calls_huggingface(monkeypatch):
    from services import hf_auth, token_resolver

    def _no_network(*_a, **_k):
        raise AssertionError("whoami must not run from a polled status check")

    monkeypatch.setattr(hf_auth, "canonical_whoami", _no_network)
    monkeypatch.setattr(token_resolver, "_read_app", lambda: None)
    monkeypatch.setattr(token_resolver, "_read_hf_cli", lambda: None)
    monkeypatch.setenv("HF_TOKEN", "hf_" + "a" * 34)
    token_resolver.invalidate_cache()
    assert token_resolver.has_local_token() is True
    monkeypatch.delenv("HF_TOKEN")
    monkeypatch.delenv("HUGGING_FACE_HUB_TOKEN", raising=False)
    assert token_resolver.has_local_token() is False

    # /system/info and the 30 s notification poll use the presence check, not
    # the whoami-validating resolve(). (Source check: the router imports torch.)
    src = (_REPO / "backend/api/routers/system.py").read_text(encoding="utf-8")
    body = src[src.index("def _has_hf_token"):src.index("\ndef ", src.index("def _has_hf_token") + 1)]
    assert "has_local_token()" in body and "resolve(" not in body
