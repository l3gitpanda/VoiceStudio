import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Clip } from '@/lib/audio/clip-edit';

type Handler = (...args: unknown[]) => void;
function emitter() {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}

const mock = vi.hoisted(() => ({
  decode: vi.fn<(blob: Blob) => Promise<Clip>>(),
  fetch: vi.fn(),
  waves: [] as Array<{ options: { duration: number }; playPause: () => void }>,
  regions: [] as Array<{ element: HTMLElement }>,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/api/client', () => ({
  apiFetch: mock.fetch,
  describeError: (error: Error) => error.message,
}));
vi.mock('@/lib/audio/clip-edit', async (original) => ({
  ...(await original<typeof import('@/lib/audio/clip-edit')>()),
  decodeClip: mock.decode,
}));
vi.mock('@/components/waveform-player', () => ({ waveColors: () => ({}) }));
vi.mock('wavesurfer.js/dist/plugins/regions.esm.js', () => ({
  default: {
    create() {
      const events = emitter();
      const regions: Array<{ start: number; end: number }> = [];
      return {
        ...events,
        getRegions: () => regions,
        enableDragSelection: () => () => {},
        addRegion(params: { start: number; end: number }) {
          const element = document.createElement('div');
          element.innerHTML = '<div part="region-handle region-handle-left"></div>';
          const region = {
            ...params,
            element,
            setOptions: (next: object) => Object.assign(region, next),
            remove: () => regions.splice(regions.indexOf(region), 1),
            play: vi.fn(),
          };
          regions.push(region);
          mock.regions.push(region);
          events.emit('region-created', region);
          return region;
        },
      };
    },
  },
}));
vi.mock('wavesurfer.js', () => ({
  default: {
    create(options: { duration: number }) {
      const events = emitter();
      const wave = {
        ...events,
        options,
        once: (event: string, handler: Handler) => event === 'ready' && queueMicrotask(handler),
        playPause: vi.fn(),
        pause: vi.fn(),
        zoom: vi.fn(),
        destroy: vi.fn(),
      };
      mock.waves.push(wave);
      return wave;
    },
  },
}));
import { ClipEditorDialog } from './clip-editor';

// Two seconds at 1 kHz.
const twoSeconds = (): Clip => ({ samples: new Float32Array(2000).fill(0.25), sampleRate: 1000 });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mock.waves.length = 0;
  mock.regions.length = 0;
});

function open(props: Partial<Parameters<typeof ClipEditorDialog>[0]> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <ClipEditorDialog
      source={new File(['audio'], 'voice.webm')}
      name="voice.webm"
      onApply={onApply}
      onClose={onClose}
      {...props}
    />,
  );
  return { onApply, onClose };
}

const field = (label: string) => screen.getByLabelText(label);
const button = (name: string) => screen.getByRole('button', { name: new RegExp(name) });

async function select(start: number, end: number) {
  await waitFor(() => expect(field('trimmer.end_label')).toHaveValue(2));
  fireEvent.change(field('trimmer.start_label'), { target: { value: String(start) } });
  fireEvent.change(field('trimmer.end_label'), { target: { value: String(end) } });
}

it('keeps only the selection and hands back a WAV of exactly that length', async () => {
  mock.decode.mockResolvedValue(twoSeconds());
  const { onApply } = open();
  await select(0.5, 1.5);
  expect(button('clipEditor.apply')).toBeDisabled();

  fireEvent.click(button('clipEditor.keep_selection'));
  await waitFor(() => expect(mock.waves.at(-1)?.options.duration).toBe(1));
  fireEvent.click(button('clipEditor.apply'));

  const [file, seconds] = onApply.mock.calls[0] as [File, number];
  expect(file.name).toBe('voice-edited.wav');
  expect(file.type).toBe('audio/wav');
  expect(file.size).toBe(44 + 1000 * 2);
  expect(seconds).toBe(1);
});

