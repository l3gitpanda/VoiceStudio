/**
 * Live Voice audio engine: microphone → `/ws/vc` → output device.
 *
 * Capture runs at the model's sample rate (the backend announces it in the
 * `ready` frame) through the shared `aec-frame-emitter` worklet in 20 ms
 * frames. Converted PCM is played through the `live-voice-playback` jitter
 * buffer on an AudioContext routed with `setSinkId` to the chosen output — a
 * virtual cable feeds Discord, games or a stream that way. An optional
 * monitor copy plays on the default device. Bypass sends the dry microphone
 * to the outputs instead and pauses conversion.
 *
 * Kept out of React so it can be driven and tested without a component.
 */
import { backendWebSocketUrl } from '@/lib/api/websocket';
import { describeMicError } from '@/lib/audio/recorder';
import { startMicCapture } from '@shared/utils/aec/micCapture';
import {
  floatToPcm16,
  knownErrorCode,
  pcm16ToFloat,
  type LiveVoiceErrorCode,
  type LiveVoiceParams,
  type LiveVoiceReady,
  type LiveVoiceStats,
} from './protocol';

const PLAYBACK_WORKLET = '/vc-playback-worklet.js';
/** Above this many unsent bytes the socket is behind; frames are dropped. */
export const MAX_BUFFERED_BYTES = 64 * 1024;
const FRAME_MS = 20;

export interface PlaybackStats {
  fillMs: number;
  underruns: number;
  droppedMs: number;
  outputLatencyMs: number;
  droppedSendFrames: number;
}

export interface LiveVoiceCallbacks {
  onStage?: (stage: 'connecting' | 'loading' | 'running') => void;
  onReady?: (ready: LiveVoiceReady) => void;
  onStats?: (stats: LiveVoiceStats) => void;
  onPlayback?: (stats: PlaybackStats) => void;
  onError?: (code: LiveVoiceErrorCode, detail: string) => void;
  onStopped?: () => void;
}

export interface LiveVoiceStartOptions {
  profileId: string;
  inputDeviceId: string;
  outputDeviceId: string;
  monitor: boolean;
  bypass: boolean;
  params: Partial<LiveVoiceParams>;
}

type StopCapture = (() => Promise<void>) & { sampleRate?: number };

export interface LiveVoiceDeps {
  socketUrl: () => Promise<string>;
  openSocket: (url: string) => WebSocket;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  startCapture: (
    stream: MediaStream,
    onFrame: (frame: Float32Array) => void,
    opts: { sampleRate: number; frameSize: number; channels: number },
  ) => Promise<StopCapture>;
  createContext: (options: AudioContextOptions) => AudioContext;
  createAudioElement: () => HTMLAudioElement;
}

export const defaultDeps: LiveVoiceDeps = {
  socketUrl: () => backendWebSocketUrl('/ws/vc'),
  openSocket: (url) => new WebSocket(url),
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  startCapture: (stream, onFrame, opts) => startMicCapture(stream, onFrame, opts) as Promise<StopCapture>,
  createContext: (options) => new AudioContext(options),
  createAudioElement: () => new Audio(),
};

/** One output device fed by the jitter-buffer worklet. */
class OutputSink {
  private constructor(
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    private readonly element: HTMLAudioElement | null,
  ) {}

  static async open(
    deps: LiveVoiceDeps,
    sampleRate: number,
    deviceId: string,
    onStats?: (data: { fillMs: number; underruns: number; droppedMs: number }) => void,
  ): Promise<OutputSink> {
    const ctx = deps.createContext({ sampleRate, latencyHint: 'interactive' });
    try {
      await ctx.audioWorklet.addModule(PLAYBACK_WORKLET);
      const node = new AudioWorkletNode(ctx, 'live-voice-playback', {
        outputChannelCount: [1],
        processorOptions: { targetMs: 60, maxMs: 240 },
      });
      if (onStats) {
        node.port.onmessage = (event) => {
          if (event.data?.type === 'stats') onStats(event.data);
        };
      }
      let element: HTMLAudioElement | null = null;
      const sinkCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (deviceId && typeof sinkCtx.setSinkId === 'function') {
        await sinkCtx.setSinkId(deviceId);
        node.connect(ctx.destination);
      } else if (deviceId) {
        // Older runtimes: route through a media element, which can pick a sink.
        const dest = ctx.createMediaStreamDestination();
        node.connect(dest);
        element = deps.createAudioElement();
        element.srcObject = dest.stream;
        await element.setSinkId(deviceId);
        await element.play();
      } else {
        node.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') await ctx.resume();
      return new OutputSink(ctx, node, element);
    } catch (error) {
      void ctx.close().catch(() => {});
      throw error;
    }
  }

  push(samples: Float32Array): void {
    const copy = samples.slice();
    this.node.port.postMessage(copy, [copy.buffer]);
  }

  reset(): void {
    this.node.port.postMessage({ type: 'reset' });
  }

  get latencyMs(): number {
    const ctx = this.ctx as AudioContext & { outputLatency?: number };
    return 1000 * ((ctx.baseLatency || 0) + (ctx.outputLatency || 0));
  }

  async close(): Promise<void> {
    try {
      this.node.port.onmessage = null;
      this.node.disconnect();
    } catch {
      /* already gone */
    }
    if (this.element) {
      this.element.pause();
      this.element.srcObject = null;
    }
    await this.ctx.close().catch(() => {});
  }
}

export class LiveVoiceEngine {
  private socket: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private stopCapture: StopCapture | null = null;
  private output: OutputSink | null = null;
  private monitorSink: OutputSink | null = null;
  private options: LiveVoiceStartOptions | null = null;
  private sampleRate = 0;
  private bypass = false;
  private droppedSendFrames = 0;
  private stopping = false;
  private failed = false;
  private finished = false;

