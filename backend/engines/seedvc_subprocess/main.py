"""seed-vc sidecar: Seed-VC real-time conversion in the engine's own venv.

Launched as ``<engine venv python> main.py`` by ``SeedVCSidecar``. It imports
nothing from the app. Seed-VC's source (Plachtaa/seed-vc, GPL-3.0) is not
vendored: the installer checks out a reviewed commit and points
``OMNIVOICE_SEEDVC_DIR`` at it, and this file puts that checkout on
``sys.path`` the way upstream's own scripts expect. Must stay importable with
the standard library alone until a request arrives.

Wire protocol: length-prefixed JSON over stdio, like every sidecar. Audio is
base64 little-endian float32 mono at 22.05 kHz.

    → {"op": "ready", "engine": "seed-vc", "sample_rate": 22050}
    parent → {"op": "vc_prepare", "prompt_b64", "cache_dir", "cache_key"}
           ← {"op": "progress", ...}*  {"op": "vc_prepared", "device",
              "cached", "vram_mb"}
    parent → {"op": "vc_infer", "pcm_b64", "head_samples", "out_samples",
              "tail_samples", "steps", "cfg_rate"}
           ← {"op": "vc_audio", "pcm_b64", "n_samples", "infer_ms"}
    parent → {"op": "ping"} ← {"op": "pong", "vram_mb"}
    parent → {"op": "shutdown"}

The window framing (context, look-ahead, crossfade) is the parent's; this
process converts one window and returns the slice it was asked for, so it is
stateless apart from the loaded model and the prepared target voice.
"""
from __future__ import annotations

import base64
import contextlib
import json
import os
import re
import struct
import sys
import threading
import time
import traceback

MAX_FRAME_BYTES = 64 * 1024 * 1024
SAMPLE_RATE = 22_050
#: Content features run at 50 frames/s (16 kHz, hop 320); windows are whole frames.
FRAME = SAMPLE_RATE // 50
#: Left context the diffusion model itself sees; the content encoder sees the
#: whole window head. Upstream's real-time defaults (extra_time = 0.5 s).
DIT_CONTEXT_FRAMES = 25
#: A window longer than this is not a live block (bounds memory per request).
MAX_WINDOW_SAMPLES = 12 * SAMPLE_RATE
_HEARTBEAT_S = 5.0
_CACHE_KEY_RE = re.compile(r"^[0-9a-f]{32}-[0-9]{1,6}$")
_CACHE_KEEP = 32

#: Weights fetched from Hugging Face on the first prepare (pinned by file).
#: The CAM++ speaker encoder ships inside the reviewed checkout itself.
DIT_REPO = "Plachta/Seed-VC"
DIT_FILE = "DiT_uvit_tat_xlsr_ema.pth"
HIFT_REPO = "FunAudioLLM/CosyVoice-300M"
HIFT_FILE = "hift.pt"
XLSR_REPO = "facebook/wav2vec2-xls-r-300m"
XLSR_FILES = ["config.json", "preprocessor_config.json", "pytorch_model.bin"]
#: Hugging Face revision per repo. ``None`` downloads the default branch: the
#: commits could not be resolved when this engine was integrated (Hugging Face
#: was unreachable from the build environment). Pin real SHAs here before any
#: distribution; docs/engines/seed-vc.md and model_licenses.json say the same.
REVISIONS = {DIT_REPO: None, HIFT_REPO: None, XLSR_REPO: None}
CONFIG = os.path.join("configs", "presets", "config_dit_mel_seed_uvit_xlsr_tiny.yml")
HIFT_CONFIG = os.path.join("configs", "hifigan.yml")
CAMPPLUS_FILE = "campplus_cn_common.bin"

_send_lock = threading.Lock()
_MODEL = None
_TARGET = None


# -- wire protocol -----------------------------------------------------------


def _send(stream, obj: dict) -> None:
    body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    with _send_lock:
        stream.write(struct.pack("!I", len(body)))
        stream.write(body)
        stream.flush()


def _recv(stream):
    header = stream.read(4)
    if len(header) < 4:
        return None
    (n,) = struct.unpack("!I", header)
    if n > MAX_FRAME_BYTES:
        raise IOError(f"frame too large: {n}")
    body = bytearray()
    while len(body) < n:
        chunk = stream.read(n - len(body))
        if not chunk:
            raise IOError("short read")
        body.extend(chunk)
    return json.loads(bytes(body).decode("utf-8"))


