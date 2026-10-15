import { AudioWaveformIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LiveVoiceSetting } from './live-voice-setting';
import { SettingsSection } from './settings-layout';
import { VirtualMicSetting } from './virtual-mic-setting';

/** Settings → Live Voice: the opt-in voice changer and the virtual microphone. */
export function LiveVoiceSettings() {
  const { t } = useTranslation();
  return (
    <SettingsSection icon={AudioWaveformIcon} title={t('nav.live_voice')}>
      <LiveVoiceSetting />
      <VirtualMicSetting />
    </SettingsSection>
  );
}
