"""One live voice-conversion session.

The WebSocket handler feeds microphone samples in; a worker thread converts
one block at a time and hands finished blocks back to the event loop. Both
directions are bounded and drop the OLDEST audio when full: in a live stream
a late block is worthless, so latency must never grow to absorb a slow model
or a slow client. Drops are counted and reported in :meth:`VCSession.stats`.

Only one session runs per backend process (:func:`claim` / :func:`release`):
the model holds the accelerator for the whole session.
"""
from __future__ import annotations

import asyncio
import collections
import logging
import statistics
import threading
import time
from typing import Optional

import numpy as np

from services.vc.base import VCError, VoiceConversionBackend

logger = logging.getLogger("omnivoice.vc.session")

#: Input waiting for the model, in blocks, before the oldest is dropped.
MAX_PENDING_BLOCKS = 3
#: Converted blocks waiting for the socket, before the oldest is dropped.
MAX_OUTBOX_BLOCKS = 4
#: Input may arrive at most this much faster than real time (plus a burst
#: allowance) before the session is refused as a file dump, not a microphone.
MAX_INPUT_SPEED = 2.0
INPUT_BURST_S = 2.0


class VCSession:
    def __init__(
        self,
        backend: VoiceConversionBackend,
        loop: asyncio.AbstractEventLoop,
        *,
        clock=time.monotonic,
    ) -> None:
        self.backend = backend
        self._loop = loop
        self._clock = clock
        self._block = int(backend.block_samples)
        self._sr = int(backend.sample_rate)
        self._cv = threading.Condition()
        self._inbox = np.zeros(0, dtype=np.float32)
        self._stop = threading.Event()
        self._reset = False
        self.outbox: asyncio.Queue = asyncio.Queue(maxsize=MAX_OUTBOX_BLOCKS)
        self.error: Optional[VCError] = None
        self._infer_ms: collections.deque = collections.deque(maxlen=50)
        self.blocks_in = 0
        self.blocks_out = 0
        self.dropped_in = 0
        self.dropped_out = 0
        self._received = 0
        self._started = clock()
        self._thread = threading.Thread(target=self._run, name="vc-session", daemon=True)

    # ── lifecycle ──────────────────────────────────────────────────────────

    def start(self) -> None:
        self._started = self._clock()
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        """Stop after the in-flight block (if any) and reset the stream."""
        self._signal_stop()
        if self._thread.is_alive():
            self._thread.join(timeout)
        self._reset_backend()

    def close(self, on_closed=None) -> None:
        """Non-blocking :meth:`stop` that cannot be cancelled: a helper
        thread waits for the in-flight block, resets the stream and only then
        calls ``on_closed`` (the WebSocket releases the session slot there, so
        a cancelled handler can never leak it or race the next session)."""
        self._signal_stop()

        def _finish() -> None:
            if self._thread.is_alive():
                self._thread.join()
            self._reset_backend()
            if on_closed is not None:
                on_closed()

        threading.Thread(target=_finish, name="vc-session-close", daemon=True).start()

    def _signal_stop(self) -> None:
        self._stop.set()
        with self._cv:
            self._cv.notify_all()

    def _reset_backend(self) -> None:
        try:
            self.backend.reset()
        except Exception:  # noqa: BLE001 — a reset failure must not leak the slot
            logger.debug("vc reset after stop failed", exc_info=True)

    @property
    def running(self) -> bool:
        return self._thread.is_alive() and not self._stop.is_set()

    # ── input ──────────────────────────────────────────────────────────────

    def feed(self, samples: np.ndarray) -> None:
        """Queue input samples. Raises ``VCError('too_fast')`` when input
        arrives far faster than real time."""
        samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        self._received += samples.shape[0]
        elapsed = max(0.0, self._clock() - self._started)
        allowed = (elapsed * MAX_INPUT_SPEED + INPUT_BURST_S) * self._sr
        if self._received > allowed:
            raise VCError("too_fast", "Audio is arriving faster than real time.")
        with self._cv:
            self._inbox = np.concatenate([self._inbox, samples])
            limit = MAX_PENDING_BLOCKS * self._block
            excess = self._inbox.shape[0] - limit
            if excess > 0:
                blocks = -(-excess // self._block)
                self._inbox = self._inbox[blocks * self._block:]
                self.dropped_in += blocks
            self._cv.notify()

    def request_reset(self) -> None:
        """Forget the stream state before the next block (e.g. after mute)."""
        with self._cv:
            self._reset = True
            self._inbox = np.zeros(0, dtype=np.float32)
            self._cv.notify()

    # ── worker ─────────────────────────────────────────────────────────────

    def _take_block(self) -> Optional[np.ndarray]:
        with self._cv:
            while not self._stop.is_set() and self._inbox.shape[0] < self._block and not self._reset:
                self._cv.wait(0.25)
            if self._stop.is_set():
                return None
            if self._reset:
                self._reset = False
                self.backend.reset()
                return np.zeros(0, dtype=np.float32)
            block = self._inbox[: self._block]
            self._inbox = self._inbox[self._block:]
            return block

    def _run(self) -> None:
        try:
            while True:
                block = self._take_block()
                if block is None:
                    return
                if block.size == 0:
                    continue
                self.blocks_in += 1
                t0 = time.perf_counter()
                out = self.backend.convert(block)
                self._infer_ms.append((time.perf_counter() - t0) * 1000.0)
                if out.size:
                    self._loop.call_soon_threadsafe(self._deliver, out)
        except VCError as exc:
            self._fail(exc)
        except Exception as exc:  # noqa: BLE001 — surfaced to the client as a typed error
            logger.warning("live voice conversion failed: %s", type(exc).__name__, exc_info=True)
            self._fail(VCError("engine_failed", _safe_detail(exc)))

    def _fail(self, exc: VCError) -> None:
        self.error = exc
        self._stop.set()
        self._loop.call_soon_threadsafe(self._deliver, None)

    def _deliver(self, out: Optional[np.ndarray]) -> None:
        """Runs on the event loop. ``None`` wakes the sender to report an error."""
        if self.outbox.full():
            try:
                self.outbox.get_nowait()
                self.dropped_out += 1
            except asyncio.QueueEmpty:  # pragma: no cover - single consumer
                pass
        self.outbox.put_nowait(out)
        if out is not None:
            self.blocks_out += 1

    # ── stats ──────────────────────────────────────────────────────────────

    def stats(self) -> dict:
        samples = list(self._infer_ms)
        block_ms = 1000.0 * self._block / self._sr
        p50 = statistics.median(samples) if samples else 0.0
        p95 = sorted(samples)[int(0.95 * (len(samples) - 1))] if samples else 0.0
        with self._cv:
            pending = self._inbox.shape[0]
        return {
            "type": "stats",
            "infer_ms_p50": round(p50, 1),
            "infer_ms_p95": round(p95, 1),
            "rtf": round(p50 / block_ms, 3) if block_ms else 0.0,
            "blocks_in": self.blocks_in,
            "blocks_out": self.blocks_out,
            "dropped_in": self.dropped_in,
            "dropped_out": self.dropped_out,
            "queue_blocks": round(pending / self._block, 2),
        }


def _safe_detail(exc: BaseException) -> str:
    """A user-facing sentence for an engine failure: the scrubbed first line,
    never a traceback or an absolute path."""
    from core.scrub import scrub_text

    text = str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__
    return scrub_text(text)[:300]


# ── one session per process ────────────────────────────────────────────────

_slot_lock = threading.Lock()
_active: Optional[object] = None


def claim(owner: object) -> bool:
    global _active
    with _slot_lock:
        if _active is not None:
            return False
        _active = owner
        return True


def release(owner: object) -> None:
    global _active
    with _slot_lock:
        if _active is owner:
            _active = None


def busy() -> bool:
    with _slot_lock:
        return _active is not None