@contextlib.contextmanager
def _heartbeating(stdout, stage: str):
    """Progress frames while a long call runs, so the parent's receive
    watchdog sees a healthy sidecar during a multi-GB first download."""
    stop = threading.Event()

    def _beat() -> None:
        pct = 1
        while not stop.wait(_HEARTBEAT_S):
            pct = min(pct + 1, 99)
            _send(stdout, {"op": "progress", "stage": stage, "percent": pct})

    thread = threading.Thread(target=_beat, daemon=True)
    thread.start()
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=_HEARTBEAT_S + 1)


# -- audio helpers -----------------------------------------------------------


def _decode(b64: str, limit: int):
    import numpy as np

    raw = base64.b64decode(b64 or "", validate=True)
    if len(raw) % 4 or len(raw) // 4 > limit:
        raise ValueError("audio payload has the wrong size")
    pcm = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    if not np.isfinite(pcm).all():
        raise ValueError("audio payload is not finite")
    return pcm


def _encode(pcm) -> str:
    import numpy as np

    return base64.b64encode(np.ascontiguousarray(pcm, dtype="<f4").tobytes()).decode("ascii")


def _vram_mb() -> float:
    try:
        import torch

        if torch.cuda.is_available():
            return float(torch.cuda.memory_allocated()) / (1024 * 1024)
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return float(torch.mps.current_allocated_memory()) / (1024 * 1024)
    except Exception:  # noqa: BLE001 — a probe, never fatal
        pass
    return 0.0


def _sync(device) -> None:
    import torch

    if device.type == "cuda":
        torch.cuda.synchronize()
    elif device.type == "mps":
        torch.mps.synchronize()


# -- model -------------------------------------------------------------------


def _checkout() -> str:
    root = os.environ.get("OMNIVOICE_SEEDVC_DIR", "").strip()
    if not root or not os.path.isfile(os.path.join(root, "modules", "commons.py")):
        raise RuntimeError("Seed-VC source is missing; reinstall it from Live Voice")
    if root not in sys.path:
        sys.path.insert(0, root)
    return root


def _stub_dac() -> None:
    """Seed-VC's length regulator imports ``dac`` at module level for an
    optional vector quantizer the real-time model does not use
    (``vector_quantize: false``). descript-audio-codec pulls an old protobuf
    and a training stack, so it is not installed; this stub satisfies the
    import and fails loudly if a config ever enables the quantizer."""
    try:
        import dac.nn.quantize  # noqa: F401
        return
    except ImportError:
        pass
    import types

    class VectorQuantize:  # noqa: D401 — placeholder
        def __init__(self, *args, **kwargs):
            raise RuntimeError("this Seed-VC config needs descript-audio-codec")

    pkg, nn, quantize = (types.ModuleType(n) for n in ("dac", "dac.nn", "dac.nn.quantize"))
    quantize.VectorQuantize = VectorQuantize
    pkg.nn, nn.quantize = nn, quantize
    sys.modules.update({"dac": pkg, "dac.nn": nn, "dac.nn.quantize": quantize})


def _pick_device():
    import torch

    wanted = os.environ.get("OMNIVOICE_DEVICE", "").strip().lower()
    mps = getattr(torch.backends, "mps", None)
    has_mps = bool(mps and mps.is_available())
    if wanted == "cpu":
        return torch.device("cpu")
    if wanted in ("cuda", "rocm") and torch.cuda.is_available():
        return torch.device("cuda")
    if wanted == "mps" and has_mps:
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    if has_mps:
        return torch.device("mps")
    return torch.device("cpu")


def _fetch(repo: str, filename: str) -> str:
    from huggingface_hub import hf_hub_download

    revision = REVISIONS.get(repo)
    try:
        return hf_hub_download(repo, filename, revision=revision, local_files_only=True)  # nosec B615 -- revision from REVISIONS
    except Exception:  # noqa: BLE001 — not cached yet
        return hf_hub_download(repo, filename, revision=revision)  # nosec B615 -- revision from REVISIONS


def _fetch_xlsr() -> str:
    from huggingface_hub import snapshot_download

    revision = REVISIONS.get(XLSR_REPO)
    try:
        return snapshot_download(XLSR_REPO, revision=revision, allow_patterns=XLSR_FILES,  # nosec B615 -- revision from REVISIONS
                                 local_files_only=True)
    except Exception:  # noqa: BLE001 — not cached yet
        return snapshot_download(XLSR_REPO, revision=revision, allow_patterns=XLSR_FILES)  # nosec B615 -- revision from REVISIONS


