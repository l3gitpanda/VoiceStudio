import { useTranslation } from 'react-i18next';
import { ShieldCheckIcon, WandSparklesIcon } from 'lucide-react';
import { ProfileAvatar } from '@/components/profile-avatar';
import { Button } from '@/components/ui/button';
import type { Profile } from '@/lib/api/types';

/** Every saved voice can be a Live Voice target. */
export function TargetVoicePicker({
  profiles,
  value,
  disabled,
  onChange,
}: {
  profiles: Profile[];
  value: string;
  disabled: boolean;
  onChange: (profileId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-3" aria-label={t('liveVoice.target_voice')}>
      <h3 className="text-sm font-medium">{t('liveVoice.target_voice')}</h3>
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {profiles.map((p) => (
          <Button
            key={p.id}
            variant={value === p.id ? 'secondary' : 'ghost'}
            className="w-full justify-start"
            aria-pressed={value === p.id}
            disabled={disabled}
            onClick={() => onChange(p.id)}
          >
            <ProfileAvatar name={p.name} imageUrl={p.image_url} className="size-6" />
            <span className="min-w-0 flex-1 truncate text-left">{p.name}</span>
            {p.kind === 'design' ? (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <WandSparklesIcon className="size-3" />
                {t('liveVoice.designed')}
              </span>
            ) : p.verified_own_voice ? (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <ShieldCheckIcon className="size-3" />
                {t('liveVoice.verified')}
              </span>
            ) : null}
          </Button>
        ))}
        {!profiles.length && <p className="text-sm text-muted-foreground">{t('liveVoice.no_voices')}</p>}
      </div>
    </section>
  );
}
