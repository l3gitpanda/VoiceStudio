"""Seed-VC adapter contract, with the permanent echo sidecar standing in.

No GPU, no weights: ``_echo`` answers the same ``vc_*`` ops as an identity
converter, so these tests spawn a real child process through the real
SubprocessBackend machinery and check the adapter end to end. The Seed-VC
sidecar's own request validation is tested in-process with the model
replaced (its heavy imports are lazy).
"""
import base64
import io
import json
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from engines import seedvc_subprocess as adapter
from services.vc.base import VCError, VCReference, VCStreamParams

_BACKEND = Path(adapter.__file__).resolve().parents[2]
_ECHO = _BACKEND / "engines" / "_echo" / "main.py"
_SIDECAR = Path(adapter.__file__).resolve().parent / "main.py"
_REQUIREMENTS = _SIDECAR.with_name("requirements.txt")


class EchoVCSidecar(adapter.SeedVCSidecar):
    @classmethod
    def is_available(cls):
        return True, "ready"

    @classmethod
    def venv_python(cls):
        return Path(sys.executable)

    @classmethod
    def sidecar_script(cls):
        return _ECHO


@pytest.fixture()
def reference(tmp_path):
    path = tmp_path / "ref.wav"
    t = np.arange(adapter.SAMPLE_RATE * 2) / adapter.SAMPLE_RATE
    sf.write(path, (0.4 * np.sin(2 * np.pi * 180 * t)).astype(np.float32), adapter.SAMPLE_RATE)
    return VCReference(path=str(path), cache_key="0" * 32)


@pytest.fixture()
def backend(monkeypatch, tmp_path):
    monkeypatch.setattr(adapter, "cache_dir", lambda: tmp_path / "vc_cache")
    b = adapter.SeedVCBackend(transport=EchoVCSidecar())
    yield b
    b.shutdown()


def test_contract_prepare_convert_reset(backend, reference):
    backend.configure(VCStreamParams(block_ms=180, context_ms=1000, gate_db=-90.0))
    target = backend.prepare(reference)
    assert target.device == "cpu" and target.ref_seconds == pytest.approx(2.0, abs=0.05)
    assert backend.sample_rate == 22_050 and backend.block_samples == 9 * 441
    s = backend.streamer
    x = (0.2 * np.sin(np.arange(s.block * 6) / 7.0)).astype(np.float32)
    out = np.concatenate([backend.convert(x[i:i + 1000]) for i in range(0, x.size, 1000)])
    delay = s.crossfade + s.search + s.tail_samples
    expected = np.concatenate([np.zeros(delay, np.float32), x])[: out.size]
    assert out.size == 6 * s.block
    np.testing.assert_allclose(out, expected, atol=1e-5)
    backend.reset()
    assert backend.streamer.pending_samples == 0


def test_unavailable_until_installed(monkeypatch):
    monkeypatch.setattr(adapter, "own_venv_python", lambda: None)
    ok, reason = adapter.SeedVCBackend.is_available()
    assert not ok and "not installed" in reason


@pytest.mark.parametrize("exited", [False, True], ids=["dying", "dead"])
def test_sidecar_crash_is_a_typed_engine_failure(backend, reference, monkeypatch, exited):
    """Whether the crash is still in progress or already over, conversion
    fails; it never respawns a sidecar that has no target voice (that raced:
    a dead one was silently replaced and the next window "converted")."""
    monkeypatch.setenv("OMNIVOICE_ECHO_CRASH", "1")  # exits after one reply
    backend.configure(VCStreamParams(gate_db=-90.0))
    backend.prepare(reference)
    if exited:
        backend._transport._proc.wait(timeout=10)
    with pytest.raises(VCError) as err:
        backend.convert(np.ones(backend.block_samples, dtype=np.float32) * 0.1)
    assert err.value.code == "engine_failed"


def test_malformed_audio_from_the_sidecar_is_refused(backend):
    class _Short:
        def request(self, msg, *, timeout_s, respawn=True):
            return {"op": "vc_audio", "pcm_b64": base64.b64encode(b"\x00" * 8).decode()}

        def shutdown(self):
            pass

    real = backend._transport
    backend._transport = _Short()
    real.shutdown()
    with pytest.raises(VCError, match="malformed"):
        backend.infer_window(np.zeros(100, np.float32), head_samples=0, out_samples=100, tail_samples=0)


def test_vc_replies_are_allowlisted_but_nothing_else_is():
    ops = adapter.SeedVCSidecar.parent_inbound_ops
    assert {"vc_prepared", "vc_audio", "ready", "error", "progress"} <= ops
    assert "exfiltrate" not in ops


# ── the Seed-VC sidecar itself ─────────────────────────────────────────────