def _load_state(model, path):
    """Upstream's checkpoint layout (``state["net"][module]``), read with
    ``weights_only=True`` and shape-checked per tensor like upstream does."""
    import torch

    state = torch.load(path, map_location="cpu", weights_only=True)
    params = state["net"]
    for key in model:
        if key not in params:
            continue
        own = model[key].state_dict()
        loaded = {}
        for name, value in params[key].items():
            name = name[len("module."):] if name.startswith("module.") else name
            if name in own and getattr(value, "shape", None) == own[name].shape:
                loaded[name] = value
        model[key].load_state_dict(loaded, strict=False)


def build_model(device, weights: dict):
    """Seed-VC's real-time stack on ``device``. ``weights`` maps "dit",
    "hift", "xlsr" and "campplus" to local paths, or to ``None`` for random
    initialisation (used by the CPU benchmark when weights are unreachable)."""
    import torch
    import yaml

    root = _checkout()
    _stub_dac()
    from modules.audio import mel_spectrogram
    from modules.campplus.DTDNN import CAMPPlus
    from modules.commons import build_model as build_seedvc, recursive_munch
    from modules.hifigan.f0_predictor import ConvRNNF0Predictor
    from modules.hifigan.generator import HiFTGenerator
    from transformers import Wav2Vec2Config, Wav2Vec2FeatureExtractor, Wav2Vec2Model

    with open(os.path.join(root, CONFIG), encoding="utf-8") as fh:
        config = yaml.safe_load(fh)
    params = recursive_munch(config["model_params"])
    params.dit_type = "DiT"
    model = build_seedvc(params, stage="DiT")
    if weights.get("dit"):
        _load_state(model, weights["dit"])
    for key in model:
        model[key].eval().to(device)
    model.cfm.estimator.setup_caches(max_batch_size=1, max_seq_length=8192)

    campplus = CAMPPlus(feat_dim=80, embedding_size=192)
    if weights.get("campplus"):
        campplus.load_state_dict(torch.load(weights["campplus"], map_location="cpu", weights_only=True))
    campplus.eval().to(device)

    with open(os.path.join(root, HIFT_CONFIG), encoding="utf-8") as fh:
        hift_config = yaml.safe_load(fh)
    hift = HiFTGenerator(**hift_config["hift"], f0_predictor=ConvRNNF0Predictor(**hift_config["f0_predictor"]))
    if weights.get("hift"):
        hift.load_state_dict(torch.load(weights["hift"], map_location="cpu", weights_only=True))
    hift.eval().to(device)

    layers = int(config["model_params"]["speech_tokenizer"]["output_layer"])
    if weights.get("xlsr"):
        # A local snapshot directory from _fetch_xlsr, never a hub id.
        extractor = Wav2Vec2FeatureExtractor.from_pretrained(weights["xlsr"])  # nosec B615 -- local directory
        xlsr = Wav2Vec2Model.from_pretrained(weights["xlsr"])  # nosec B615 -- local directory
    else:
        extractor = Wav2Vec2FeatureExtractor(feature_size=1, sampling_rate=16000, do_normalize=True,
                                             return_attention_mask=True)
        xlsr = Wav2Vec2Model(Wav2Vec2Config(
            hidden_size=1024, num_hidden_layers=24, num_attention_heads=16, intermediate_size=4096,
            feat_extract_norm="layer", do_stable_layer_norm=True, conv_bias=True,
        ))
    xlsr.encoder.layers = xlsr.encoder.layers[:layers]
    half = device.type in ("cuda", "mps")
    xlsr = xlsr.to(device).eval()
    if half:
        xlsr = xlsr.half()

    def semantic_fn(waves_16k):
        inputs = extractor([waves_16k[0].cpu().numpy()], return_tensors="pt",
                           return_attention_mask=True, padding=True, sampling_rate=16000).to(device)
        values = inputs.input_values.half() if half else inputs.input_values
        return xlsr(values).last_hidden_state.float()

    spect = config["preprocess_params"]["spect_params"]
    mel_args = {
        "n_fft": spect["n_fft"], "win_size": spect["win_length"], "hop_size": spect["hop_length"],
        "num_mels": spect["n_mels"], "sampling_rate": config["preprocess_params"]["sr"],
        "fmin": spect.get("fmin", 0),
        "fmax": None if spect.get("fmax", "None") == "None" else 8000, "center": False,
    }
    return {
        "device": device, "model": model, "campplus": campplus, "vocoder": hift,
        "semantic_fn": semantic_fn, "to_mel": lambda x: mel_spectrogram(x, **mel_args),
        "hop": spect["hop_length"], "fp16": device.type == "cuda",
    }


