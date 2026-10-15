"""The voice-conversion adapter interface.

``VoiceConversionBackend`` is deliberately separate from ``TTSBackend``: it
consumes audio, keeps per-stream state and returns audio as it goes. Models
plug in through ``StreamingVCBackend``: the block framing, look-ahead and
crossfading live in :mod:`services.vc.streamer`, so an adapter implements
only ``prepare`` (the target voice) and ``infer_window`` (one window in, the
requested slice of converted audio out). That keeps the model swappable —
Seed-VC today, any other window-based converter later — and lets CI test the
whole pipeline against a stub sidecar with no GPU.

Audio crossing this interface is mono float32 numpy at ``sample_rate``.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, fields

import numpy as np

from services.vc.streamer import BlockStreamer


@dataclass(frozen=True)
class VCStreamParams:
    """Tunable stream settings. Every field is bounded by :data:`LIMITS`; the
    WebSocket validates requests against the same table."""

    block_ms: int = 180          # converted per inference; the latency floor
    crossfade_ms: int = 40       # SOLA overlap between consecutive blocks
    context_ms: int = 2500       # past audio the model sees on the left
    lookahead_ms: int = 20       # future audio the model sees on the right
    steps: int = 10              # diffusion steps (quality vs speed)
    cfg_rate: float = 0.7        # classifier-free guidance; 0 is ~1.5x faster
    max_prompt_s: float = 3.0    # reference clip length used for the target
    gate_db: float = -50.0       # blocks quieter than this are not converted

    def clamped(self) -> "VCStreamParams":
        values = {}
        for f in fields(self):
            low, high = LIMITS[f.name]
            value = getattr(self, f.name)
            values[f.name] = type(f.default)(min(high, max(low, value)))
        return VCStreamParams(**values)


#: Inclusive (low, high) bound for every :class:`VCStreamParams` field.
LIMITS: dict[str, tuple[float, float]] = {
    "block_ms": (80, 1000),
    "crossfade_ms": (20, 100),
    "context_ms": (500, 5000),
    "lookahead_ms": (0, 200),
    "steps": (1, 30),
    "cfg_rate": (0.0, 1.0),
    "max_prompt_s": (1.0, 10.0),
    "gate_db": (-90.0, -20.0),
}

#: Defaults for hosts without an accelerator: bigger blocks, less context,
#: fewer steps, no guidance and a shorter prompt, so a CPU keeps up at the cost
#: of latency. Measured with Seed-VC on 4 vCPUs: 592 ms per 800 ms block
#: (RTF 0.74); 600 ms blocks with 1.5 s context ran at RTF 1.23 and fell behind.
CPU_PARAMS = VCStreamParams(block_ms=800, context_ms=1000, steps=4, cfg_rate=0.0, max_prompt_s=2.0)


@dataclass(frozen=True)
class VCReference:
    """A target voice: a local reference clip plus a cache key that changes
    whenever the clip does (filename, size and mtime)."""

    path: str
    cache_key: str


@dataclass(frozen=True)
class VCTarget:
    """What ``prepare`` reports back."""

    cache_key: str
    ref_seconds: float
    cached: bool
    device: str


class VCError(RuntimeError):
    """A failure the WebSocket reports with a stable ``code``."""

    def __init__(self, code: str, detail: str):
        super().__init__(detail)
        self.code = code
        self.detail = detail


class VoiceConversionBackend(ABC):
    """Streaming speech-to-speech converter."""

    id: str = "base"
    display_name: str = "Voice conversion"

    @property
    @abstractmethod
    def sample_rate(self) -> int:
        """Model input/output rate; clients capture and play at this rate."""

    @classmethod
    @abstractmethod
    def is_available(cls) -> tuple[bool, str]:
        """(ready, reason). The reason is a fixed sentence safe to show."""

    @abstractmethod
    def configure(self, params: VCStreamParams) -> None:
        """Apply stream settings. Resets the stream state."""

    @abstractmethod
    def prepare(self, reference: VCReference) -> VCTarget:
        """Load the model if needed and compute (or load) the target voice."""

    @abstractmethod
    def convert(self, chunk: np.ndarray) -> np.ndarray:
        """Feed input samples; return the converted samples now available
        (zero or more whole blocks)."""

    @abstractmethod
    def reset(self) -> None:
        """Drop stream state (context, crossfade tail); keep the target."""

    @property
    @abstractmethod
    def block_samples(self) -> int:
        """Samples consumed and produced per conversion step."""

    @property
    @abstractmethod
    def algorithmic_latency_ms(self) -> float:
        """Latency the framing adds, before inference and device time."""

    @property
    def device(self) -> str:
        return "cpu"

    def shutdown(self) -> None:
        """Release the model. Default: nothing to release."""


class StreamingVCBackend(VoiceConversionBackend):
    """A converter built from a window function and :class:`BlockStreamer`."""

    def __init__(self) -> None:
        self._params = VCStreamParams()
        self._streamer = BlockStreamer(self.sample_rate, self._params)

    @property
    def params(self) -> VCStreamParams:
        return self._params

    @property
    def streamer(self) -> BlockStreamer:
        return self._streamer

    @property
    def block_samples(self) -> int:
        return self._streamer.block

    @property
    def algorithmic_latency_ms(self) -> float:
        return self._streamer.algorithmic_latency_ms

    def configure(self, params: VCStreamParams) -> None:
        self._params = params.clamped()
        self._streamer = BlockStreamer(self.sample_rate, self._params)

    def reset(self) -> None:
        self._streamer.reset()

    def convert(self, chunk: np.ndarray) -> np.ndarray:
        self._streamer.push(chunk)
        out = []
        while self._streamer.has_block():
            window = self._streamer.next_window()
            s = self._streamer
            if s.window_is_silent(window):
                converted = np.zeros(s.out_samples, dtype=np.float32)
            else:
                converted = self.infer_window(
                    window,
                    head_samples=s.head_samples,
                    out_samples=s.out_samples,
                    tail_samples=s.tail_samples,
                )
            out.append(s.splice(converted))
        if not out:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(out)

    @abstractmethod
    def infer_window(
        self,
        window: np.ndarray,
        *,
        head_samples: int,
        out_samples: int,
        tail_samples: int,
    ) -> np.ndarray:
        """Convert ``window`` (``head + out + tail`` samples) and return the
        ``out_samples`` of converted audio that align with
        ``window[head_samples:head_samples + out_samples]``."""