def _load_sidecar(monkeypatch):
    """The sidecar module under a private name (``main`` is the app's)."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("seedvc_sidecar_main", _SIDECAR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _frames(buf: io.BytesIO) -> list:
    buf.seek(0)
    out = []
    while header := buf.read(4):
        (n,) = struct.unpack("!I", header)
        out.append(json.loads(buf.read(n)))
    return out


def test_sidecar_imports_nothing_heavy_before_a_request():
    code = (f"import sys; sys.path.insert(0, {str(_SIDECAR.parent)!r}); import main; "
            "print(any(m in sys.modules for m in ('torch', 'numpy', 'transformers')))")
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert result.stdout.strip() == "False", result.stderr


def test_sidecar_validates_window_requests(monkeypatch):
    sidecar = _load_sidecar(monkeypatch)
    import torch

    monkeypatch.setattr(sidecar, "_MODEL", {"device": torch.device("cpu")})
    monkeypatch.setattr(sidecar, "_TARGET", {})
    monkeypatch.setattr(sidecar, "convert_window",
                        lambda m, t, w, h, o, tl, st, cfg: w[h:h + o])
    frame = sidecar.FRAME
    window = np.arange(frame * 4, dtype=np.float32) / 1e4
    msg = {"op": "vc_infer", "pcm_b64": base64.b64encode(window.astype("<f4").tobytes()).decode(),
           "head_samples": frame, "out_samples": frame * 2, "tail_samples": frame}
    buf = io.BytesIO()
    sidecar._handle_infer(msg, buf)
    (reply,) = _frames(buf)
    got = np.frombuffer(base64.b64decode(reply["pcm_b64"]), "<f4")
    np.testing.assert_array_equal(got, window[frame:frame * 3])
    for bad in ({"head_samples": 7}, {"out_samples": 0}, {"tail_samples": -frame},
                {"pcm_b64": base64.b64encode(b"\x00\x00\x00").decode()}):
        with pytest.raises(ValueError):
            sidecar._handle_infer({**msg, **bad}, io.BytesIO())


def test_sidecar_refuses_cache_keys_that_could_escape(monkeypatch, tmp_path):
    sidecar = _load_sidecar(monkeypatch)
    for key in ("../../etc/passwd", "a" * 32, "0" * 32 + "-x", ""):
        assert sidecar._cache_path({"cache_key": key, "cache_dir": str(tmp_path)}) is None
    ok = sidecar._cache_path({"cache_key": "f" * 32 + "-3000", "cache_dir": str(tmp_path)})
    assert ok == str(tmp_path / ("f" * 32 + "-3000.pt"))


def test_dac_stub_satisfies_the_import_and_fails_if_used(monkeypatch):
    sidecar = _load_sidecar(monkeypatch)
    for name in ("dac", "dac.nn", "dac.nn.quantize"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    import builtins

    real_import = builtins.__import__

    def _no_dac(name, *args, **kwargs):
        if name == "dac" or name.startswith("dac."):
            if name not in sys.modules:
                raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _no_dac)
    sidecar._stub_dac()
    from dac.nn.quantize import VectorQuantize

    with pytest.raises(RuntimeError, match="descript-audio-codec"):
        VectorQuantize(1, 2, 3)


# ── install recipe ─────────────────────────────────────────────────────────

#: Same advisory floors CosyVoice's sidecar holds (tests/test_cosyvoice_subprocess.py).
_ADVISORY_FLOORS = {"transformers": "5.10.0", "tqdm": "4.66.3"}


def test_requirements_stay_above_advisory_fixes_and_drop_the_risky_extras():
    from packaging.version import Version

    pins = {}
    for line in _REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if "==" in line:
            name, version = line.split("==", 1)
            pins[name.strip().lower()] = version.strip()
    for name, floor in _ADVISORY_FLOORS.items():
        assert Version(pins[name]) >= Version(floor), f"{name}=={pins[name]} is below {floor}"
    for dropped in ("torch", "torchaudio", "descript-audio-codec", "protobuf", "gradio",
                    "funasr", "modelscope", "sounddevice"):
        assert dropped not in pins


def test_install_spec_pins_the_reviewed_commit():
    from services import sidecar_install

    spec = sidecar_install.SPECS["seed-vc"]
    assert spec.env_var == adapter.VENV_ENV_VAR
    assert spec.source_revision in spec.tarball_url and len(spec.source_revision) == 40
    assert spec.venv_args == ("--python", "3.10")
    assert spec.torch_pins == ("torch==2.7.0", "torchaudio==2.7.0")
    assert spec.install_args == ("-r", str(_REQUIREMENTS))
    assert "{checkout_repr}" in spec.probe_code
    assert Path(_BACKEND.parent / spec.docs_path).is_file()


def test_install_is_refused_on_intel_macs(monkeypatch):
    from services import sidecar_install

    monkeypatch.setattr(sidecar_install.sys, "platform", "darwin")
    monkeypatch.setattr("platform.machine", lambda: "x86_64")
    ok, reason = sidecar_install.host_support(sidecar_install.SPECS["seed-vc"])
    assert not ok and "Intel Mac" in reason
