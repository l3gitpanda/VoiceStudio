"""The secret-scan allowlist must remain exact and value-scoped."""
import hashlib
from pathlib import Path
import re
import tomllib


ROOT = Path(__file__).resolve().parents[1]
# SHA-256 of each retired PostHog project token that history still holds.
# Analytics is removed, so no token lives in the source tree any more.
_RETIRED_TOKEN_SHA256 = {
    "cf19c9566b83f7375f591f5fbf776b9c344025805d12c16bd21333f70a708f72",
    "20b808bcff907f1afac896c5b835a04415a4b914c4314477314397f0f3f6fc38",
}
EXPECTED_EXACT_REGEXES = {
    "^528e871c2a26c4f0f7773b9754e2e1acae20899d$",
    "^hf_abcdefghijklmnopqrstuvwxyz01234567890abcd$",
    "^hf_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF$",
    "^hf_QWERTYUIOPasdfghjklZXCVBNM0123456789xyzAB$",
    "^max_length=400$",
    "^Ed25519PrivateKey$",
    r"^omnivoice\.dubSplit\.v1$",
}


def test_gitleaks_allowlist_contains_only_reviewed_exact_values():
    config = tomllib.loads((ROOT / ".gitleaks.toml").read_text(encoding="utf-8"))
    allowlist = config["allowlist"]

    assert set(allowlist) == {"description", "regexes"}
    posthog = {r for r in allowlist["regexes"] if r.startswith("^phc_")}
    assert len(posthog) == 1
    token = next(iter(posthog))[1:-1]
    assert re.fullmatch(r"phc_[A-Za-z0-9]{20,}", token)
    assert hashlib.sha256(token.encode()).hexdigest() in _RETIRED_TOKEN_SHA256
    assert set(allowlist["regexes"]) - posthog == EXPECTED_EXACT_REGEXES
    assert all(
        regex.startswith("^") and regex.endswith("$")
        for regex in allowlist["regexes"]
    )
    assert "rules" not in config


def test_dub_storage_key_allowlist_does_not_hide_similar_credentials():
    config = tomllib.loads((ROOT / ".gitleaks.toml").read_text(encoding="utf-8"))
    regexes = config["allowlist"]["regexes"]
    assert any(re.fullmatch(regex, "omnivoice.dubSplit.v1") for regex in regexes)
    for value in (
        "omnivoiceXdubSplitXv1",
        "omnivoice.dubSplit.v1-secret",
        "secret-omnivoice.dubSplit.v1",
    ):
        assert not any(re.fullmatch(regex, value) for regex in regexes)


_FINGERPRINT = re.compile(r"^([0-9a-f]{40}):([^:]+):([a-z0-9-]+):([0-9]+)$")


def _ignored_fingerprints():
    text = (ROOT / ".gitleaksignore").read_text(encoding="utf-8")
    return [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.startswith("#")]


def test_gitleaks_ignores_only_commit_pinned_posthog_findings():
    """An ignore entry names one finding in one commit, never a path or a rule."""
    import subprocess

    entries = _ignored_fingerprints()
    assert entries
    shallow = subprocess.run(
        ["git", "rev-parse", "--is-shallow-repository"],
        cwd=ROOT, capture_output=True, text=True,
    ).stdout.strip() == "true"
    for entry in entries:
        match = _FINGERPRINT.fullmatch(entry)
        assert match, f"not a commit-pinned fingerprint: {entry}"
        commit, path, _rule, line = match.groups()
        if shallow:
            continue
        shown = subprocess.run(
            ["git", "show", f"{commit}:{path}"], cwd=ROOT, capture_output=True, text=True,
        )
        assert shown.returncode == 0, f"cannot read the pinned commit and path: {entry}"
        source_line = shown.stdout.splitlines()[int(line) - 1]
        # Only the retired public PostHog project token may be skipped.
        token = re.search(r"phc_[A-Za-z0-9]{20,}", source_line)
        assert token, entry
        assert hashlib.sha256(token.group(0).encode()).hexdigest() in _RETIRED_TOKEN_SHA256, entry