def _load(stdout):
    global _MODEL
    if _MODEL is not None:
        return _MODEL
    _send(stdout, {"op": "progress", "stage": "loading_model", "percent": 0})
    with _heartbeating(stdout, "loading_model"):
        import torch

        threads = os.environ.get("OMNIVOICE_VC_THREADS", "").strip()
        if threads.isdigit() and int(threads) > 0:
            torch.set_num_threads(int(threads))
        root = _checkout()
        weights = {
            "dit": _fetch(DIT_REPO, DIT_FILE),
            "hift": _fetch(HIFT_REPO, HIFT_FILE),
            "xlsr": _fetch_xlsr(),
            "campplus": os.path.join(root, CAMPPLUS_FILE),
        }
        with torch.inference_mode():
            _MODEL = build_model(_pick_device(), weights)
    _send(stdout, {"op": "progress", "stage": "loading_model", "percent": 100})
    return _MODEL


def compute_target(m, prompt):
    """Seed-VC's prompt condition for a reference clip (float32 numpy)."""
    import torch
    import torchaudio

    device = m["device"]
    ref = torch.from_numpy(prompt).to(device)
    ref_16k = torchaudio.functional.resample(ref, SAMPLE_RATE, 16000)
    s_ori = m["semantic_fn"](ref_16k.unsqueeze(0))
    feat = torchaudio.compliance.kaldi.fbank(ref_16k.unsqueeze(0), num_mel_bins=80, dither=0,
                                             sample_frequency=16000)
    feat = feat - feat.mean(dim=0, keepdim=True)
    style = m["campplus"](feat.unsqueeze(0))
    mel = m["to_mel"](ref.unsqueeze(0))
    lengths = torch.LongTensor([mel.size(2)]).to(device)
    condition = m["model"].length_regulator(s_ori, ylens=lengths, n_quantizers=3, f0=None)[0]
    return {"prompt_condition": condition, "mel2": mel, "style2": style}


