# Live Voice — real-time voice changer

Speak into your microphone and hear yourself, live, in one of your saved
voices. The converted audio plays on any output device you pick, so a virtual
audio cable can feed it into Discord, VRChat, a game or a stream as if it were
a microphone. Generated clips and typed messages can go
[into the same microphone](#use-your-voices-as-a-microphone).

Live Voice is **opt-in and off by default** on every platform. It is an
experimental workspace of this fork, built on [Seed-VC](../engines/seed-vc.md).

## Turn it on

1. **Settings → Live Voice → Live Voice (experimental)**, or start the backend
   with `OMNIVOICE_REALTIME_VC=1` (the environment variable wins and pins the
   switch).
2. Open **Live Voice** in the sidebar and click **Install** — the engine goes
   into its own environment under `<data dir>/engines/seed-vc/` (about 10 GB
   with PyTorch). Not offered on Intel Macs (no PyTorch build), which use the
   app UI with a remote backend anyway.
3. The first **Start** downloads about 1.5 GB of model weights from Hugging
   Face (the DiT checkpoint, the XLS-R content encoder, the HiFT vocoder).
   After that everything runs offline.

## Use it

| Control | What it does |
|---|---|
| Microphone | The input device. Browser voice processing (echo cancellation, noise suppression, auto gain) is turned off — raw voice converts best. |
| Output device | Where the converted voice plays — pick your virtual cable here. Uses the standard `setSinkId` API on every OS. |
| Target voice | Your own **verified** voice or a **designed** voice (see Consent). |
| Quality | **Automatic** (balanced on a GPU, CPU settings without one), **Fastest**, **Balanced**, **Best quality**, **CPU**. |
| Bypass | Plays your own voice instead and pauses conversion. |
| Monitor | Also plays the converted voice on your default speakers or headphones (only when a separate output device is chosen). Use headphones — speakers feed back into the mic. |

The latency panel shows what each stage costs while you talk: framing
(block + crossfade + look-ahead), model time per block (median / p95), the
real-time factor, the playback buffer, the output device, dropped blocks and
playback gaps, plus an estimated total. A real-time factor at or above 1
means the model cannot keep up; pick a faster quality.

## Use it in other apps (virtual cables)

VoiceStudio never bundles or installs audio drivers. Install one yourself,
choose it as Live Voice's **output device**, then choose its other end as the
**microphone** in the other app:

| OS | Cable | Output here | Microphone there |
|---|---|---|---|
| Windows | [VB-Audio Virtual Cable](https://vb-audio.com/Cable/) | `CABLE Input` | `CABLE Output` |
| macOS | [BlackHole](https://github.com/ExistentialAudio/BlackHole) | `BlackHole 2ch` | `BlackHole 2ch` |
| Linux | [PipeWire null sink](https://docs.pipewire.org/page_module_null_sink.html) — `pactl load-module module-null-sink sink_name=voicestudio` | `voicestudio` | `Monitor of voicestudio` |

## Use your voices as a microphone

The virtual cable is not only for the live voice changer. Choose it once in
**Settings → Live Voice → Virtual microphone** (the same device as Live
Voice's output) and two more ways to talk through it appear:

- **Play into mic** — a button next to Save on generated audio in Clone and
  Design, in a take's details, and on a Tools → Convert result. It plays that
  clip into the virtual microphone, so Discord or a game hears it as your mic.
  Click it again to stop. The button stays hidden until a virtual microphone
  is chosen.
- **Type to talk** — on the Live Voice page. Type a message and press Enter;
  it is spoken in the selected target voice straight into the virtual
  microphone, sentence by sentence through the active TTS engine (the Seed-VC
  engine does not need to be installed). **Monitor** also plays it on your
  default device.

Type to talk offers the same voices as Live Voice (your verified voice or a
designed one); Play into mic plays audio you already generated. Both come from
the normal generation path, so they follow **Settings → Privacy → invisible
watermark** like any other generated audio.

## Consent

Live Voice speaks *as* someone in real time, so it uses the same rule as
outbound phone calls (`backend/core/voice_consent.py`): only your own voice,
verified with the spoken consent statement (**Voices → profile → Verify it's
you**), or a designed voice that belongs to no real person. Gallery, community
and archetype voices are refused until verified. The backend enforces this;
the UI only mirrors it.

**Live Voice output is not watermarked** (a decision for this fork). Every
other output path still follows **Settings → Privacy → invisible watermark**.

## Latency and hardware

Measured with `scripts/bench_realtime_vc.py` (see Measuring). The GPU figures
come from Seed-VC's own published benchmark; they have not been re-measured
in this fork yet.

| Host | Settings | Model time per block | Real-time factor | Estimated mic → output |
|---|---|---|---|---|
| RTX 3060 Laptop (upstream figure) | 180 ms blocks, 10 steps | ~150 ms | ~0.83 | ~430 ms + device |
| 4 vCPU cloud VM, model only | 180 ms, 10 steps | 1219 ms (p95 1305) | 6.8 — cannot keep up | — |
| 4 vCPU cloud VM, model only | **CPU preset**: 800 ms, 4 steps, no guidance, 2 s prompt | 591 ms (p95 697) | 0.74 | ~1.5 s |
| 4 vCPU cloud VM, whole app over `/ws/vc` | CPU preset | 686 ms (p95 860) | 0.86 | ~1.6 s |

The CPU rows used random weights (same network and compute, no download).
Memory on CPU: about 2 GB for the engine process plus the app. Parent ↔
engine transport adds about 6 ms per block.

Without a GPU, **Automatic** switches to the CPU preset and shows a warning:
expect a second or more of delay. That is fine for monitoring or chat
messages, not for natural conversation. On Apple Silicon (MPS) the content
encoder runs in half precision; MPS has not been measured yet.

## How it works

```
mic ─▶ capture worklet ─▶ /ws/vc ─▶ session (bounded queues) ─▶ block streamer ─▶ Seed-VC sidecar
out ◀─ setSinkId ◀─ jitter buffer ◀─ /ws/vc ◀────────────── SOLA crossfade ◀──────── (one window)
```

- **Renderer** (`electron/src/renderer/src/lib/audio/live-vc/`): captures 20 ms
  frames at the model's 22.05 kHz through the shared `aec-frame-emitter`
  worklet and plays converted audio through `public/vc-playback-worklet.js`, a
  jitter buffer that keeps ~60 ms queued, drops back to that target when the
  microphone and output clocks drift apart, and counts underruns.
- **Backend** (`backend/services/vc/`): `BlockStreamer` keeps the left context
  and look-ahead, hands the model one window per block and joins the results
  with SOLA (offset search + sin² crossfade). `VCSession` runs one worker
  thread with drop-oldest queues in both directions so latency never grows.
  One session per backend.
- **Engine** (`backend/engines/seedvc_subprocess/`): a sidecar in its own venv,
  reached over the same length-prefixed JSON protocol as every other sidecar.
  It loads the model, prepares the target voice (cached under
  `<data dir>/vc_cache/seed-vc/`) and converts one window per request.

Another window-based converter can replace Seed-VC by implementing the
sidecar's `vc_prepare` / `vc_infer` ops behind `StreamingVCBackend`;
`OMNIVOICE_VC_ENGINE` selects among registered engines.

### `/ws/vc` protocol

Loopback, or a remote client with the API key / a path-bound `ws_ticket`
(same guard as `/ws/transcribe`).

| Direction | Frame |
|---|---|
| → | `{"type":"start","profile_id", block_ms?, crossfade_ms?, context_ms?, lookahead_ms?, steps?, cfg_rate?, max_prompt_s?, gate_db?}` — strict types, bounded, unknown keys refused, ≤ 4 KiB |
| ← | `{"type":"status","stage":"loading"}` then `{"type":"ready","sample_rate","block_samples","device","algorithmic_latency_ms","params","voice","warning"?}` |
| → | binary: mono int16 PCM at `sample_rate`, ≤ 1 s per frame |
| ← | binary: converted mono int16 PCM |
| ← | `{"type":"stats", ...}` about once a second |
| → | `{"type":"reset"}` · `{"type":"stop"}` |
| ← | `{"type":"error","code","detail"}`, then close: 1008 policy (disabled, consent, auth, too fast), 1009 oversized frame, 1011 engine failure, 1013 busy |

`GET /vc/status` reports whether Live Voice is on, installed and free, with the
parameter defaults and limits. `GET`/`PUT /api/settings/realtime-vc` is the
Settings switch.

## Measuring

```bash
# Model only, with the engine's own interpreter (GPU or CPU):
<data dir>/engines/seed-vc/seed-vc/.venv/bin/python scripts/bench_realtime_vc.py model \
    --seedvc-dir <data dir>/engines/seed-vc/seed-vc --device cuda

# The whole app path, against a running VoiceStudio with Live Voice on:
uv run python scripts/bench_realtime_vc.py ws --profile-id <voice id> --wav speech.wav
```

Both modes print the framing latency, model time per block (p50/p95), the
real-time factor and an estimate. `model` also prints peak RAM and VRAM. For a
true acoustic mic → output figure, record your microphone and the virtual
cable at the same time in a DAW and measure the offset between a hand clap
and its converted copy.

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `OMNIVOICE_REALTIME_VC` | unset (off) | `1` turns Live Voice on and pins the Settings switch |
| `OMNIVOICE_VC_ENGINE` | `seed-vc` | which registered voice-conversion engine to use |
| `OMNIVOICE_SEEDVC_DIR` | set by the installer | the Seed-VC checkout (and its `.venv`) |
| `OMNIVOICE_SEEDVC_RECV_TIMEOUT_S` | `900` | deadline for the first model load (progress frames re-arm it) |
| `OMNIVOICE_SEEDVC_INFER_TIMEOUT_S` | `30` | deadline for one window before the engine is treated as wedged |
| `OMNIVOICE_VC_THREADS` | torch default | CPU threads for the engine |
| `OMNIVOICE_DEVICE` | auto | pin `cuda`, `mps` or `cpu` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| No Live Voice in the sidebar | Turn it on in Settings → Live Voice. |
| No **Play into mic** button | Choose a virtual microphone in Settings → Live Voice → Virtual microphone. |
| Device names are blank | Click **Show device names** once (grants microphone access). |
| “Needs verification” on your voice | Verify it in Voices → profile → Verify it's you. |
| Choppy audio, “cannot keep up” | Pick **Fastest** or **CPU**; close other GPU work. |
| Echo or howling | Monitor plays on speakers — use headphones or turn Monitor off. |
| Delay grows over a long session | It should not: the playback buffer drops back to its target. If it does, report it with the latency panel's numbers. |