  constructor(
    private readonly callbacks: LiveVoiceCallbacks,
    private readonly deps: LiveVoiceDeps = defaultDeps,
  ) {}

  get running(): boolean {
    return this.socket !== null && !this.finished;
  }

  async start(options: LiveVoiceStartOptions): Promise<void> {
    if (this.socket) throw new Error('Live Voice is already running');
    this.options = options;
    this.bypass = options.bypass;
    this.stopping = this.failed = this.finished = false;
    this.callbacks.onStage?.('connecting');
    let url: string;
    try {
      url = await this.deps.socketUrl();
    } catch {
      this.fail('connection_lost', '');
      return;
    }
    const socket = this.deps.openSocket(url);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'start', profile_id: options.profileId, ...options.params }));
    };
    socket.onmessage = (event) => void this.onMessage(event.data);
    socket.onerror = () => {};
    socket.onclose = () => {
      if (!this.stopping && !this.failed) this.fail('connection_lost', '');
      else void this.teardown();
    };
  }

  setBypass(on: boolean): void {
    if (this.bypass === on) return;
    this.bypass = on;
    this.output?.reset();
    this.monitorSink?.reset();
    if (!on) this.sendJson({ type: 'reset' });
  }

  async setMonitor(on: boolean): Promise<void> {
    if (!this.options) return;
    this.options = { ...this.options, monitor: on };
    if (!on) {
      const sink = this.monitorSink;
      this.monitorSink = null;
      await sink?.close();
    } else if (!this.monitorSink && this.sampleRate && this.options.outputDeviceId) {
      this.monitorSink = await OutputSink.open(this.deps, this.sampleRate, '');
    }
  }

  stop(): void {
    if (!this.socket) return;
    this.stopping = true;
    this.sendJson({ type: 'stop' });
    try {
      this.socket.close(1000);
    } catch {
      /* already closed */
    }
    void this.teardown();
  }

  // ── internals ───────────────────────────────────────────────────────────

  private sendJson(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async onMessage(data: unknown): Promise<void> {
    if (data instanceof ArrayBuffer) {
      if (this.bypass) return;
      const samples = pcm16ToFloat(data);
      this.output?.push(samples);
      this.monitorSink?.push(samples);
      return;
    }
    let message: { type?: string; [key: string]: unknown };
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === 'status') this.callbacks.onStage?.('loading');
    else if (message.type === 'stats') this.callbacks.onStats?.(message as unknown as LiveVoiceStats);
    else if (message.type === 'error') {
      this.fail(knownErrorCode(message.code), typeof message.detail === 'string' ? message.detail : '');
    } else if (message.type === 'ready') await this.onReady(message as unknown as LiveVoiceReady);
  }

  private async onReady(ready: LiveVoiceReady): Promise<void> {
    const options = this.options;
    if (!options || this.finished) return;
    this.sampleRate = ready.sample_rate;
    // Every await below can race a stop() or an error that already tore the
    // session down; whatever a step created after that is released at once,
    // so no audio context leaks and the microphone never stays open.
    let output: OutputSink | null = null;
    let monitor: OutputSink | null = null;
    try {
      output = await OutputSink.open(this.deps, ready.sample_rate, options.outputDeviceId, (s) =>
        this.callbacks.onPlayback?.({
          ...s,
          outputLatencyMs: output?.latencyMs ?? 0,
          droppedSendFrames: this.droppedSendFrames,
        }),
      );
      if (options.monitor && options.outputDeviceId && !this.finished) {
        monitor = await OutputSink.open(this.deps, ready.sample_rate, '');
      }
    } catch (error) {
      await output?.close();
      this.fail('engine_failed', error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.finished) {
      await output.close();
      await monitor?.close();
      return;
    }
    this.output = output;
    this.monitorSink = monitor;
    let stream: MediaStream | null = null;
    try {
      stream = await this.deps.getUserMedia({
        audio: {
          ...(options.inputDeviceId ? { deviceId: { exact: options.inputDeviceId } } : {}),
          channelCount: 1,
          // Raw voice converts best; browser voice processing changes timbre.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (this.finished) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stream = stream;
      const stopCapture = await this.deps.startCapture(stream, (frame) => this.onFrame(frame), {
        sampleRate: ready.sample_rate,
        frameSize: Math.round((ready.sample_rate * FRAME_MS) / 1000),
        channels: 1,
      });
      if (this.finished) {
        await stopCapture().catch(() => {});
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.stopCapture = stopCapture;
    } catch (error) {
      this.fail('mic_failed', describeMicError(error).key);
      return;
    }
    this.callbacks.onReady?.(ready);
    this.callbacks.onStage?.('running');
  }

  private onFrame(frame: Float32Array): void {
    if (this.bypass) {
      this.output?.push(frame);
      this.monitorSink?.push(frame);
      return;
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.droppedSendFrames += 1; // latency must not grow behind a slow socket
      return;
    }
    socket.send(floatToPcm16(frame));
  }

  private fail(code: LiveVoiceErrorCode, detail: string): void {
    if (this.failed || this.finished) return;
    this.failed = true;
    this.callbacks.onError?.(code, detail);
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    void this.teardown();
  }

  private async teardown(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const stopCapture = this.stopCapture;
    const output = this.output;
    const monitor = this.monitorSink;
    this.stopCapture = null;
    this.output = this.monitorSink = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    await stopCapture?.().catch(() => {});
    await output?.close();
    await monitor?.close();
    this.socket = null;
    this.callbacks.onStopped?.();
  }
}