it('cuts the selection out, undoes it, and starts over', async () => {
  mock.decode.mockResolvedValue(twoSeconds());
  open();
  await select(0.5, 1);

  fireEvent.click(button('clipEditor.delete_selection'));
  await waitFor(() => expect(mock.waves.at(-1)?.options.duration).toBeCloseTo(1.49));
  fireEvent.click(button('scriptEdit.undo'));
  await waitFor(() => expect(mock.waves.at(-1)?.options.duration).toBe(2));
  expect(button('scriptEdit.undo')).toBeDisabled();

  await select(0, 1);
  // Delete is the keyboard shortcut for cutting out.
  fireEvent.keyDown(button('clipEditor.keep_selection'), { key: 'Delete' });
  await waitFor(() => expect(mock.waves.at(-1)?.options.duration).toBe(1));
  fireEvent.click(button('gallery.reset'));
  await waitFor(() => expect(mock.waves.at(-1)?.options.duration).toBe(2));
});

it('will not cut away the whole clip', async () => {
  mock.decode.mockResolvedValue(twoSeconds());
  open();
  await waitFor(() => expect(field('trimmer.end_label')).toHaveValue(2));
  // A drag inside the whole-clip selection must reach the waveform and draw
  // a new one: only the selection's edges take the pointer.
  const { element } = mock.regions[0];
  expect(element.style.pointerEvents).toBe('none');
  expect((element.firstElementChild as HTMLElement).style.pointerEvents).toBe('auto');
  expect(button('clipEditor.delete_selection')).toBeDisabled();
  expect(button('clipEditor.keep_selection')).toBeDisabled();
});

it('makes a clip over the limit usable only once it is cut down', async () => {
  mock.decode.mockResolvedValue(twoSeconds());
  const { onApply } = open({ maxSeconds: 1.5 });
  // The selection starts as the longest usable opening.
  await waitFor(() => expect(field('trimmer.end_label')).toHaveValue(1.5));
  expect(screen.getByText('clipEditor.too_long')).toBeInTheDocument();

  fireEvent.click(button('clipEditor.keep_selection'));
  await waitFor(() => expect(button('clipEditor.apply')).toBeEnabled());
  fireEvent.click(button('clipEditor.apply'));
  expect(onApply.mock.calls[0][1]).toBe(1.5);
});

it('loads a saved reference through the API and reports a clip it cannot open', async () => {
  mock.fetch.mockResolvedValue({ blob: async () => new Blob(['x']) });
  mock.decode.mockRejectedValue(new Error('Unable to decode audio data'));
  const { onClose } = open({ source: '/profiles/v1/audio?v=2' });

  expect(await screen.findByRole('alert')).toHaveTextContent('gallery.trim_load_failed');
  expect(mock.fetch).toHaveBeenCalledWith('/profiles/v1/audio?v=2', expect.anything());
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
  expect(onClose).toHaveBeenCalledOnce();
});

it('stays open and locked while the applied edit saves, and shows why a save failed', async () => {
  mock.decode.mockResolvedValue(twoSeconds());
  const props = { onApply: vi.fn(), onClose: vi.fn() };
  const editor = (extra: { busy?: boolean; error?: string }) => (
    <ClipEditorDialog
      source={new File(['audio'], 'voice.webm')}
      name="voice.webm"
      {...props}
      {...extra}
    />
  );
  const { rerender } = render(editor({}));
  await select(0.5, 1.5);
  fireEvent.click(button('clipEditor.keep_selection'));
  await waitFor(() => expect(button('clipEditor.apply')).toBeEnabled());

  rerender(editor({ busy: true }));
  expect(button('common.saving')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'common.cancel' })).toBeDisabled();
  expect(button('scriptEdit.undo')).toBeDisabled();
  fireEvent.keyDown(field('clipEditor.waveform'), { key: 'z', ctrlKey: true });
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
  expect(props.onClose).not.toHaveBeenCalled();
  expect(mock.waves.at(-1)?.options.duration).toBe(1);

  rerender(editor({ error: 'Disk full' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Disk full');
  fireEvent.click(button('clipEditor.apply'));
  expect(props.onApply).toHaveBeenCalledOnce();
});
