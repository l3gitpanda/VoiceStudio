import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/audio/live-vc/speak-to-mic', () => ({ SpeakToMic: class {} }));

import { TypeToTalk } from './type-to-talk';

afterEach(() => cleanup());

it('speaks the typed text in the chosen voice into the virtual mic, then clears it', async () => {
  const speak = vi.fn(async () => {});
  render(
    <TypeToTalk profileId="mine" deviceId="cable" monitor createSpeaker={() => ({ speak, stop: vi.fn() })} />,
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  gg everyone  ' } });
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  });
  expect(speak).toHaveBeenCalledWith({ text: 'gg everyone', profileId: 'mine', deviceId: 'cable', monitor: true });
  expect(screen.getByRole('textbox')).toHaveValue('');
});

it('needs an eligible voice and warns when no virtual mic is chosen', () => {
  render(<TypeToTalk profileId="" deviceId="" monitor={false} createSpeaker={() => ({ speak: vi.fn(), stop: vi.fn() })} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } });
  expect(screen.getByRole('button', { name: /liveVoice.type_speak/ })).toBeDisabled();
  expect(screen.getByText('cloneFlow.choose_voice')).toBeInTheDocument();
  expect(screen.getByText('liveVoice.type_no_device')).toBeInTheDocument();
});

it('shows the failure and keeps the text for a retry', async () => {
  const speak = vi.fn(async () => {
    throw new Error('Engine unavailable');
  });
  render(<TypeToTalk profileId="mine" deviceId="cable" monitor={false} createSpeaker={() => ({ speak, stop: vi.fn() })} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /liveVoice.type_speak/ }));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('liveVoice.type_failed');
  expect(screen.getByRole('textbox')).toHaveValue('hello');
});
