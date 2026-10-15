import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/switch';
import { getBridge } from '@/components/bridge';
import { systemAudioSupported } from '@/lib/audio/system-audio';
import { setLiveVoiceSettings, useLiveVoiceSettings } from '@/lib/store/live-voice-settings';
import { SettingsRow } from './settings-layout';

/**
 * Opt-in: offer "System audio" (what this computer plays) as an input in Live
 * Voice and the recorders. Windows only; other systems get their own route.
 */
export function SystemAudioSetting() {
  const { t } = useTranslation();
  const { systemAudio } = useLiveVoiceSettings();
  const supported = systemAudioSupported();
  const platform = getBridge()?.app.platform;
  const note = supported
    ? null
    : platform === 'linux'
      ? t('settings.system_audio_linux')
      : platform === 'darwin'
        ? t('settings.system_audio_mac')
        : null;
  return (
    <SettingsRow
      id="system-audio"
      title={t('settings.system_audio_input')}
      description={
        <>
          {t('settings.system_audio_input_note')}
          {note && <span className="mt-1 block">{note}</span>}
        </>
      }
    >
      <Switch
        aria-label={t('settings.system_audio_input')}
        checked={supported && systemAudio}
        disabled={!supported}
        onCheckedChange={(on) => setLiveVoiceSettings({ systemAudio: on })}
      />
    </SettingsRow>
  );
}
