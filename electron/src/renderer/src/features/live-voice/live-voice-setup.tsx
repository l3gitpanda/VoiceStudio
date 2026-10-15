import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { EngineInstall } from '@/features/settings/engine-install';
import type { LiveVoiceStatus } from '@/lib/audio/live-vc/protocol';

/**
 * What stands between the user and a live session: the opt-in switch, then
 * the one-click engine install. Renders nothing once both are done.
 */
export function LiveVoiceSetup({
  status,
  failed,
  retry,
}: {
  status: LiveVoiceStatus | undefined;
  failed: boolean;
  retry: () => void;
}) {
  const { t } = useTranslation();
  if (failed) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span>{t('liveVoice.status_failed')}</span>
        <Button size="sm" variant="outline" onClick={retry}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (!status) return null;
  if (!status.enabled) {
    return (
      <section className="space-y-2 rounded-lg border p-4" aria-label={t('liveVoice.setup_off_title')}>
        <h3 className="text-sm font-medium">{t('liveVoice.setup_off_title')}</h3>
        <p className="text-sm text-muted-foreground">{t('liveVoice.setup_off_body')}</p>
        <Link to="/settings/live-voice" className="text-sm font-medium text-primary hover:underline">
          {t('liveVoice.open_settings')}
        </Link>
      </section>
    );
  }
  if (!status.available) {
    return (
      <section className="space-y-3 rounded-lg border p-4" aria-label={t('liveVoice.install_title')}>
        <h3 className="text-sm font-medium">{t('liveVoice.install_title')}</h3>
        <p className="text-sm text-muted-foreground">{t('liveVoice.install_body')}</p>
        {status.install_supported ? (
          <div className="flex justify-start">
            <EngineInstall id={status.engine} />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('liveVoice.install_unsupported')}</p>
        )}
      </section>
    );
  }
  return null;
}
