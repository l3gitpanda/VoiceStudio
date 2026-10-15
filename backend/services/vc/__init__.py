"""Real-time voice conversion (the Live Voice workspace).

Text-to-speech engines (``services.tts_backend.TTSBackend``) turn text into
audio. A voice changer turns a live microphone stream into the same words in
another voice, block by block, so it has its own interface:

* ``base``     — ``VoiceConversionBackend`` and the stream parameters;
* ``streamer`` — model-agnostic block streaming (context ring + SOLA
  crossfade), so a model adapter only converts one window at a time;
* ``session``  — one live session: bounded queues, worker thread, stats;
* ``registry`` — model id → adapter class (Seed-VC today);
* ``targets``  — saved profile → reference clip, with the consent rule;
* ``gate``     — the opt-in switch (Settings toggle or env var), off by default.

The WebSocket that drives a session is ``api/routers/vc_stream.py``.
"""
