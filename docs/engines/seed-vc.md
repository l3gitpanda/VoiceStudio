# Seed-VC (Live Voice engine)

[Seed-VC](https://github.com/Plachtaa/seed-vc) is a zero-shot voice
conversion model: give it 1–30 seconds of a target voice and it re-speaks any
input speech in that voice. VoiceStudio uses its real-time checkpoint,
`seed-uvit-tat-xlsr-tiny`, as the engine behind [Live Voice](../features/live-voice.md).
It is not a text-to-speech engine and does not appear in Model Catalogue.

| | |
|---|---|
| Job | Real-time voice conversion (live mic → saved voice) |
| Runs on | CUDA · MPS · CPU (CPU with ≥ 1 s latency); not Intel Mac |
| Installed by | Live Voice → **Install** (one-click sidecar) |
| Source | `Plachtaa/seed-vc` at `51383efd921027683c89e5348211d93ff12ac2a8` (2025-04-20) |
| Python | 3.10 venv in `<data dir>/engines/seed-vc/seed-vc/.venv` |
| PyTorch | 2.7.0 (`+cu128` on NVIDIA, `+cpu` on other Windows/Linux, regular build on macOS) |
| Disk | ~0.1 GB source + ~7 GB venv (CUDA) + ~1.5 GB weights |
| Sample rate | 22.05 kHz in and out |

## Licences

| Component | Where it comes from | Licence |
|---|---|---|
| Seed-VC code | the reviewed checkout | GPL-3.0 |
| DiT checkpoint `DiT_uvit_tat_xlsr_ema.pth` | `Plachta/Seed-VC` on Hugging Face | GPL-3.0 per its model card (not re-checked: Hugging Face was unreachable from the build environment) |
| Content encoder (first 12 layers of XLS-R 300M) | `facebook/wav2vec2-xls-r-300m` | Apache-2.0 (model card) |
| HiFT vocoder `hift.pt` | `FunAudioLLM/CosyVoice-300M` | Apache-2.0 (model card) |
| CAM++ speaker encoder `campplus_cn_common.bin` | shipped in the checkout (same file as `funasr/campplus`) | Apache-2.0 (model card) |

Seed-VC's code and checkpoint are copyleft. Nothing from it is vendored into
this repository: the installer fetches it when the user opts in, and the
sidecar loads it from that checkout at run time. The records live in
`backend/config/model_licenses.json`, all marked *unreviewed*. The Hugging Face
weights are downloaded unpinned (latest revision) on the first session,
because Hugging Face was unreachable when this integration was written. Pin
them before any distribution.

## What differs from upstream

- **Trimmed requirements** (`backend/engines/seedvc_subprocess/requirements.txt`):
  - Upstream's UIs and audio I/O are gone (gradio, FreeSimpleGUI, sounddevice), as are its ASR/VAD (funasr, modelscope) and its evaluation tools.
  - `transformers` is raised to the same advisory floor CosyVoice's sidecar holds.
- **No `descript-audio-codec`.** Seed-VC imports it only for a vector
  quantizer that the real-time model disables. The package pins an old
  protobuf, so the sidecar stubs the import instead (`_stub_dac`). The stub
  raises if a config ever needs the quantizer.
- **`weights_only=True` checkpoint loading** with upstream's per-tensor shape check.
- **No tqdm output.** The bars are suppressed so live sessions don't flood the log.
- **Framing lives in VoiceStudio, not in upstream's GUI.** The sidecar converts
  one window per request; context, look-ahead and SOLA crossfading are in
  `backend/services/vc/streamer.py`.
- **Silence gating is an RMS gate, not upstream's FSMN VAD.** It skips the
  model for blocks quieter than `gate_db`.

## Verified and not yet verified

Verified in CI and in this fork's build environment:
- The adapter contract and the whole WebSocket path, against the stub sidecar
  (`tests/backend/engines/test_seedvc_subprocess.py`, `tests/test_vc_stream_ws.py`).
- The real sidecar code building Seed-VC's network from the pinned checkout
  and converting windows on CPU, with random weights.
- CPU timing (see [Live Voice → Latency](../features/live-voice.md#latency-and-hardware)).

Not yet verified:
- Audio quality with the real weights.
- GPU timing and VRAM.
- MPS and ROCm.
- The one-click install on Windows and macOS.
- Clock drift with real virtual cables over long sessions.

## Troubleshooting

- **Install fails at "verify".** The import probe could not load Seed-VC's
  modules. The install log names the missing package; reinstall from Live Voice.
- **First start takes minutes.** It is downloading ~1.5 GB of weights. Progress
  frames keep the session alive for up to `OMNIVOICE_SEEDVC_RECV_TIMEOUT_S`.
- **Uninstall:** `DELETE /engines/sidecar/seed-vc/install` (the same route
  other sidecar engines use) removes `<data dir>/engines/seed-vc/`. Cached
  target voices are in `<data dir>/vc_cache/seed-vc/`.
