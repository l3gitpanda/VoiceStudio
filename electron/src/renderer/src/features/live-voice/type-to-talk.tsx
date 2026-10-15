import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquareTextIcon, SquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SpeakToMic } from '@/lib/audio/live-vc/speak-to-mic';

const MAX_CHARS = 2000;

/**
 * Type a message and hear it in the selected voice through the virtual
 * microphone. Uses the regular streaming TTS engine, so it works without the
 * Seed-VC engine installed.
 */
export function TypeToTalk({
  profileId,
  deviceId,
  monitor,
  createSpeaker = () => new SpeakToMic(),
}: {
  profileId: string;
  deviceId: string;
  monitor: boolean;
  createSpeaker?: () => Pick<SpeakToMic, 'speak' | 'stop'>;
}) {
  const { t } = useTranslation();
  const speaker = useRef<Pick<SpeakToMic, 'speak' | 'stop'> | null>(null);
  const [text, setText] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => speaker.current?.stop(), []);
  const canSpeak = Boolean(profileId && text.trim()) && !speaking;
  const speak = async () => {
    if (!canSpeak) return;
    speaker.current ??= createSpeaker();
    setError('');
    setSpeaking(true);
    try {
      await speaker.current.speak({ text: text.trim(), profileId, deviceId, monitor });
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSpeaking(false);
    }
  };
  return (
    <section className="space-y-2 rounded-lg border p-4" aria-label={t('liveVoice.type_title')}>
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <MessageSquareTextIcon className="size-4 text-muted-foreground" />
        {t('liveVoice.type_title')}
      </h3>
      <p className="text-sm text-muted-foreground">{t('liveVoice.type_body')}</p>
      <Textarea
        aria-label={t('liveVoice.type_title')}
        placeholder={t('liveVoice.type_placeholder')}
        value={text}
        maxLength={MAX_CHARS}
        rows={3}
        disabled={speaking}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void speak();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        {speaking ? (
          <Button variant="secondary" onClick={() => speaker.current?.stop()}>
            <SquareIcon />
            {t('liveVoice.stop')}
          </Button>
        ) : (
          <Button disabled={!canSpeak} onClick={() => void speak()}>
            <MessageSquareTextIcon />
            {t('liveVoice.type_speak')}
          </Button>
        )}
        {speaking && (
          <span role="status" className="text-sm text-muted-foreground">
            {t('liveVoice.type_speaking')}
          </span>
        )}
      </div>
      {!profileId && <p className="text-xs text-muted-foreground">{t('liveVoice.type_needs_voice')}</p>}
      {!deviceId && <p className="text-xs text-muted-foreground">{t('liveVoice.type_no_device')}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t('liveVoice.type_failed')} <span className="text-xs text-muted-foreground">{error}</span>
        </p>
      )}
    </section>
  );
}
