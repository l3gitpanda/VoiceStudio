"""Live voice session: bounded queues, drop-oldest backpressure, errors, slot."""
import asyncio
import time

import numpy as np
import pytest

from services.vc import session as vc_session
from services.vc.base import StreamingVCBackend, VCError, VCStreamParams

SR = 22_050


class _Model(StreamingVCBackend):
    id = "fake"

    def __init__(self, delay_s=0.0, fail=None):
        self.delay_s = delay_s
        self.fail = fail
        self.resets = 0
        super().__init__()

    @property
    def sample_rate(self):
        return SR

    @classmethod
    def is_available(cls):
        return True, "ready"

    def prepare(self, reference):  # pragma: no cover - unused
        raise NotImplementedError

    def reset(self):
        self.resets += 1
        super().reset()

    def infer_window(self, window, *, head_samples, out_samples, tail_samples):
        if self.fail:
            raise self.fail
        time.sleep(self.delay_s)
        return window[head_samples:head_samples + out_samples].copy()


async def _drain(session, n, timeout=5.0):
    got = []
    deadline = time.monotonic() + timeout
    while len(got) < n and time.monotonic() < deadline:
        try:
            got.append(await asyncio.wait_for(session.outbox.get(), 0.2))
        except asyncio.TimeoutError:
            pass
    return got


def _block(model):
    return np.full(model.block_samples, 0.1, dtype=np.float32)


@pytest.mark.asyncio
async def test_blocks_flow_through_and_stats_report_them():
    model = _Model()
    model.configure(VCStreamParams(gate_db=-90.0))
    s = vc_session.VCSession(model, asyncio.get_running_loop())
    s.start()
    try:
        for _ in range(3):
            s.feed(_block(model))
        out = await _drain(s, 3)
        assert len(out) == 3 and all(o.shape == (model.block_samples,) for o in out)
        stats = s.stats()
        assert stats["blocks_in"] == 3 and stats["blocks_out"] == 3 and stats["dropped_in"] == 0
    finally:
        s.stop()
    assert model.resets >= 1  # stop resets the stream


@pytest.mark.asyncio
async def test_a_slow_model_drops_the_oldest_input_instead_of_lagging():
    model = _Model(delay_s=0.3)
    model.configure(VCStreamParams(block_ms=100, gate_db=-90.0))
    s = vc_session.VCSession(model, asyncio.get_running_loop())
    s.start()
    try:
        for _ in range(8):
            s.feed(_block(model))
        assert s.stats()["queue_blocks"] <= vc_session.MAX_PENDING_BLOCKS
        assert s.dropped_in >= 8 - vc_session.MAX_PENDING_BLOCKS - 1
    finally:
        s.stop()


@pytest.mark.asyncio
async def test_a_slow_client_drops_the_oldest_output():
    model = _Model()
    model.configure(VCStreamParams(block_ms=100, gate_db=-90.0))
    s = vc_session.VCSession(model, asyncio.get_running_loop())
    s.start()
    try:
        for _ in range(3):
            for _ in range(3):
                s.feed(_block(model))
            await asyncio.sleep(0.15)  # nobody reads the outbox
        await asyncio.sleep(0.3)
        assert s.outbox.qsize() <= vc_session.MAX_OUTBOX_BLOCKS
        assert s.dropped_out >= 1
    finally:
        s.stop()


@pytest.mark.asyncio
async def test_input_much_faster_than_real_time_is_refused():
    model = _Model()
    model.configure(VCStreamParams(gate_db=-90.0))
    s = vc_session.VCSession(model, asyncio.get_running_loop())
    s.start()
    try:
        with pytest.raises(VCError) as err:
            for _ in range(10):
                s.feed(np.zeros(SR, dtype=np.float32))  # 10 s of audio, instantly
        assert err.value.code == "too_fast"
    finally:
        s.stop()


@pytest.mark.asyncio
async def test_engine_errors_reach_the_sender_as_typed_errors():
    model = _Model(fail=RuntimeError("CUDA out of memory\nTraceback ..."))
    model.configure(VCStreamParams(gate_db=-90.0))
    s = vc_session.VCSession(model, asyncio.get_running_loop())
    s.start()
    try:
        s.feed(_block(model))
        (item,) = await _drain(s, 1)
        assert item is None
        assert s.error.code == "engine_failed" and "Traceback" not in s.error.detail
    finally:
        s.stop()


def test_one_session_per_process():
    a, b = object(), object()
    assert vc_session.claim(a)
    try:
        assert not vc_session.claim(b) and vc_session.busy()
        vc_session.release(b)  # not the owner: no effect
        assert vc_session.busy()
    finally:
        vc_session.release(a)
    assert not vc_session.busy()
