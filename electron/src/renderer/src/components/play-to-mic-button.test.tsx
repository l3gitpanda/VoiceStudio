import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));
vi.mock('@/lib/audio/live-vc/devices', () => ({ supportsOutputSelection: () => true }));

import { setLiveVoiceSettings } from '@/lib/store/live-voice-settings';
import { PlayToMicButton } from './play-to-mic-button';

function fakeAudio() {
  const el = {
    src: '',
    onended: null as null | (() => void),
    setSinkId: vi.fn(async () => {}),
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    removeAttribute: vi.fn(),
    load: vi.fn(),
  };
  return el;
}

beforeEach(() => setLiveVoiceSettings({ outputDeviceId: '' }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('stays hidden until a virtual microphone is chosen', () => {
  render(<PlayToMicButton url="/api/audio/a.wav" />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('routes the clip to the virtual microphone, then stops', async () => {
  setLiveVoiceSettings({ outputDeviceId: 'cable' });
  const audio = fakeAudio();
  render(<PlayToMicButton url="/api/audio/a.wav" createAudio={() => audio as unknown as HTMLAudioElement} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /micOutput.play/ }));
  });
  expect(audio.setSinkId).toHaveBeenCalledWith('cable');
  expect(audio.src).toBe('/api/audio/a.wav');
  expect(audio.play).toHaveBeenCalled();
  expect(audio.setSinkId.mock.invocationCallOrder[0]).toBeLessThan(audio.play.mock.invocationCallOrder[0]);
  fireEvent.click(screen.getByRole('button', { name: /micOutput.stop/ }));
  expect(audio.pause).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /micOutput.play/ })).toBeInTheDocument();
});

it('reports a device that cannot be used', async () => {
  setLiveVoiceSettings({ outputDeviceId: 'gone' });
  const audio = fakeAudio();
  audio.setSinkId.mockRejectedValueOnce(new Error('NotFoundError'));
  render(<PlayToMicButton url="/api/audio/a.wav" createAudio={() => audio as unknown as HTMLAudioElement} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /micOutput.play/ }));
  });
  expect(toastError).toHaveBeenCalledWith('micOutput.failed');
  expect(audio.play).not.toHaveBeenCalled();
});
