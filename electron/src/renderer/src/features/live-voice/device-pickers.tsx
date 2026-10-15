import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  listAudioDevices,
  needsLabelPermission,
  supportsOutputSelection,
  unlockDeviceLabels,
} from '@/lib/audio/live-vc/devices';

const DEFAULT = '__default__';

export function DeviceSelect({
  label,
  devices,
  value,
  disabled,
  onChange,
}: {
  label: string;
  devices: MediaDeviceInfo[];
  value: string;
  disabled: boolean;
  onChange: (deviceId: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const items = [
    { value: DEFAULT, label: t('liveVoice.default_device') },
    ...devices.map((d, i) => ({
      value: d.deviceId,
      label: d.label || t('liveVoice.device_number', { number: i + 1 }),
    })),
  ];
  const selected = items.some((item) => item.value === value) ? value : DEFAULT;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className="text-[length:var(--text-label)] text-muted-foreground">
        {label}
      </Label>
      <Select
        items={items}
        value={selected}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === 'string') onChange(next === DEFAULT ? '' : next);
        }}
      >
        <SelectTrigger id={id} className="w-full" size="sm" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function DevicePickers({
  inputDeviceId,
  outputDeviceId,
  disabled,
  onInputChange,
  onOutputChange,
}: {
  inputDeviceId: string;
  outputDeviceId: string;
  disabled: boolean;
  onInputChange: (deviceId: string) => void;
  onOutputChange: (deviceId: string) => void;
}) {
  const { t } = useTranslation();
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const refresh = useCallback(async () => {
    const found = await listAudioDevices().catch(() => ({ inputs: [], outputs: [] }));
    setInputs(found.inputs);
    setOutputs(found.outputs);
  }, []);
  useEffect(() => {
    void refresh();
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    media?.addEventListener?.('devicechange', refresh);
    return () => media?.removeEventListener?.('devicechange', refresh);
  }, [refresh]);
  const canRoute = supportsOutputSelection();
  return (
    <section className="space-y-3" aria-label={t('liveVoice.devices')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('liveVoice.devices')}</h3>
        <div className="flex items-center gap-1">
          {needsLabelPermission([...inputs, ...outputs]) && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => void unlockDeviceLabels().then(refresh, () => {})}
            >
              {t('liveVoice.show_device_names')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label={t('liveVoice.refresh_devices')}
            onClick={() => void refresh()}
          >
            <RefreshCwIcon />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <DeviceSelect
          label={t('liveVoice.input_device')}
          devices={inputs}
          value={inputDeviceId}
          disabled={disabled}
          onChange={onInputChange}
        />
        <DeviceSelect
          label={t('liveVoice.output_device')}
          devices={canRoute ? outputs : []}
          value={canRoute ? outputDeviceId : ''}
          disabled={disabled || !canRoute}
          onChange={onOutputChange}
        />
      </div>
      {!canRoute && <p className="text-xs text-muted-foreground">{t('liveVoice.output_unsupported')}</p>}
    </section>
  );
}
