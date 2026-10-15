import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeakToMic, type SpeakToMicDeps } from './speak-to-mic';

vi.mock('@/lib/api/websocket', () => ({ backendWebSocketUrl: vi.fn() }));

class FakeSocket {
  binaryType = '';
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}

function fakeContext(sampleRate: number) {
  const started: number[] = [];
  return {
    sampleRate,
    currentTime: 0,
    baseLatency: 0.01,
    outputLatency: 0.09,
    state: 'running',
    destination: {},
    started,
    setSinkId: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createBuffer: (_ch: number, length: number, rate: number) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => ({
      buffer: null,
      connect: vi.fn(),
      start: (at: number) => started.push(at),
      stop: vi.fn(),
    }),
  };
}

function setup() {
  const socket = new FakeSocket();
  const contexts: ReturnType<typeof fakeContext>[] = [];
  const deps: SpeakToMicDeps = {
    socketUrl: async () => 'ws://127.0.0.1:3900/ws/tts',
    openSocket: () => socket as unknown as WebSocket,
    createContext: (o) => {
      const ctx = fakeContext(o.sampleRate ?? 24000);
      contexts.push(ctx);
      return ctx as unknown as AudioContext;
    },
  };
  return { socket, contexts, speaker: new SpeakToMic(deps) };
}

// Microtask-only flush, so it works the same under fake timers.
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};
const pcm = (n: number) => new Int16Array(n).buffer;

describe('SpeakToMic', () => {
  afterEach(() => vi.useRealTimers());

  it('asks the TTS stream for the voice and routes the audio before playing any of it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { socket, contexts, speaker } = setup();
    const done = speaker.speak({ text: 'hello', profileId: 'mine', deviceId: 'cable', monitor: true });
    await flush();
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0])).toEqual({ text: 'hello', voice: 'mine' });
    socket.onmessage?.({ data: pcm(10) }); // arrives before "start": held, not played
    socket.onmessage?.({ data: JSON.stringify({ type: 'start', sample_rate: 24000 }) });
    await flush();
    expect(contexts[0].setSinkId).toHaveBeenCalledWith('cable');
    expect(contexts).toHaveLength(2); // mic + monitor on the default device
    expect(contexts[1].setSinkId).not.toHaveBeenCalled();
    socket.onmessage?.({ data: pcm(2400) });
    expect(contexts[0].started).toHaveLength(2);
    expect(contexts[1].started).toHaveLength(2);
    // The first syllable waits for the freshly routed device; the rest is gapless.
    expect(contexts[0].started[0]).toBeCloseTo(0.15);
    expect(contexts[0].started[1]).toBeCloseTo(0.15 + 10 / 24000);
    socket.onmessage?.({ data: JSON.stringify({ type: 'done' }) });
    await flush();
    // Due at 0.25 s, plus 0.1 s still in the device and the 0.25 s tail.
    await vi.advanceTimersByTimeAsync(550);
    expect(contexts.every((c) => c.close.mock.calls.length === 0)).toBe(true); // still playing out
    await vi.runAllTimersAsync();
    await done;
    expect(contexts.every((c) => c.close.mock.calls.length === 1)).toBe(true);
  });

  it('surfaces the backend error and releases the device', async () => {
    const { socket, contexts, speaker } = setup();
    const done = speaker.speak({ text: 'x', profileId: 'mine', deviceId: 'cable', monitor: false });
    await flush();
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: 'start', sample_rate: 24000 }) });
    await flush();
    socket.onmessage?.({ data: JSON.stringify({ type: 'error', detail: 'Engine unavailable' }) });
    await expect(done).rejects.toThrow('Engine unavailable');
    expect(contexts[0].close).toHaveBeenCalled();
  });

  it('stop ends the message quietly', async () => {
    const { socket, speaker } = setup();
    const done = speaker.speak({ text: 'x', profileId: 'mine', deviceId: '', monitor: false });
    await flush();
    speaker.stop();
    await expect(done).resolves.toBeUndefined();
    expect(socket.closed).toBe(true);
  });
});
