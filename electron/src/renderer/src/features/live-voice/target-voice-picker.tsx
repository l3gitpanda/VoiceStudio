import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { ShieldCheckIcon, WandSparklesIcon } from 'lucide-react';
import { ProfileAvatar } from '@/components/profile-avatar';
import { Button } from '@/components/ui/button';
import type { Profile } from '@/lib/api/types';

/**
 * The same rule the backend enforces (core/voice_consent.py): the user's own
 * verified voice, or a designed voice. Others are shown but not selectable.
 */
export function maySpeakAs(profile: Pick<Profile, 'kind' | 'verified_own_voice'>): boolean {
  return profile.kind === 'design' || Boolean(profile.verified_own_voice);
}

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
  const usable = profiles.filter(maySpeakAs);
  const blocked = profiles.filter((p) => !maySpeakAs(p));
  return (
    <section className="space-y-3" aria-label={t('liveVoice.target_voice')}>
      <h3 className="text-sm font-medium">{t('liveVoice.target_voice')}</h3>
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {usable.map((p) => (
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
            ) : (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <ShieldCheckIcon className="size-3" />
                {t('liveVoice.verified')}
              </span>
            )}
          </Button>
        ))}
        {blocked.map((p) => (
          <div
            key={p.id}
            className="flex h-9 items-center gap-2 px-3 text-sm text-muted-foreground"
            aria-disabled="true"
          >
            <ProfileAvatar name={p.name} imageUrl={p.image_url} className="size-6 opacity-60" />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className="text-xs">{t('liveVoice.needs_consent')}</span>
          </div>
        ))}
        {!profiles.length && <p className="text-sm text-muted-foreground">{t('liveVoice.no_voices')}</p>}
      </div>
      {blocked.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('liveVoice.verify_hint')}{' '}
          <Link to="/personas" className="font-medium text-primary hover:underline">
            {t('liveVoice.open_voices')}
          </Link>
        </p>
      )}
    </section>
  );
}
