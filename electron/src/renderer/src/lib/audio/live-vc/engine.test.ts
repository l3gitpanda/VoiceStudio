import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveVoiceEngine, MAX_BUFFERED_BYTES, playbackBufferFor, type LiveVoiceDeps } from './engine';

vi.mock('@/lib/api/websocket', () => ({ backendWebSocketUrl: vi.fn() }));
vi.mock('@shared/utils/aec/micCapture', () => ({ startMicCapture: vi.fn() }));

class FakeSocket {
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  bufferedAmount = 0;
  sent: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  json(): unknown[] {
    return this.sent.filter((d): d is string => typeof d === 'string').map((d) => JSON.parse(d));
  }
  binary(): ArrayBuffer[] {
    return this.sent.filter((d): d is ArrayBuffer => d instanceof ArrayBuffer);
  }
}

const posted: { node: number; data: unknown }[] = [];
let nodes = 0;
class FakeNode {
  id = ++nodes;
  port = {
    onmessage: null as unknown,
    postMessage: (data: unknown) => posted.push({ node: this.id, data }),
  };
  connect = vi.fn();
  disconnect = vi.fn();
}

function fakeContext() {
  return {
    state: 'running',
    baseLatency: 0.01,
    outputLatency: 0.02,
    destination: {},
    audioWorklet: { addModule: vi.fn(async () => {}) },
    setSinkId: vi.fn(async () => {}),
    createMediaStreamDestination: vi.fn(),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

const READY = {
  type: 'ready',
  engine: 'seed-vc',
  sample_rate: 22050,
  block_samples: 3969,
  device: 'cuda',
  algorithmic_latency_ms: 260,
  params: {},
  voice: { id: 'me', name: 'Me', ref_seconds: 3 },
};

function setup(overrides: Partial<LiveVoiceDeps> = {}) {
  const socket = new FakeSocket();
  const contexts: ReturnType<typeof fakeContext>[] = [];
  const track = { stop: vi.fn() };
  let onFrame: (frame: Float32Array) => void = () => {};
  const stopCapture = vi.fn(async () => {});
  const deps: LiveVoiceDeps = {
    socketUrl: async () => 'ws://127.0.0.1:3900/ws/vc',
    openSocket: () => socket as unknown as WebSocket,
    getUserMedia: vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream),
    startCapture: vi.fn(async (_s, cb) => {
      onFrame = cb;
      return stopCapture;
    }),
    createContext: () => {
      const ctx = fakeContext();
      contexts.push(ctx);
      return ctx as unknown as AudioContext;
    },
    createAudioElement: vi.fn(),
    ...overrides,
  };
  const callbacks = {
    onStage: vi.fn(),
    onReady: vi.fn(),
    onStats: vi.fn(),
    onPlayback: vi.fn(),
    onError: vi.fn(),
    onStopped: vi.fn(),
  };
  const engine = new LiveVoiceEngine(callbacks, deps);
  return { socket, contexts, track, deps, callbacks, engine, stopCapture, frame: (f: Float32Array) => onFrame(f) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(opts: Partial<Parameters<LiveVoiceEngine['start']>[0]> = {}) {
  const env = setup();
  await env.engine.start({
    profileId: 'me',
    inputDeviceId: 'mic-1',
    outputDeviceId: 'cable-1',
    monitor: false,
    bypass: false,
    params: { block_ms: 180, steps: 4 },
    ...opts,
  });
  env.socket.open();
  env.socket.message(JSON.stringify({ type: 'status', stage: 'loading' }));
  env.socket.message(JSON.stringify(READY));
  await flush();
  await flush();
  return env;
}

beforeEach(() => {
  posted.length = 0;
  nodes = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('AudioWorkletNode', FakeNode);
});
afterEach(() => vi.unstubAllGlobals());

describe('LiveVoiceEngine', () => {
  it('sends the start request with the voice and quality on open', async () => {
    const { socket } = await started();
    expect(socket.binaryType).toBe('arraybuffer');
    expect(socket.json()[0]).toEqual({ type: 'start', profile_id: 'me', block_ms: 180, steps: 4 });
  });

  it('routes output to the chosen device and captures raw mic audio at the model rate', async () => {
    const { contexts, deps, callbacks } = await started();
    expect(contexts[0].setSinkId).toHaveBeenCalledWith('cable-1');
    expect(contexts[0].audioWorklet.addModule).toHaveBeenCalledWith('/vc-playback-worklet.js');
    expect(deps.getUserMedia).toHaveBeenCalledWith({
      audio: {
        deviceId: { exact: 'mic-1' },
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    expect(deps.startCapture).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
      sampleRate: 22050,
      frameSize: 441,
      channels: 1,
    });
    expect(callbacks.onStage).toHaveBeenLastCalledWith('running');
    expect(callbacks.onReady).toHaveBeenCalledWith(READY);
  });

  it('streams mic frames as PCM16 and drops them while the socket is backed up', async () => {
    const { socket, frame } = await started();
    frame(new Float32Array([0.5, -0.5, 1, -1]));
    const [pcm] = socket.binary();
    expect(Array.from(new Int16Array(pcm))).toEqual([16383, -16384, 32767, -32768]);
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    frame(new Float32Array(441));
    expect(socket.binary()).toHaveLength(1);
  });

  it('plays converted audio through the jitter buffer, and on the monitor too', async () => {
    const { socket, contexts } = await started({ monitor: true });
    expect(contexts).toHaveLength(2);
    expect(contexts[1].setSinkId).not.toHaveBeenCalled(); // monitor = default device
    socket.message(new Int16Array([16384, -16384]).buffer);
    const audio = posted.filter((p) => p.data instanceof Float32Array);
    expect(audio.map((p) => p.node)).toEqual([1, 2]);
    expect(Array.from(audio[0].data as Float32Array)).toEqual([0.5, -0.5]);
  });

  it('bypass plays the dry mic locally, pauses conversion, and resets on resume', async () => {
    const { socket, frame, engine } = await started();
    engine.setBypass(true);
    frame(new Float32Array([0.25]));
    expect(socket.binary()).toHaveLength(0);
    expect(posted.some((p) => p.data instanceof Float32Array && (p.data as Float32Array)[0] === 0.25)).toBe(true);
    socket.message(new Int16Array([1000]).buffer); // converted audio is ignored while bypassed
    expect(posted.filter((p) => p.data instanceof Float32Array)).toHaveLength(1);
    engine.setBypass(false);
    expect(socket.json().at(-1)).toEqual({ type: 'reset' });
  });

  it('reports a typed server error and tears everything down', async () => {
    const { socket, callbacks, contexts, track, stopCapture } = await started();
    socket.message(JSON.stringify({ type: 'error', code: 'voice_consent_required', detail: 'x' }));
    await flush();
    expect(callbacks.onError).toHaveBeenCalledWith('voice_consent_required', 'x');
    expect(track.stop).toHaveBeenCalled();
    expect(stopCapture).toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalled();
    expect(callbacks.onStopped).toHaveBeenCalledTimes(1);
  });

  it('maps unknown error codes to engine_failed', async () => {
    const { socket, callbacks } = await started();
    socket.message(JSON.stringify({ type: 'error', code: '<script>', detail: '' }));
    expect(callbacks.onError).toHaveBeenCalledWith('engine_failed', '');
  });

  it('treats an unexpected close as a lost connection, but not a stop', async () => {
    const lost = await started();
    lost.socket.onclose?.();
    expect(lost.callbacks.onError).toHaveBeenCalledWith('connection_lost', '');

    const stopped = await started();
    stopped.engine.stop();
    stopped.socket.onclose?.();
    await flush();
    expect(stopped.socket.json().at(-1)).toEqual({ type: 'stop' });
    expect(stopped.socket.closed).toBe(true);
    expect(stopped.callbacks.onError).not.toHaveBeenCalled();
    expect(stopped.callbacks.onStopped).toHaveBeenCalledTimes(1);
  });

  it('a stop while the output is still opening leaks nothing and never opens the mic', async () => {
    let release: () => void = () => {};
    const env = setup();
    const create = env.deps.createContext;
    env.deps.createContext = (o) => {
      const ctx = create(o) as unknown as ReturnType<typeof fakeContext>;
      ctx.audioWorklet.addModule = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
      return ctx as unknown as AudioContext;
    };
    await env.engine.start({
      profileId: 'me', inputDeviceId: '', outputDeviceId: 'cable', monitor: false, bypass: false, params: {},
    });
    env.socket.open();
    env.socket.message(JSON.stringify(READY));
    await flush();
    env.engine.stop();
    release();
    await flush();
    await flush();
    expect(env.contexts[0].close).toHaveBeenCalled();
    expect(env.deps.getUserMedia).not.toHaveBeenCalled();
    expect(env.callbacks.onReady).not.toHaveBeenCalled();
  });

  it('reports a microphone failure with the recording hint', async () => {
    const env = setup({
      getUserMedia: vi.fn(async () => {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      }),
    });
    await env.engine.start({
      profileId: 'me',
      inputDeviceId: '',
      outputDeviceId: '',
      monitor: false,
      bypass: false,
      params: {},
    });
    env.socket.open();
    env.socket.message(JSON.stringify(READY));
    await flush();
    await flush();
    expect(env.callbacks.onError).toHaveBeenCalledWith('mic_failed', 'recording.mic_denied');
    expect(env.contexts[0].setSinkId).not.toHaveBeenCalled(); // default output: no routing
  });
});

describe('playbackBufferFor', () => {
  it('sizes the slack from the block, within bounds', () => {
    expect(playbackBufferFor(3969, 22050)).toEqual({ chunkMs: 180, jitterMs: 72 });
    expect(playbackBufferFor(17640, 22050)).toEqual({ chunkMs: 800, jitterMs: 320 });
    expect(playbackBufferFor(441, 22050).jitterMs).toBe(60);
  });
});
