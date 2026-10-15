import { RadioIcon, SquareIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { supportsOutputSelection } from '@/lib/audio/live-vc/devices';
import { useLiveVoiceSettings } from '@/lib/store/live-voice-settings';

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/**
 * Plays a generated clip into the virtual microphone (the output device chosen
 * in Settings → Performance or in Live Voice), so Discord, a game or a stream
 * hears it as the mic — no download step. Hidden until a device is chosen, so
 * screens are unchanged for everyone who never sets one up.
 */
export function PlayToMicButton({
  url,
  createAudio = () => new Audio(),
}: {
  url?: string;
  createAudio?: () => HTMLAudioElement;
}) {
  const { t } = useTranslation();
  const { outputDeviceId } = useLiveVoiceSettings();
  const [playing, setPlaying] = useState(false);
  const audio = useRef<SinkAudio | null>(null);
  const stop = () => {
    const current = audio.current;
    audio.current = null;
    if (current) {
      current.pause();
      current.removeAttribute('src');
      current.load();
    }
    setPlaying(false);
  };
  useEffect(() => stop, []);
  useEffect(() => stop(), [url, outputDeviceId]);
  if (!outputDeviceId || !supportsOutputSelection()) return null;

  const play = async () => {
    if (!url) return;
    stop();
    const element = createAudio() as SinkAudio;
    audio.current = element;
    try {
      if (typeof element.setSinkId !== 'function') throw new Error('output selection unsupported');
      await element.setSinkId(outputDeviceId);
      element.src = url;
      element.onended = () => {
        if (audio.current === element) stop();
      };
      setPlaying(true);
      await element.play();
    } catch {
      if (audio.current === element) stop();
      toast.error(t('micOutput.failed'));
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={!url}
      title={t('micOutput.play_hint')}
      aria-pressed={playing}
      onClick={() => (playing ? stop() : void play())}
    >
      {playing ? <SquareIcon /> : <RadioIcon />}
      {playing ? t('micOutput.stop') : t('micOutput.play')}
    </Button>
  );
}
