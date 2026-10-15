import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { QUALITY_PRESETS, type QualityPreset } from '@/lib/audio/live-vc/protocol';

const PRESETS = Object.keys(QUALITY_PRESETS) as QualityPreset[];

export function QualityControls({
  value,
  disabled,
  onChange,
}: {
  value: QualityPreset;
  disabled: boolean;
  onChange: (preset: QualityPreset) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const items = PRESETS.map((preset) => ({ value: preset, label: t(`liveVoice.preset_${preset}`) }));
  return (
    <section className="space-y-1.5" aria-label={t('liveVoice.quality')}>
      <Label htmlFor={id} className="text-[length:var(--text-label)] text-muted-foreground">
        {t('liveVoice.quality')}
      </Label>
      <Select
        items={items}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === 'string' && next in QUALITY_PRESETS) onChange(next as QualityPreset);
        }}
      >
        <SelectTrigger id={id} className="w-full" size="sm" aria-label={t('liveVoice.quality')}>
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
      <p className="text-xs text-muted-foreground">{t('liveVoice.preset_hint')}</p>
    </section>
  );
}
