import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cloneSettingsStore, patchCloneSettings } from '@/lib/store/clone-settings';
import { clearReference, referenceStore } from '@/lib/store/reference';

const players = vi.hoisted(() => [] as Array<{ src: string }>);
const setWorkspace = vi.hoisted(() => vi.fn());
vi.mock('@/lib/store/workspace', () => ({ setWorkspace }));
vi.mock('@/hooks/use-profiles', () => ({
  useCreateCloneProfile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useProfiles: () => ({
    data: [
      {
        id: 'v1',
        name: 'Scarlet',
        kind: 'clone',
        ref_audio_path: 'v1-abc.wav',
        audio_url: '/profiles/v1/audio?v=7',
      },
    ],
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#models">{children}</a>,
}));
vi.mock('./portrait-search', () => ({ PortraitSearch: () => null }));
vi.mock('./profile-image-editor', () => ({ ProfileImageEditor: () => null }));
vi.mock('./reference-input', () => ({
  ReferenceSourcePicker: () => null,
  ReferenceUsageNote: () => null,
}));
vi.mock('./clip-editor', () => ({
  ClipEditorDialog: ({ onApply }: { onApply: (file: File, seconds: number) => void }) => (
    <button type="button" onClick={() => onApply(new File(['cut'], 'take-edited.wav'), 4)}>
      apply-edit
    </button>
  ),
}));
vi.mock('@/components/waveform-player', () => ({
  WaveformPlayer: (props: { src: string }) => {
    players.push(props);
    return null;
  },
}));
import { ReferencePanel } from './reference-panel';

afterEach(() => {
  cleanup();
  patchCloneSettings({ selectedProfileId: null });
  clearReference();
  setWorkspace.mockClear();
});

it('opens the selected saved voice for editing without changing the selection', () => {
  patchCloneSettings({ selectedProfileId: 'v1' });
  render(<ReferencePanel />);

  expect(players.at(-1)?.src).toBe('/api/profiles/v1/audio?v=7');
  fireEvent.click(screen.getByRole('button', { name: /clone.edit_voice/ }));

  expect(setWorkspace).toHaveBeenCalledWith({ editingProfileId: 'v1', panel: null });
});

it('swaps an edited cut in for the raw clip without making it a new voice', () => {
  const take = new File(['audio'], 'take.webm', { type: 'audio/webm' });
  referenceStore.setState(() => ({
    file: take,
    durationSeconds: 9,
    objectUrl: null,
    origin: take,
  }));
  patchCloneSettings({ instruct: 'Calm', refText: 'the whole take' });
  render(<ReferencePanel />);

  fireEvent.click(screen.getByRole('button', { name: /clipEditor.edit/ }));
  fireEvent.click(screen.getByText('apply-edit'));

  expect(referenceStore.state.file?.name).toBe('take-edited.wav');
  expect(referenceStore.state.durationSeconds).toBe(4);
  expect(referenceStore.state.origin).toBe(take);
  expect(cloneSettingsStore.state.instruct).toBe('Calm');
  expect(cloneSettingsStore.state.refText).toBe('');
  expect(screen.queryByText('apply-edit')).toBeNull();
});
