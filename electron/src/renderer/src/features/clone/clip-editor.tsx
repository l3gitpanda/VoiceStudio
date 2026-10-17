import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import WaveSurfer from 'wavesurfer.js';
import Regions, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js';
import {
  CropIcon,
  MaximizeIcon,
  PauseIcon,
  PlayIcon,
  RepeatIcon,
  RotateCcwIcon,
  ScissorsIcon,
  Undo2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { waveColors } from '@/components/waveform-player';
import { apiFetch, describeError } from '@/lib/api/client';
import {
  MIN_CLIP_SECONDS,
  clipPeaks,
  clipSeconds,
  clipToWav,
  decodeClip,
  editedClipName,
  keepRange,
  removeRange,
  type Clip,
} from '@/lib/audio/clip-edit';
import { createObjectUrl, revokeObjectUrl } from '@/lib/audio/object-url';
import { claimPlayback } from '@/lib/audio/playback';

// Edits only shrink a clip, but a long source still costs megabytes per step.
// The source stays first so Start over always works; past this many steps the
// oldest intermediate one is dropped.
const UNDO_LIMIT = 20;
const SELECTION_COLOR = 'color-mix(in srgb, var(--primary) 22%, transparent)';

interface Range {
  start: number;
  end: number;
}

export interface ClipEditorProps {
  /** The clip in memory, or an API path to fetch it from. */
  source: Blob | string;
  /** Source file name; the edit is saved as `<name>-edited.wav`. */
  name: string;
  /** The edit must be at most this long (seconds) before it can be used. */
  maxSeconds?: number;
  onApply(file: File, durationSeconds: number): void;
  onClose(): void;
}

/** Cut or trim a reference clip; mounted while open. */
export function ClipEditorDialog(props: ClipEditorProps) {
  const { t } = useTranslation();
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent className="gap-4 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('clipEditor.edit')}</DialogTitle>
          <DialogDescription>{t('clipEditor.description')}</DialogDescription>
        </DialogHeader>
        <ClipEditor {...props} />
      </DialogContent>
    </Dialog>
  );
}