def convert_window(m, target, window, head, out, tail, steps, cfg_rate):
    """Convert one window and return ``out`` samples aligned with
    ``window[head:head + out]`` (Seed-VC's real-time inference)."""
    import torch
    import torchaudio

    device = m["device"]
    wave = torch.from_numpy(window).to(device)
    s_alt = m["semantic_fn"](torchaudio.functional.resample(wave, SAMPLE_RATE, 16000).unsqueeze(0))
    head_f, out_f, tail_f = head // FRAME, out // FRAME, tail // FRAME
    skip = max(0, head_f - DIT_CONTEXT_FRAMES)
    s_alt = s_alt[:, skip:]
    mel_frames = int((head_f + out_f + tail_f - skip) / 50 * SAMPLE_RATE // m["hop"])
    cond = m["model"].length_regulator(
        s_alt, ylens=torch.LongTensor([mel_frames]).to(device), n_quantizers=3, f0=None
    )[0]
    prompt = target["prompt_condition"]
    cat = torch.cat([prompt, cond], dim=1)
    mel2 = target["mel2"]
    with torch.autocast(device_type=device.type, dtype=torch.float16, enabled=m["fp16"]):
        mel = m["model"].cfm.inference(
            cat, torch.LongTensor([cat.size(1)]).to(device), mel2, target["style2"], None,
            n_timesteps=int(steps), inference_cfg_rate=float(cfg_rate),
        )
        mel = mel[:, :, mel2.size(-1):]
        wav = m["vocoder"](mel.float()).squeeze().float()
    end = wav.shape[-1] - tail
    piece = wav[max(0, end - out):max(0, end)]
    result = torch.zeros(out, dtype=torch.float32, device=piece.device)
    if piece.numel():
        result[out - piece.numel():] = piece
    return result.clamp(-1.0, 1.0).cpu().numpy()


# -- request handlers --------------------------------------------------------


def _cache_path(msg: dict):
    key = str(msg.get("cache_key") or "")
    folder = str(msg.get("cache_dir") or "")
    if not _CACHE_KEY_RE.match(key) or not folder or not os.path.isdir(folder):
        return None
    return os.path.join(folder, f"{key}.pt")


def _prune_cache(folder: str) -> None:
    try:
        entries = sorted(
            (e for e in os.scandir(folder) if e.is_file() and e.name.endswith(".pt")),
            key=lambda e: e.stat().st_mtime, reverse=True,
        )
        for entry in entries[_CACHE_KEEP:]:
            os.unlink(entry.path)
    except OSError:
        pass


def _handle_prepare(msg: dict, stdout) -> None:
    global _TARGET
    import torch

    m = _load(stdout)
    path = _cache_path(msg)
    cached = False
    target = None
    if path and os.path.isfile(path):
        try:
            loaded = torch.load(path, map_location="cpu", weights_only=True)
            target = {k: loaded[k].to(m["device"]) for k in ("prompt_condition", "mel2", "style2")}
            cached = True
        except Exception:  # noqa: BLE001 — a bad cache entry is recomputed
            target = None
    if target is None:
        prompt = _decode(msg.get("prompt_b64"), 30 * SAMPLE_RATE)
        with torch.inference_mode(), _heartbeating(stdout, "preparing_voice"):
            target = compute_target(m, prompt)
        if path:
            tmp = f"{path}.tmp"
            torch.save({k: v.detach().cpu() for k, v in target.items()}, tmp)
            os.replace(tmp, path)
            _prune_cache(os.path.dirname(path))
    _TARGET = target
    _send(stdout, {"op": "vc_prepared", "device": m["device"].type, "cached": cached,
                   "vram_mb": _vram_mb()})


def _handle_infer(msg: dict, stdout) -> None:
    import torch

    if _MODEL is None or _TARGET is None:
        raise RuntimeError("no target voice prepared")
    head, out, tail = (int(msg.get(k, -1)) for k in ("head_samples", "out_samples", "tail_samples"))
    if min(head, out, tail) < 0 or out == 0 or any(v % FRAME for v in (head, out, tail)):
        raise ValueError("window sizes must be whole 20 ms frames")
    window = _decode(msg.get("pcm_b64"), MAX_WINDOW_SAMPLES)
    if window.shape[0] != head + out + tail:
        raise ValueError("window length does not match its sizes")
    steps = min(30, max(1, int(msg.get("steps", 10))))
    cfg_rate = min(1.0, max(0.0, float(msg.get("cfg_rate", 0.7))))
    t0 = time.perf_counter()
    with torch.inference_mode():
        pcm = convert_window(_MODEL, _TARGET, window, head, out, tail, steps, cfg_rate)
        _sync(_MODEL["device"])
    _send(stdout, {"op": "vc_audio", "pcm_b64": _encode(pcm), "n_samples": int(pcm.shape[0]),
                   "infer_ms": round((time.perf_counter() - t0) * 1000.0, 1)})


def main() -> int:
    # Upstream's sampler draws a tqdm bar per inference: several per second
    # in a live session, all of it log noise.
    os.environ.setdefault("TQDM_DISABLE", "1")
    stdin = sys.stdin.buffer
    # Frames go down a private fd; fd 1 is pointed at stderr (#1428) so
    # library prints (tqdm, torch) cannot corrupt the frame stream.
    _frame_fd = os.dup(1)
    os.dup2(2, 1)
    stdout = os.fdopen(_frame_fd, "wb")
    _send(stdout, {"op": "ready", "engine": "seed-vc", "sample_rate": SAMPLE_RATE})
    while True:
        try:
            msg = _recv(stdin)
        except Exception as exc:  # noqa: BLE001
            _send(stdout, {"op": "error", "stage": "recv", "message": f"{type(exc).__name__}: {exc}"})
            return 1
        if msg is None:
            return 0
        op = msg.get("op") if isinstance(msg, dict) else None
        try:
            if op == "ping":
                _send(stdout, {"op": "pong", "vram_mb": _vram_mb()})
            elif op == "vc_prepare":
                _handle_prepare(msg, stdout)
            elif op == "vc_infer":
                _handle_infer(msg, stdout)
            elif op == "shutdown":
                return 0
            else:
                _send(stdout, {"op": "error", "stage": "dispatch", "message": f"unknown op: {op!r}"})
        except Exception as exc:  # noqa: BLE001
            _send(stdout, {
                "op": "error", "stage": op or "unknown",
                "message": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc(),
            })


if __name__ == "__main__":
    sys.exit(main())
