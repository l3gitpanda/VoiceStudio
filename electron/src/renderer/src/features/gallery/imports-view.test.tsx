import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { encodeWav } from '@shared/utils/audioTrim';
import type { GalleryVoice } from './imports-api';
const mocks = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  search: vi.fn().mockResolvedValue({ results: [] }),
  upload: vi.fn().mockResolvedValue({}),
  persona: vi.fn().mockResolvedValue({ name: 'Bundle voice', verified_own_voice: true }),
  download: vi.fn().mockResolvedValue({}),
  save: vi.fn(),
  remove: vi.fn(),
  navigate: vi.fn(),
  patch: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock('./imports-api', () => ({ importsApi: mocks }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/store/clone-settings', () => ({ patchCloneSettings: mocks.patch }));
vi.mock('@/components/audio-preview-button', () => ({ AudioPreviewButton: () => null }));
vi.mock('@/lib/api/client', async (original) => ({
  ...(await original<typeof import('@/lib/api/client')>()),
  apiFetch: mocks.fetch,
}));
// The trim editor's waveform: drawn from the decoded samples, ready at once.
vi.mock('wavesurfer.js', () => ({
  default: {
    create: () => ({
      on: () => () => {},
      once: (event: string, handler: () => void) => event === 'ready' && queueMicrotask(handler),
      destroy: () => {},
    }),
  },
}));
vi.mock('wavesurfer.js/dist/plugins/regions.esm.js', () => ({
  default: {
    create() {
      const created: Array<(region: object) => void> = [];
      return {
        on: (event: string, handler: (region: object) => void) =>
          event === 'region-created' && created.push(handler),
        getRegions: () => [],
        enableDragSelection: () => () => {},
        addRegion(params: object) {
          const region = { ...params, setOptions: (next: object) => Object.assign(region, next) };
          for (const handler of created) handler(region);
          return region;
        },
      };
    },
  },
}));
import { ImportsView } from './imports-view';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.list.mockResolvedValue([]);
});
function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ImportsView />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
it('searches only on explicit submission and imports a URL without a search request', async () => {
  show();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'narration sample' } });
  expect(mocks.search).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'common.search' }));
  await waitFor(() => expect(mocks.search).toHaveBeenCalledWith('narration sample'));
  await waitFor(() => expect(screen.getByRole('textbox')).not.toBeDisabled());
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'https://example.com/audio.wav' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'common.search' }));
  await waitFor(() =>
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({ video_url: 'https://example.com/audio.wav', duration: 15 }),
    ),
  );
  expect(mocks.search).toHaveBeenCalledTimes(1);
});
it('imports a portable bundle and invalidates saved profiles', async () => {
  const { client, container } = show();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const file = new File(['bundle'], 'voice.ovsvoice');
  fireEvent.change(container.querySelector('input[accept=".ovsvoice,.omnivoice"]')!, {
    target: { files: [file] },
  });
  await waitFor(() => expect(mocks.persona).toHaveBeenCalledWith(file));
  await waitFor(() => expect(screen.getByText('gallery.persona_imported')).toBeInTheDocument());
  expect(invalidate).toHaveBeenCalled();
});

const voice: GalleryVoice = {
  id: 'v/1',
  name: 'Narrator',
  character: 'Host',
  category: 'import',
  source_type: 'upload',
  audio_path: 'v1.wav',
  duration: 2,
  description: 'Podcast intro',
  tags: [],
  created_at: 0,
};
// The stored import: two seconds of 44.1 kHz WAV, which the browser decodes
// at whatever rate it is asked for.
function storedImport() {
  const rate = 44_100;
  mocks.list.mockResolvedValue([voice]);
  mocks.fetch.mockResolvedValue({
    blob: async () => new Blob([encodeWav(new Float32Array(rate * 2).fill(0.25), rate)]),
  });
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      constructor(
        readonly channels: number,
        readonly length: number,
        readonly sampleRate: number,
      ) {}
      async decodeAudioData() {
        const samples = new Float32Array(this.sampleRate * 2).fill(0.25);
        return { numberOfChannels: 1, length: samples.length, getChannelData: () => samples };
      }
    },
  );
}
async function trimToOneSecond() {
  fireEvent.click(await screen.findByRole('button', { name: 'gallery.trim' }));
  const editor = await screen.findByRole('dialog');
  const end = within(editor).getByLabelText('trimmer.end_label');
  await waitFor(() => expect(end).toHaveValue(2));
  fireEvent.change(within(editor).getByLabelText('trimmer.start_label'), {
    target: { value: '0.5' },
  });
  fireEvent.change(end, { target: { value: '1.5' } });
  fireEvent.click(within(editor).getByRole('button', { name: /clipEditor.keep_selection/ }));
  await waitFor(() =>
    expect(within(editor).getByRole('button', { name: 'clipEditor.apply' })).toBeEnabled(),
  );
  return editor;
}
it('trims a stored import at its own sample rate and saves it as a new import', async () => {
  storedImport();
  show();
  const editor = await trimToOneSecond();
  expect(mocks.fetch).toHaveBeenCalledWith('/gallery/voices/v%2F1/preview', expect.anything());
  fireEvent.click(within(editor).getByRole('button', { name: 'clipEditor.apply' }));

  await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
  const [file, metadata] = mocks.upload.mock.calls[0] as [File, unknown];
  expect(metadata).toBe(voice);
  expect(file.name).toBe('Narrator-edited.wav');
  const header = new DataView(await file.arrayBuffer());
  expect(header.getUint32(24, true)).toBe(44_100);
  expect(file.size).toBe(44 + 44_100 * 2);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
it('keeps the trim open with the save error so it can be retried', async () => {
  storedImport();
  mocks.upload.mockRejectedValueOnce(new Error('Disk full'));
  show();
  const editor = await trimToOneSecond();
  fireEvent.click(within(editor).getByRole('button', { name: 'clipEditor.apply' }));

  expect(await within(editor).findByRole('alert')).toHaveTextContent('Disk full');
  fireEvent.click(within(editor).getByRole('button', { name: 'clipEditor.apply' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mocks.upload).toHaveBeenCalledTimes(2);
});