function ClipEditor({ source, name, maxSeconds, onApply, onClose }: ClipEditorProps) {
  const { t } = useTranslation();
  const prefix = useId();
  const container = useRef<HTMLDivElement>(null);
  const waveform = useRef<WaveSurfer | null>(null);
  const region = useRef<Region | null>(null);
  const zoom = useRef(0);
  const [states, setStates] = useState<Clip[]>([]);
  const [selection, setSelection] = useState<Range | null>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState('');
  const clip = states.at(-1);
  const duration = clip ? clipSeconds(clip) : 0;
  const tooLong = maxSeconds != null && duration > maxSeconds;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const blob =
          typeof source === 'string'
            ? await (await apiFetch(source, { signal: controller.signal })).blob()
            : source;
        const decoded = await decodeClip(blob);
        if (controller.signal.aborted) return;
        if (clipSeconds(decoded) < MIN_CLIP_SECONDS) throw new Error('Audio too short');
        setStates([decoded]);
      } catch (error) {
        if (!controller.signal.aborted) setFailed(describeError(error));
      }
    })();
    return () => controller.abort();
  }, [source]);

  // One waveform per version of the clip: an edit redraws it, and the
  // selection starts over as the whole clip (or the usable first part).
  useEffect(() => {
    if (!clip || !container.current) return;
    const length = clipSeconds(clip);
    const url = createObjectUrl(clipToWav(clip));
    const regions = Regions.create();
    const wave = WaveSurfer.create({
      container: container.current,
      url: url ?? undefined,
      peaks: [clipPeaks(clip)],
      duration: length,
      height: 128,
      ...waveColors(container.current),
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      plugins: [regions],
    });
    waveform.current = wave;
    zoom.current = 0;
    let release: (() => void) | null = null;
    const stopped = () => {
      release?.();
      release = null;
      setPlaying(false);
    };
    wave.on('play', () => {
      release?.();
      release = claimPlayback(() => wave.pause(), 'clip-editor');
      setPlaying(true);
    });
    wave.on('pause', stopped);
    wave.on('finish', stopped);
    regions.on('region-created', (created) => {
      for (const other of regions.getRegions()) if (other !== created) other.remove();
      // The plugin swallows a drag that starts on a region, so a selection
      // covering the clip could never be redrawn. Only its edges take the
      // pointer; a drag anywhere inside draws a new selection.
      if (created.element) {
        created.element.style.pointerEvents = 'none';
        for (const handle of created.element.querySelectorAll<HTMLElement>(
          '[part*="region-handle"]',
        ))
          Object.assign(handle.style, { pointerEvents: 'auto', background: 'var(--primary)' });
      }
      region.current = created;
      setSelection({ start: created.start, end: created.end });
    });
    regions.on('region-updated', (updated) =>
      setSelection({ start: updated.start, end: updated.end }),
    );
    const disableDrag = regions.enableDragSelection({
      color: SELECTION_COLOR,
      drag: false,
      minLength: MIN_CLIP_SECONDS,
    });
    wave.once('ready', () =>
      regions.addRegion({
        start: 0,
        end: maxSeconds != null ? Math.min(length, maxSeconds) : length,
        color: SELECTION_COLOR,
        drag: false,
        minLength: MIN_CLIP_SECONDS,
      }),
    );
    return () => {
      disableDrag();
      stopped();
      wave.destroy();
      waveform.current = null;
      region.current = null;
      setSelection(null);
      revokeObjectUrl(url);
    };
  }, [clip, maxSeconds]);

  const select = (key: keyof Range, value: number) => {
    if (!selection || !Number.isFinite(value)) return;
    const next =
      key === 'start'
        ? { ...selection, start: Math.max(0, Math.min(value, selection.end - MIN_CLIP_SECONDS)) }
        : {
            ...selection,
            end: Math.min(duration, Math.max(value, selection.start + MIN_CLIP_SECONDS)),
          };
    region.current?.setOptions(next);
    setSelection(next);
  };
  const wholeClip = !selection || (selection.start <= 0.001 && selection.end >= duration - 0.001);
  const canCut = Boolean(
    clip && selection && duration - (selection.end - selection.start) >= MIN_CLIP_SECONDS,
  );
  const edit = (operation: typeof keepRange) => {
    if (!clip || !selection) return;
    let next: Clip;
    try {
      next = operation(clip, selection.start, selection.end);
    } catch {
      return; // Out-of-range selections are disabled; a race just keeps the clip.
    }
    change((previous) => {
      const kept = [...previous, next];
      if (kept.length > UNDO_LIMIT + 1) kept.splice(1, 1);
      return kept;
    });
  };
  // The button just pressed is often disabled by its own edit, which would drop
  // focus out of the dialog and its shortcuts; the waveform takes it instead.
  const change = (update: (previous: Clip[]) => Clip[]) => {
    setStates(update);
    container.current?.focus();
  };
  const keep = () => !wholeClip && edit(keepRange);
  const cut = () => canCut && edit(removeRange);
  const undo = () => change((previous) => (previous.length > 1 ? previous.slice(0, -1) : previous));
  const magnify = (factor: number) => {
    const fit = (container.current?.clientWidth || 600) / Math.max(duration, MIN_CLIP_SECONDS);
    zoom.current = Math.min(2000, Math.max(fit, (zoom.current || fit) * factor));
    waveform.current?.zoom(zoom.current);
  };
  const apply = () => {
    if (!clip || states.length < 2 || tooLong) return;
    onApply(new File([clipToWav(clip)], editedClipName(name), { type: 'audio/wav' }), duration);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      cut();
    } else if (event.key === ' ' && !target.closest('button')) {
      event.preventDefault();
      void waveform.current?.playPause();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" onKeyDown={onKeyDown}>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('gallery.trim_load_failed', { message: failed })}
        </p>
      ) : !clip ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('trimmer.decoding')}
        </p>
      ) : null}
      <div
        ref={container}
        tabIndex={clip ? 0 : -1}
        aria-label={t('clipEditor.waveform')}
        className="min-h-[128px] overflow-hidden rounded-lg bg-muted/30 p-2 text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        hidden={Boolean(failed)}
      />
      {clip && (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              size="icon-sm"
              className="rounded-full"
              aria-label={t(playing ? 'player.pause' : 'player.play')}
              aria-pressed={playing}
              aria-keyshortcuts="Space"
              onClick={() => void waveform.current?.playPause()}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('trimmer.preview_selection')}
              disabled={!selection}
              onClick={() => region.current?.play(true)}
            >
              <RepeatIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('trimmer.zoom_in')}
              onClick={() => magnify(2)}
            >
              <ZoomInIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('trimmer.zoom_out')}
              onClick={() => magnify(0.5)}
            >
              <ZoomOutIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('trimmer.fit_all')}
              onClick={() => {
                zoom.current = 0;
                waveform.current?.zoom(0);
              }}
            >
              <MaximizeIcon />
            </Button>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {t('trimmer.length_label')}: {duration.toFixed(2)} {t('trimmer.unit_seconds')}
            </span>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            {(['start', 'end'] as const).map((key) => (
              <div key={key} className="flex flex-col gap-1.5">
                <label htmlFor={`${prefix}-${key}`} className="text-xs text-muted-foreground">
                  {t(`trimmer.${key}_label`)}
                </label>
                <Input
                  id={`${prefix}-${key}`}
                  type="number"
                  min={0}
                  max={duration}
                  step="0.01"
                  disabled={!selection}
                  value={selection ? Number(selection[key].toFixed(2)) : ''}
                  onChange={(event) => select(key, event.target.valueAsNumber)}
                  className="w-28 tabular-nums"
                />
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={wholeClip}
                onClick={keep}
              >
                <CropIcon data-icon="inline-start" />
                {t('clipEditor.keep_selection')}
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!canCut}
                aria-keyshortcuts="Delete"
                onClick={cut}
              >
                <ScissorsIcon data-icon="inline-start" />
                {t('clipEditor.delete_selection')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={states.length < 2}
                aria-keyshortcuts="Control+Z Meta+Z"
                onClick={undo}
              >
                <Undo2Icon data-icon="inline-start" />
                {t('scriptEdit.undo')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={states.length < 2}
                onClick={() => change((previous) => previous.slice(0, 1))}
              >
                <RotateCcwIcon data-icon="inline-start" />
                {t('gallery.reset')}
              </Button>
            </div>
          </div>
          <p
            role="status"
            className={tooLong ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
          >
            {tooLong
              ? t('clipEditor.too_long', {
                  duration: duration.toFixed(1),
                  max: maxSeconds,
                })
              : t('clipEditor.shortcuts')}
          </p>
        </>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="button" disabled={!clip || states.length < 2 || tooLong} onClick={apply}>
          {t('clipEditor.apply')}
        </Button>
      </DialogFooter>
    </div>
  );
}
