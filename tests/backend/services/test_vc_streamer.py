"""Block streaming for the live voice changer (services.vc.streamer/base).

An identity "model" must come out of the streamer as the exact input delayed
by the documented latency, whatever the chunk sizes the microphone delivers —
any seam, gap or misalignment the framing introduced would show up here.
"""
import numpy as np
import pytest

from services.vc.base import LIMITS, StreamingVCBackend, VCStreamParams
from services.vc.streamer import BlockStreamer

SR = 22_050


class _Identity(StreamingVCBackend):
    id = "identity"

    def __init__(self):
        self.calls = 0
        super().__init__()

    @property
    def sample_rate(self):
        return SR

    @classmethod
    def is_available(cls):
        return True, "ready"

    def prepare(self, reference):  # pragma: no cover - unused here
        raise NotImplementedError

    def infer_window(self, window, *, head_samples, out_samples, tail_samples):
        self.calls += 1
        assert window.shape[0] == head_samples + out_samples + tail_samples
        return window[head_samples:head_samples + out_samples].copy()


def _signal(seconds, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * SR)) / SR
    return (0.3 * np.sin(2 * np.pi * 220 * t) + 0.05 * rng.standard_normal(t.shape)).astype(np.float32)


@pytest.mark.parametrize("chunk", [128, 441, 1000, 3969, 22050])
def test_identity_model_is_exact_delayed_identity(chunk):
    backend = _Identity()
    backend.configure(VCStreamParams(block_ms=180, crossfade_ms=40, context_ms=1000,
                                     lookahead_ms=20, gate_db=-90.0))
    s = backend.streamer
    x = _signal(3.0)
    out = np.concatenate([backend.convert(x[i:i + chunk]) for i in range(0, x.size, chunk)])
    delay = s.crossfade + s.search + s.tail_samples
    assert out.size == (x.size // s.block) * s.block
    expected = np.concatenate([np.zeros(delay, np.float32), x])[: out.size]
    np.testing.assert_allclose(out, expected, atol=1e-5)
    assert backend.calls == out.size // s.block


def test_latency_matches_the_framing():
    s = BlockStreamer(SR, VCStreamParams(block_ms=180, crossfade_ms=40, lookahead_ms=20))
    # block + crossfade + 20 ms SOLA search + look-ahead
    assert s.algorithmic_latency_ms == pytest.approx(180 + 40 + 20 + 20, abs=0.5)
    for n in (s.block, s.crossfade, s.head_samples, s.tail_samples, s.out_samples):
        assert n % (SR // 50) == 0  # whole 20 ms frames, as the model side expects


def test_sola_realigns_a_shifted_model():
    """A model whose output is shifted (within the search range) still joins
    without discontinuities: SOLA finds the shift and the stream is continuous."""
    class _Shifted(_Identity):
        def infer_window(self, window, *, head_samples, out_samples, tail_samples):
            shift = self.streamer.search // 2
            return window[head_samples + shift:head_samples + shift + out_samples].copy()

    backend = _Shifted()
    backend.configure(VCStreamParams(block_ms=200, gate_db=-90.0, lookahead_ms=40))
    x = _signal(2.0, seed=3)
    out = np.concatenate([backend.convert(x[i:i + 2205]) for i in range(0, x.size, 2205)])
    steady = out[backend.streamer.block * 2:]
    assert np.max(np.abs(np.diff(steady))) < 0.5  # no seam clicks


def test_quiet_blocks_are_not_converted():
    backend = _Identity()
    backend.configure(VCStreamParams(gate_db=-40.0))
    out = backend.convert(np.full(SR, 1e-4, dtype=np.float32))
    assert backend.calls == 0
    assert out.size and not out.any()


def test_reset_forgets_context_and_tail():
    backend = _Identity()
    backend.configure(VCStreamParams(gate_db=-90.0))
    backend.convert(_signal(1.0))
    backend.reset()
    s = backend.streamer
    assert s.pending_samples == 0 and not s._ring.any() and not s._tail.any()


def test_malformed_model_output_is_padded_and_sanitised():
    s = BlockStreamer(SR, VCStreamParams())
    out = s.splice(np.full(10, np.nan, dtype=np.float32))
    assert out.shape == (s.block,) and np.isfinite(out).all()


def test_params_are_clamped_to_limits():
    wild = VCStreamParams(block_ms=5, crossfade_ms=10_000, context_ms=-1, lookahead_ms=9999,
                          steps=0, cfg_rate=7.0, max_prompt_s=99.0, gate_db=0.0).clamped()
    for name, (low, high) in LIMITS.items():
        assert low <= getattr(wild, name) <= high


def test_sample_rate_must_be_frame_aligned():
    with pytest.raises(ValueError):
        BlockStreamer(22_051, VCStreamParams())
