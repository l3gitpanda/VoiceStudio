import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  status: null as unknown,
  engines: [] as any[],
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('@/components/app-shell/workspace-header', () => ({
  WorkspaceHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
}));
vi.mock('@/components/profile-avatar', () => ({ ProfileAvatar: () => <span /> }));
vi.mock('@/components/external-link', () => ({
  ExternalLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/features/settings/engine-install', () => ({
  EngineInstall: ({ id }: { id: string }) => <button>install:{id}</button>,
}));
vi.mock('@/lib/api/client', () => ({
  apiJson: vi.fn(async (path: string) => {
    if (path === '/vc/status') return mock.status;
    throw new Error(`unexpected ${path}`);
  }),
}));
vi.mock('@/hooks/use-profiles', () => ({
  useProfiles: () => ({
    data: [
      { id: 'mine', name: 'My Voice', kind: 'clone', verified_own_voice: 1 },
      { id: 'designed', name: 'Captain', kind: 'design', verified_own_voice: 0 },
      { id: 'friend', name: 'Gallery Voice', kind: 'clone', verified_own_voice: 0 },
    ],
  }),
}));
vi.mock('@/lib/audio/live-vc/devices', () => ({
  listAudioDevices: async () => ({ inputs: [], outputs: [] }),
  needsLabelPermission: () => false,
  supportsOutputSelection: () => true,
  unlockDeviceLabels: async () => {},
  hostOs: () => 'windows',
}));
vi.mock('@/lib/audio/live-vc/engine', () => ({
  LiveVoiceEngine: class {
    started: unknown = null;
    constructor(public callbacks: any) {
      mock.engines.push(this);
    }
    async start(options: unknown) {
      this.started = options;
      this.callbacks.onStage('connecting');
    }
    stop() {
      this.callbacks.onStopped();
    }
    setBypass() {}
    async setMonitor() {}
  },
}));

import { SYSTEM_AUDIO_DEVICE_ID } from '@/lib/audio/system-audio';
import { setLiveVoiceSettings } from '@/lib/store/live-voice-settings';
import { LiveVoicePage } from './live-voice-page';

const STATUS = {
  enabled: true,
  env_pinned: false,
  engine: 'seed-vc',
  available: true,
  reason: '',
  install_supported: true,
  install_reason: '',
  busy: false,
  defaults: {},
  limits: {},
};

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <LiveVoicePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mock.status = STATUS;
  mock.engines.length = 0;
  setLiveVoiceSettings({ profileId: '', inputDeviceId: '', outputDeviceId: '', preset: 'auto', monitor: false });
});
afterEach(() => cleanup());

it('explains the opt-in and links to Settings while it is off', async () => {
  mock.status = { ...STATUS, enabled: false };
  mount();
  expect(await screen.findByText('liveVoice.setup_off_body')).toBeInTheDocument();
  expect(screen.getByText('liveVoice.open_settings').closest('a')).toHaveAttribute('href', '/settings/live-voice');
  expect(screen.queryByText('liveVoice.start')).not.toBeInTheDocument();
});

it('offers the engine install when it is on but not installed', async () => {
  mock.status = { ...STATUS, available: false };
  mount();
  expect(await screen.findByText('install:seed-vc')).toBeInTheDocument();
  mock.status = { ...STATUS, available: false, install_supported: false };
  cleanup();
  mount();
  expect(await screen.findByText('liveVoice.install_unsupported')).toBeInTheDocument();
});

it('lets any saved voice be chosen, verified or not', async () => {
  mount();
  const start = await screen.findByRole('button', { name: /liveVoice.start/ });
  expect(start).toBeDisabled();
  expect(screen.getByRole('button', { name: /My Voice/ })).toBeEnabled();
  expect(screen.getByRole('button', { name: /Captain/ })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: /Gallery Voice/ }));
  expect(start).toBeEnabled();
});

it('starts a session with the chosen voice, devices and preset, then shows latency', async () => {
  setLiveVoiceSettings({ profileId: 'mine', outputDeviceId: 'cable', preset: 'fast' });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /liveVoice.start/ }));
  const engine = mock.engines[0];
  expect(engine.started).toMatchObject({
    profileId: 'mine',
    outputDeviceId: 'cable',
    params: { block_ms: 180, steps: 4, cfg_rate: 0 },
  });
  expect(screen.getByText('liveVoice.connecting')).toBeInTheDocument();
  act(() => {
    engine.callbacks.onReady({
      type: 'ready', engine: 'seed-vc', sample_rate: 22050, block_samples: 3969, device: 'cpu',
      algorithmic_latency_ms: 260, params: {}, voice: { id: 'mine', name: 'My Voice', ref_seconds: 3 },
      warning: 'cpu_slow',
    });
    engine.callbacks.onStage('running');
    engine.callbacks.onStats({ type: 'stats', infer_ms_p50: 120, infer_ms_p95: 150, rtf: 0.67,
      blocks_in: 10, blocks_out: 10, dropped_in: 0, dropped_out: 0, queue_blocks: 0 });
    engine.callbacks.onPlayback({ fillMs: 60, underruns: 0, droppedMs: 0, outputLatencyMs: 30, droppedSendFrames: 0 });
  });
  // 20 input + 260 framing + 120 model + 60 buffer + 30 device
  expect(screen.getByTestId('live-voice-total-latency')).toHaveTextContent('liveVoice.ms');
  expect(screen.getByText('liveVoice.cpu_warning')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /liveVoice.stop/ }));
  expect(screen.getByRole('button', { name: /liveVoice.start/ })).toBeInTheDocument();
});

it('shows the error for a refused session', async () => {
  setLiveVoiceSettings({ profileId: 'mine' });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /liveVoice.start/ }));
  act(() => mock.engines[0].callbacks.onError('vc_busy', ''));
  expect(screen.getByRole('alert')).toHaveTextContent('liveVoice.error_vc_busy');
});

it('points at the virtual cable for this OS without installing anything', async () => {
  mount();
  expect(await screen.findByText('liveVoice.cable_body_windows')).toBeInTheDocument();
  expect(screen.getByText('liveVoice.cable_link').closest('a')).toHaveAttribute('href', 'https://vb-audio.com/Cable/');
});

it('with system audio as the input, needs a cable output and never monitors', async () => {
  vi.stubGlobal('voicestudio', { app: { platform: 'win32' }, permissions: { armSystemAudio: vi.fn() } });
  vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getDisplayMedia: vi.fn() } });
  try {
    setLiveVoiceSettings({ profileId: 'mine', systemAudio: true, inputDeviceId: SYSTEM_AUDIO_DEVICE_ID, outputDeviceId: '' });
    mount();
    const start = await screen.findByRole('button', { name: /liveVoice.start/ });
    expect(start).toBeDisabled(); // would play the converted voice where it is captured
    expect(screen.getByText('liveVoice.system_audio_loop')).toBeInTheDocument();
    act(() => setLiveVoiceSettings({ outputDeviceId: 'cable', monitor: true }));
    expect(start).toBeEnabled();
    fireEvent.click(start);
    expect(mock.engines[0].started).toMatchObject({ inputDeviceId: SYSTEM_AUDIO_DEVICE_ID, monitor: false });
  } finally {
    vi.unstubAllGlobals();
    setLiveVoiceSettings({ systemAudio: false, inputDeviceId: '', monitor: false });
  }
});
