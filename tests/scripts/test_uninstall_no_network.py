"""The uninstall scripts never touch the network — not even for consented users.

Older builds sent one `app_uninstalled` analytics ping from these scripts when
the user had opted in. Analytics is removed, so the ping is gone: a run with
the old consent record and `analytics_info.json` still on disk must send
nothing and still delete the data.

The bash script is exercised for real (fake $HOME + a curl shim that records
its argv); PowerShell isn't runnable on every dev/CI platform, so uninstall.ps1
is pinned by static checks.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys

import pytest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SH = os.path.join(REPO, "scripts", "uninstall.sh")
PS1 = os.path.join(REPO, "scripts", "uninstall.ps1")

pytestmark = pytest.mark.skipif(
    sys.platform.startswith("win"), reason="bash script is macOS/Linux-only"
)


def _run(tmp_path, *args, consented=True, with_info=True):
    """Run uninstall.sh in a throwaway HOME with a curl shim on PATH."""
    home = tmp_path / "home"
    data = tmp_path / "data"
    data.mkdir(parents=True)
    home.mkdir(parents=True)
    (data / "prefs.json").write_text(
        json.dumps({"analytics_enabled": bool(consented), "analytics_prompted": True})
    )
    if with_info:
        (data / "analytics_info.json").write_text(
            json.dumps(
                {
                    "token": "phc_test_token",
                    "host": "https://eu.i.posthog.com",
                    "distinct_id": "11111111-2222-3333-4444-555555555555",
                    "app_version": "0.3.23",
                    "platform": "macos",
                },
                indent=2,
            )
        )

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    curl_log = tmp_path / "curl_args.txt"
    shim = bin_dir / "curl"
    shim.write_text(f'#!/bin/sh\nprintf \'%s\\n\' "$@" >> "{curl_log}"\nexit 0\n')
    shim.chmod(shim.stat().st_mode | stat.S_IEXEC)

    env = dict(os.environ)
    env.update(
        {
            "HOME": str(home),
            "OMNIVOICE_DATA_DIR": str(data),
            # Keep the shared-model-cache branch inert and inside the sandbox.
            "OMNIVOICE_CACHE_DIR": str(tmp_path / "models-nonexistent"),
            "PATH": f"{bin_dir}:{env.get('PATH', '')}",
        }
    )
    proc = subprocess.run(
        ["bash", SH, *args], capture_output=True, text=True, env=env, timeout=60
    )
    curl_args = curl_log.read_text() if curl_log.exists() else ""
    return proc, curl_args


def test_bash_syntax_is_valid():
    subprocess.run(["bash", "-n", SH], check=True)


def test_legacy_consent_sends_nothing_and_still_deletes(tmp_path):
    proc, curl = _run(tmp_path, "--yes")
    assert proc.returncode == 0, proc.stderr
    assert curl == ""
    assert "ping" not in proc.stdout.lower()
    assert not (tmp_path / "data").exists()


def test_dry_run_sends_nothing(tmp_path):
    proc, curl = _run(tmp_path)  # no --yes
    assert proc.returncode == 0, proc.stderr
    assert "DRY RUN" in proc.stdout
    assert curl == ""


@pytest.mark.parametrize("path", [SH, PS1])
def test_scripts_carry_no_network_call_or_analytics(path):
    # Comments may mention the `curl … | sh` installer; only code counts.
    src = "\n".join(
        line for line in open(path, encoding="utf-8-sig").read().splitlines()
        if not line.lstrip().startswith("#")
    )
    for needle in (
        r"\bcurl\b", r"\bwget\b", r"Invoke-RestMethod", r"Invoke-WebRequest",
        r"posthog", r"app_uninstalled", r"analytics_info", r"phc_",
    ):
        assert not re.search(needle, src, re.I), (path, needle)


def test_shellcheck_clean_if_available():
    """Run shellcheck when the tool exists (dev machines / CI images that have
    it); skip silently elsewhere — the bash -n + functional tests still run."""
    if not shutil.which("shellcheck"):
        pytest.skip("shellcheck not installed")
    proc = subprocess.run(
        ["shellcheck", "-S", "error", SH], capture_output=True, text=True
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_shipped_powershell_scripts_with_non_ascii_carry_a_utf8_bom():
    """A BOM-less UTF-8 .ps1 is decoded with the ANSI code page by Windows
    PowerShell 5.1 — still the default shell on Windows 10/11.

    `uninstall.ps1` prints em-dashes in `Write-Host` output ("Model cache
    (Hugging Face weights — SHARED …)"), so without a BOM the user running the
    uninstaller sees mojibake in the very messages that explain what is about
    to be deleted. Pinned rather than left to review: the BOM is invisible in a
    diff, so an editor that "helpfully" strips it would go unnoticed until a
    Windows user reported garbled output (CodeRabbit, #1399).

    Scoped to `scripts/` — the vendored trees under `research/` are not ours.
    """
    scripts_dir = os.path.join(REPO, "scripts")
    offenders = []
    for name in sorted(os.listdir(scripts_dir)):
        if not name.endswith(".ps1"):
            continue
        raw = open(os.path.join(scripts_dir, name), "rb").read()
        if raw.startswith(b"\xef\xbb\xbf"):
            continue
        if any(ord(ch) > 127 for ch in raw.decode("utf-8")):
            offenders.append(name)
    assert not offenders, (
        f"these shipped PowerShell scripts contain non-ASCII text but have no "
        f"UTF-8 BOM, so Windows PowerShell 5.1 will mis-decode them: {offenders}"
    )
