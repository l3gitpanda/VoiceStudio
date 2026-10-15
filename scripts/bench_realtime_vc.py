#!/usr/bin/env python3
"""Measure Live Voice (real-time voice conversion) latency and memory.

Two modes:

``model`` — time Seed-VC itself, the way a live session drives it. Run it with
the Seed-VC engine's own interpreter (the venv the installer made, normally
``<data dir>/engines/seed-vc/seed-vc/.venv``), because it imports torch and
Seed-VC::

    <seed-vc venv python> scripts/bench_realtime_vc.py model \\
        --seedvc-dir <data dir>/engines/seed-vc/seed-vc --device cuda

Weights come from the Hugging Face cache (downloaded by the first Live Voice
session). ``--random-weights`` builds the same network with random weights
instead: compute time and memory are identical, so it measures hardware
without a download (audio quality is meaningless then).

``ws`` — drive a running app over ``/ws/vc`` with a WAV file paced in real
time, and measure how long each converted block takes to come back::

    uv run python scripts/bench_realtime_vc.py ws --profile-id <id> --wav speech.wav

The app must have Live Voice turned on and Seed-VC installed. Both modes print
the framing (algorithmic) latency, model time per block (p50/p95), the
real-time factor and an estimated mic-to-output total; ``model`` also prints
peak RAM and VRAM. Output device latency is not measurable from here — the
estimate adds ``--device-ms`` (default 40) for it.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIDECAR = ROOT / "backend" / "engines" / "seedvc_subprocess" / "main.py"
INPUT_MS = 20.0  # capture-side device + browser buffering, as the UI assumes
WS_WARMUP_BLOCKS = 2


def _framing_ms(block_ms: int, crossfade_ms: int, lookahead_ms: int) -> float:
    # services.vc.streamer: block + crossfade + one 20 ms SOLA search frame + look-ahead
    return block_ms + crossfade_ms + 20 + lookahead_ms


def _report(label: str, framing: float, infer: list[float], block_ms: int, device_ms: float, extra: dict) -> None:
    infer = sorted(infer)
    p50 = statistics.median(infer)
    p95 = infer[int(0.95 * (len(infer) - 1))]
    result = {
        "mode": label,
        "block_ms": block_ms,
        "framing_ms": round(framing, 1),
        "infer_ms_p50": round(p50, 1),
        "infer_ms_p95": round(p95, 1),
        "rtf": round(p50 / block_ms, 3),
        "keeps_up": p95 < block_ms,
        "estimated_total_ms": round(INPUT_MS + framing + p50 + device_ms, 1),
        **extra,
    }
    print(json.dumps(result, indent=2))


def _load_sidecar():
    spec = importlib.util.spec_from_file_location("seedvc_sidecar", SIDECAR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_model(args) -> None:
    os.environ["OMNIVOICE_SEEDVC_DIR"] = str(Path(args.seedvc_dir).resolve())
    os.environ.setdefault("TQDM_DISABLE", "1")
    import numpy as np
    import torch

    sc = _load_sidecar()
    device = torch.device(args.device)
    root = sc._checkout()
    if args.random_weights:
        weights = {"campplus": os.path.join(root, sc.CAMPPLUS_FILE)}
    else:
        weights = {
            "dit": sc._fetch(sc.DIT_REPO, sc.DIT_FILE),
            "hift": sc._fetch(sc.HIFT_REPO, sc.HIFT_FILE),
            "xlsr": sc._fetch_xlsr(),
            "campplus": os.path.join(root, sc.CAMPPLUS_FILE),
        }
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats()
    t0 = time.perf_counter()
    with torch.inference_mode():
        model = sc.build_model(device, weights)
        load_s = time.perf_counter() - t0
        sr, frame = sc.SAMPLE_RATE, sc.FRAME
        t = np.arange(int(args.prompt_s * sr)) / sr
        target = sc.compute_target(model, (0.3 * np.sin(2 * np.pi * 180 * t)).astype(np.float32))
        head = round(args.context_ms / 20) * frame
        block = round(args.block_ms / 20) * frame
        out = block + round(args.crossfade_ms / 20) * frame + frame
        tail = round(args.lookahead_ms / 20) * frame
        rng = np.random.default_rng(0)
        window = (0.1 * rng.standard_normal(head + out + tail)).astype(np.float32)
        times = []
        for i in range(args.warmup + args.blocks):
            t1 = time.perf_counter()
            sc.convert_window(model, target, window, head, out, tail, args.steps, args.cfg_rate)
            sc._sync(device)
            if i >= args.warmup:
                times.append((time.perf_counter() - t1) * 1000.0)
    extra = {
        "device": device.type,
        "random_weights": bool(args.random_weights),
        "steps": args.steps,
        "cfg_rate": args.cfg_rate,
        "context_ms": args.context_ms,
        "prompt_s": args.prompt_s,
        "model_load_s": round(load_s, 1),
        "peak_rss_mb": _peak_rss_mb(),
        "torch_threads": torch.get_num_threads(),
    }
    if device.type == "cuda":
        extra["peak_vram_mb"] = round(torch.cuda.max_memory_allocated() / 2**20)
        extra["gpu"] = torch.cuda.get_device_name(0)
    _report("model", _framing_ms(args.block_ms, args.crossfade_ms, args.lookahead_ms), times,
            args.block_ms, args.device_ms, extra)


def _peak_rss_mb() -> int:
    try:
        import resource

        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return round(peak / 1024 if sys.platform != "darwin" else peak / 2**20)
    except ImportError:  # Windows
        try:
            import psutil

            return round(psutil.Process().memory_info().peak_wset / 2**20)
        except Exception:  # noqa: BLE001
            return -1


def run_ws(args) -> None:
    import asyncio

    import numpy as np
    import soundfile as sf
    import websockets

    audio, sr_in = sf.read(args.wav, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)

    async def go() -> None:
        async with websockets.connect(args.url, max_size=2**22) as ws:
            start = {"type": "start", "profile_id": args.profile_id, "block_ms": args.block_ms,
                     "steps": args.steps, "cfg_rate": args.cfg_rate, "context_ms": args.context_ms,
                     "max_prompt_s": args.prompt_s}
            await ws.send(json.dumps(start))
            while True:
                msg = json.loads(await ws.recv())
                if msg["type"] == "error":
                    raise SystemExit(f"{msg['code']}: {msg['detail']}")
                if msg["type"] == "ready":
                    break
            sr, block = msg["sample_rate"], msg["block_samples"]
            pcm = np.interp(np.arange(0, len(audio) * sr / sr_in) * sr_in / sr,
                            np.arange(len(audio)), audio).astype(np.float32)
            frame = sr // 50
            sent_at: list[float] = []
            lags: list[float] = []

            async def sender() -> None:
                t0 = time.perf_counter()
                for i in range(0, len(pcm) - frame, frame):
                    await asyncio.sleep(max(0.0, t0 + i / sr - time.perf_counter()))
                    await ws.send((np.clip(pcm[i:i + frame], -1, 1) * 32767).astype("<i2").tobytes())
                    if (i + frame) % block < frame:
                        sent_at.append(time.perf_counter())
                await asyncio.sleep(2.0)
                await ws.send(json.dumps({"type": "stop"}))

            async def receiver() -> None:
                got = 0
                async for message in ws:
                    if isinstance(message, bytes):
                        got += len(message) // 2
                        k = got // block - 1
                        if 0 <= k < len(sent_at):
                            lags.append((time.perf_counter() - sent_at[k]) * 1000.0)

            await asyncio.gather(sender(), receiver())
        lags = lags[WS_WARMUP_BLOCKS:]  # the first blocks include the model's warm-up
        if not lags:
            raise SystemExit("no converted audio came back")
        _report("ws", msg["algorithmic_latency_ms"], lags, round(1000 * block / sr), args.device_ms,
                {"device": msg["device"], "blocks": len(lags)})

    asyncio.run(go())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="mode", required=True)
    for name in ("model", "ws"):
        p = sub.add_parser(name)
        p.add_argument("--block-ms", type=int, default=180)
        p.add_argument("--context-ms", type=int, default=2500)
        p.add_argument("--steps", type=int, default=10)
        p.add_argument("--cfg-rate", type=float, default=0.7)
        p.add_argument("--prompt-s", type=float, default=3.0, help="reference length used for the target voice")
        p.add_argument("--device-ms", type=float, default=40.0,
                       help="output device + virtual cable latency to add to the estimate")
    m = sub.choices["model"]
    m.add_argument("--seedvc-dir", required=True, help="the Seed-VC checkout (OMNIVOICE_SEEDVC_DIR)")
    m.add_argument("--device", default="cpu")
    m.add_argument("--random-weights", action="store_true")
    m.add_argument("--crossfade-ms", type=int, default=40)
    m.add_argument("--lookahead-ms", type=int, default=20)
    m.add_argument("--blocks", type=int, default=10)
    m.add_argument("--warmup", type=int, default=2)
    w = sub.choices["ws"]
    w.add_argument("--url", default="ws://127.0.0.1:3900/ws/vc")
    w.add_argument("--profile-id", required=True)
    w.add_argument("--wav", required=True)
    args = parser.parse_args()
    run_model(args) if args.mode == "model" else run_ws(args)


if __name__ == "__main__":
    main()
