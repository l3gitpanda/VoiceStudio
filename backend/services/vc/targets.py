"""Saved voice profile → the reference clip a converter imitates.

Uses the same profile resolution as /generate and /convert (a locked take
wins, design profiles use their rendered sample). Any saved voice can be used,
as with every other local synthesis path in the app; outbound phone calls keep
their own rule (:func:`core.voice_consent.may_speak_as`).
"""
from __future__ import annotations

import hashlib
import os
import re

from services.vc.base import VCError, VCReference

#: Same shape profiles.py accepts for ids in its own routes.
PROFILE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_PROFILE_SQL = "SELECT * FROM voice_profiles WHERE id=?"


def _cache_key(path: str) -> str:
    st = os.stat(path)
    raw = f"{os.path.basename(path)}|{st.st_size}|{st.st_mtime_ns}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def resolve_target(profile_id: object) -> tuple[VCReference, str]:
    """Return the reference for ``profile_id`` and the profile's name.

    Raises :class:`VCError` with ``bad_request``, ``voice_not_found`` or
    ``voice_reference_missing``.
    """
    if not isinstance(profile_id, str) or not PROFILE_ID_RE.match(profile_id):
        raise VCError("bad_request", "Choose a saved voice.")
    from core.db import db_conn

    with db_conn() as conn:
        row = conn.execute(_PROFILE_SQL, (profile_id,)).fetchone()
    if row is None:
        raise VCError("voice_not_found", "That voice profile does not exist.")
    from api.routers.generation import _resolve_profile_conditioning

    path = _resolve_profile_conditioning(row).get("ref_audio_path")
    if not path or not os.path.isfile(path) or os.path.islink(path):
        raise VCError(
            "voice_reference_missing",
            "This voice has no reference audio yet. Open it in Voices first.",
        )
    return VCReference(path=path, cache_key=_cache_key(path)), str(row["name"] or "")


#: Leading/trailing audio quieter than this (dBFS, per 20 ms frame) is trimmed
#: before the prompt is cut, so a clip that opens with silence still yields
#: ``max_seconds`` of actual voice.
_SILENCE_DB = -45.0
#: Never decode more than this much of a reference (profiles may hold long clips).
_MAX_DECODE_S = 60.0


def load_reference_pcm(reference: VCReference, sample_rate: int, max_seconds: float):
    """The reference as mono float32 at ``sample_rate``, silence-trimmed and
    cut to ``max_seconds``. Decoding happens here (the app's ffmpeg-backed
    loader), so the sidecar receives samples and never opens user files."""
    import numpy as np
    import torch
    import torchaudio

    from core.voice_leases import VoiceFileLease
    from services.audio_io import load_audio

    with VoiceFileLease() as lease:
        wav, sr = load_audio(lease.hold(reference.path))
    wav = wav.to(torch.float32)
    if wav.dim() > 1:
        wav = wav.mean(dim=0)
    wav = wav[: int(_MAX_DECODE_S * sr)]
    if sr != sample_rate:
        wav = torchaudio.functional.resample(wav, sr, sample_rate)
    pcm = np.nan_to_num(wav.numpy().astype(np.float32))
    frame = max(1, sample_rate // 50)
    n = pcm.shape[0] // frame
    if n:
        rms = np.sqrt(np.mean(np.square(pcm[: n * frame].reshape(n, frame), dtype=np.float64), axis=1))
        loud = np.flatnonzero(rms >= 10.0 ** (_SILENCE_DB / 20.0))
        if loud.size:
            pcm = pcm[loud[0] * frame:(loud[-1] + 1) * frame]
    pcm = pcm[: int(max_seconds * sample_rate)]
    if pcm.shape[0] < sample_rate // 2:
        raise VCError("voice_reference_missing", "This voice's reference audio is too short or silent.")
    peak = float(np.max(np.abs(pcm))) or 1.0
    return (pcm / max(1.0, peak)).astype(np.float32)
