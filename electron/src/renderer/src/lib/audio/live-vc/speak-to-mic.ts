/**
 * Type to talk: speak text in a saved voice straight into the virtual
 * microphone (the device chosen for Live Voice output).
 *
 * Uses the existing streaming TTS socket (`/ws/tts`), so the active TTS
 * engine renders sentence by sentence and the first sentence plays while the
 * rest is still rendering. The output context is routed with `setSinkId`
 * BEFORE anything is scheduled, so no audio leaks to the speakers first; an
 * optional monitor copy plays on the default device.
 */
import { backendWebSocketUrl } from '@/lib/api/websocket';
import { pcm16ToFloat } from './protocol';

export interface SpeakToMicDeps {
  socketUrl: () => Promise<string>;
  openSocket: (url: string) => WebSocket;
  createContext: (options: AudioContextOptions) => AudioContext;
}

const defaultDeps: SpeakToMicDeps = {
  socketUrl: () => backendWebSocketUrl('/ws/tts'),
  openSocket: (url) => new WebSocket(url),
  createContext: (options) => new AudioContext(options),
};

export interface SpeakRequest {
  text: string;
  profileId: string;
  deviceId: string;
  monitor: boolean;
}

/** Silence before the first chunk: a freshly routed output (a virtual cable
 * especially) is still starting up, and audio scheduled at once loses its
 * first syllable. */
const LEAD_S = 0.15;
/** Kept open after the last chunk is due, on top of the device's own buffer. */
const TAIL_S = 0.25;

/** Schedules PCM chunks gaplessly on one output. */
class ChunkPlayer {
  private nextStart = 0;
  private sources: AudioBufferSourceNode[] = [];

  constructor(private readonly ctx: AudioContext) {}

  push(samples: Float32Array): void {
    const ctx = this.ctx;
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const lead = this.sources.length === 0 ? LEAD_S : 0.03;
    const start = Math.max(this.nextStart, ctx.currentTime + lead);
    source.start(start);
    this.sources.push(source);
    this.nextStart = start + buffer.duration;
  }

  /** Until the last scheduled sample has left the device, not just the graph. */
  get remainingSeconds(): number {
    const ctx = this.ctx as AudioContext & { outputLatency?: number };
    const deviceDelay = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    return Math.max(0, this.nextStart - ctx.currentTime) + deviceDelay;
  }

  async close(): Promise<void> {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
    }
    this.sources = [];
    await this.ctx.close().catch(() => {});
  }
}

export class SpeakToMic {
  private socket: WebSocket | null = null;
  private players: ChunkPlayer[] = [];
  private stopped = false;
  private finish: (() => void) | null = null;

  constructor(private readonly deps: SpeakToMicDeps = defaultDeps) {}

  /** Resolves once the whole message has played; rejects with the backend's detail. */
  async speak(request: SpeakRequest): Promise<void> {
    this.stop();
    this.stopped = false;
    const socket = this.deps.openSocket(await this.deps.socketUrl());
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    const pending: ArrayBuffer[] = [];
    let ready = false;
    // Frames are handled in order but the handler awaits the device; "done"
    // must wait for the outputs, or a short message would finish unplayed.
    let opening: Promise<void> = Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => {
        this.finish = null;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        if (error) {
          void this.release();
          reject(error);
          return;
        }
        // Let the scheduled audio play out, then release the device.
        const wait = Math.max(0, ...this.players.map((p) => p.remainingSeconds));
        setTimeout(() => {
          void this.release();
          resolve();
        }, (wait + TAIL_S) * 1000);
      };
      this.finish = () => done();
      socket.onopen = () => socket.send(JSON.stringify({ text: request.text, voice: request.profileId }));
      socket.onerror = () => {};
      socket.onclose = () => {
        if (this.finish) done(this.stopped ? undefined : new Error('connection lost'));
      };
      socket.onmessage = async (event) => {
        if (event.data instanceof ArrayBuffer) {
          if (!ready) pending.push(event.data);
          else this.play(event.data);
          return;
        }
        let message: { type?: string; sample_rate?: number; detail?: unknown };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.type === 'start' && typeof message.sample_rate === 'number') {
          const sampleRate = message.sample_rate;
          opening = (async () => {
            try {
              const players = await this.openOutputs(sampleRate, request);
              if (this.stopped) {
                await Promise.all(players.map((player) => player.close()));
                return;
              }
              this.players = players;
            } catch (error) {
              done(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            ready = true;
            for (const chunk of pending.splice(0)) this.play(chunk);
          })();
          await opening;
        } else if (message.type === 'done') {
          await opening;
          if (this.finish) done();
        } else if (message.type === 'error') {
          await opening;
          if (this.finish) done(new Error(typeof message.detail === 'string' ? message.detail : 'speech failed'));
        }
      };
    });
  }

  stop(): void {
    this.stopped = true;
    const finish = this.finish;
    this.finish = null;
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
    void this.release();
    finish?.();
  }

  private play(chunk: ArrayBuffer): void {
    if (this.stopped) return;
    const samples = pcm16ToFloat(chunk);
    for (const player of this.players) player.push(samples);
  }

  private async openOutputs(sampleRate: number, request: SpeakRequest): Promise<ChunkPlayer[]> {
    const ctx = this.deps.createContext({ sampleRate, latencyHint: 'interactive' });
    const sink = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (request.deviceId && typeof sink.setSinkId === 'function') await sink.setSinkId(request.deviceId);
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const players = [new ChunkPlayer(ctx)];
    if (request.monitor && request.deviceId) {
      players.push(new ChunkPlayer(this.deps.createContext({ sampleRate, latencyHint: 'interactive' })));
    }
    return players;
  }

  private async release(): Promise<void> {
    const players = this.players;
    this.players = [];
    await Promise.all(players.map((p) => p.close()));
  }
}
