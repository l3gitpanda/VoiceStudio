import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { DeviceSelect } from '@/features/live-voice/device-pickers';
import {
  listAudioDevices,
  needsLabelPermission,
  supportsOutputSelection,
  unlockDeviceLabels,
} from '@/lib/audio/live-vc/devices';
import { setLiveVoiceSettings, useLiveVoiceSettings } from '@/lib/store/live-voice-settings';
import { SettingsRow } from './settings-layout';

/**
 * The virtual microphone: the output device (usually a virtual audio cable)
 * that Live Voice and "Play into mic" send audio to. Stored per viewer; unset
 * means the feature stays out of sight everywhere.
 */
export function VirtualMicSetting() {
  const { t } = useTranslation();
  const { outputDeviceId } = useLiveVoiceSettings();
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback(async () => {
    const found = await listAudioDevices().catch(() => ({ inputs: [], outputs: [] }));
    setOutputs(found.outputs);
  }, []);
  useEffect(() => {
    void refresh();
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    media?.addEventListener?.('devicechange', refresh);
    return () => media?.removeEventListener?.('devicechange', refresh);
  }, [refresh]);
  const supported = supportsOutputSelection();
  return (
    <SettingsRow id="virtual-mic" title={t('settings.virtual_mic')} description={t('settings.virtual_mic_note')}>
      {supported ? (
        <div className="flex min-w-56 flex-col gap-2">
          <DeviceSelect
            label={t('liveVoice.output_device')}
            devices={outputs}
            value={outputDeviceId}
            disabled={false}
            onChange={(id) => setLiveVoiceSettings(id ? { outputDeviceId: id } : { outputDeviceId: '', monitor: false })}
          />
          {needsLabelPermission(outputs) && (
            <Button size="sm" variant="ghost" onClick={() => void unlockDeviceLabels().then(refresh, () => {})}>
              {t('liveVoice.show_device_names')}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('liveVoice.output_unsupported')}</p>
      )}
    </SettingsRow>
  );
}
