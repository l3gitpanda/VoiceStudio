"""Block streaming for window-based voice converters.

A converter cannot run on 180 ms of audio in isolation: it needs past context
to sound continuous and a little future context to finish the block. The
streamer keeps a ring of recent input and, for every new block, hands the
model one window::

    [ head: left context ][ out: crossfade + search + block ][ tail: look-ahead ]

The model returns the ``out`` slice converted. Consecutive slices overlap by
the crossfade region, so they are joined with SOLA: the next slice is shifted
by up to ``search`` samples to the offset where it best matches the previous
tail (normalised cross-correlation), then crossfaded with sin² windows. That
hides block seams without a phase-vocoder.

Every length is a whole number of 20 ms frames, the content-feature rate of
the models this targets, so frame arithmetic on the model side stays exact.

Latency: each input sample leaves after ``block + crossfade + search +
lookahead`` samples plus the model's inference time (constant for every
sample of a block), which :attr:`BlockStreamer.algorithmic_latency_ms`
reports.

Pure numpy, written for VoiceStudio; no model code lives here.
"""
from __future__ import annotations

import numpy as np

FRAME_MS = 20
#: The crossfade is capped at four frames (80 ms); longer overlaps smear
#: transients without hiding seams any better.
MAX_CROSSFADE_FRAMES = 4


def _frames(ms: float) -> int:
    return max(0, int(round(ms / FRAME_MS)))


class BlockStreamer:
    """Turns an arbitrary-size input stream into model windows and joins the
    converted slices back into a continuous output stream."""

    def __init__(self, sample_rate: int, params) -> None:
        if sample_rate % 50:
            raise ValueError("sample rate must be a multiple of 50 Hz (20 ms frames)")
        self.sample_rate = int(sample_rate)
        zc = self.sample_rate // 50
        self.frame = zc
        self.block = max(1, _frames(params.block_ms)) * zc
        self.crossfade = max(1, min(_frames(params.crossfade_ms), MAX_CROSSFADE_FRAMES)) * zc
        self.search = zc
        self.head_samples = _frames(params.context_ms) * zc
        self.tail_samples = _frames(params.lookahead_ms) * zc
        self.out_samples = self.crossfade + self.search + self.block
        self.window_samples = self.head_samples + self.out_samples + self.tail_samples
        # 10 ** (dB / 20) on the RMS of the region a block will emit.
        self._gate_rms = float(10.0 ** (float(params.gate_db) / 20.0))
        t = np.linspace(0.0, 1.0, self.crossfade, dtype=np.float32)
        self._fade_in = (np.sin(0.5 * np.pi * t) ** 2).astype(np.float32)
        self._fade_out = (1.0 - self._fade_in).astype(np.float32)
        self.reset()

    # ── state ──────────────────────────────────────────────────────────────

    def reset(self) -> None:
        self._ring = np.zeros(self.window_samples, dtype=np.float32)
        self._pending = np.zeros(0, dtype=np.float32)
        self._tail = np.zeros(self.crossfade, dtype=np.float32)
        self._primed = False

    @property
    def algorithmic_latency_ms(self) -> float:
        samples = self.block + self.crossfade + self.search + self.tail_samples
        return 1000.0 * samples / self.sample_rate

    @property
    def pending_samples(self) -> int:
        return int(self._pending.shape[0])

    # ── input side ─────────────────────────────────────────────────────────

    def push(self, chunk: np.ndarray) -> None:
        chunk = np.asarray(chunk, dtype=np.float32).reshape(-1)
        if chunk.size:
            self._pending = np.concatenate([self._pending, chunk])

    def has_block(self) -> bool:
        return self.pending_samples >= self.block

    def next_window(self) -> np.ndarray:
        """Shift one block of queued input into the ring; return the window."""
        if not self.has_block():
            raise RuntimeError("no complete block queued")
        block, self._pending = self._pending[: self.block], self._pending[self.block:]
        self._ring = np.concatenate([self._ring[self.block:], block])
        return self._ring.copy()

    def window_is_silent(self, window: np.ndarray) -> bool:
        """True when the region this window emits is below the gate."""
        start = self.head_samples
        region = window[start:start + self.out_samples]
        if region.size == 0:
            return True
        return float(np.sqrt(np.mean(np.square(region, dtype=np.float64)))) < self._gate_rms

    # ── output side ────────────────────────────────────────────────────────

    def splice(self, converted: np.ndarray) -> np.ndarray:
        """Join one converted ``out`` slice onto the stream; return ``block``
        samples ready to play."""
        out = np.asarray(converted, dtype=np.float32).reshape(-1)
        if out.shape[0] != self.out_samples:
            fixed = np.zeros(self.out_samples, dtype=np.float32)
            n = min(self.out_samples, out.shape[0])
            fixed[:n] = out[:n]
            out = fixed
        out = np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0)
        offset = self._sola_offset(out) if self._primed else 0
        out = out[offset:].copy()
        out[: self.crossfade] = out[: self.crossfade] * self._fade_in + self._tail * self._fade_out
        self._tail = out[self.block:self.block + self.crossfade].copy()
        self._primed = True
        return np.clip(out[: self.block], -1.0, 1.0)

    def _sola_offset(self, out: np.ndarray) -> int:
        """Shift in [0, search] where ``out`` best continues the last tail."""
        head = out[: self.crossfade + self.search].astype(np.float64)
        tail = self._tail.astype(np.float64)
        num = np.correlate(head, tail, mode="valid")
        energy = np.convolve(head * head, np.ones(self.crossfade), mode="valid")
        score = num / np.sqrt(energy + 1e-8)
        return int(np.argmax(score)) if score.size else 0
