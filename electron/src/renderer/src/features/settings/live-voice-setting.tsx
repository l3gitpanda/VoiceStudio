import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { apiJson } from '@/lib/api/client';
import { setLiveVoiceEnabled } from '@/lib/store/live-voice-enabled';
import { SettingsRow } from './settings-layout';
import { useSettingsAction } from './use-settings-action';

interface RealtimeVcState {
  enabled: boolean;
  env_pinned: boolean;
}

const KEY = ['realtime-vc-setting'] as const;

/** Opt-in switch for the Live Voice real-time voice changer (off by default). */
export function LiveVoiceSetting() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const action = useSettingsAction();
  const query = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => apiJson<RealtimeVcState>('/api/settings/realtime-vc', { signal }),
  });
  const state = query.data;
  return (
    <>
      <SettingsRow id="realtime-vc" title={t('settings.realtime_vc')} description={t('settings.realtime_vc_note')}>
        <Switch
          aria-label={t('settings.realtime_vc')}
          checked={!!state?.enabled}
          disabled={!state || action.busy || state.env_pinned}
          onCheckedChange={(enabled) =>
            void action.run(async () => {
              const saved = await apiJson<RealtimeVcState>('/api/settings/realtime-vc', {
                method: 'PUT',
                body: JSON.stringify({ enabled }),
              });
              client.setQueryData(KEY, saved);
              setLiveVoiceEnabled(saved.enabled);
              void client.invalidateQueries({ queryKey: ['live-voice-status'] });
            })
          }
        />
      </SettingsRow>
      {state?.env_pinned && (
        <p className="p-4 text-sm text-muted-foreground">{t('settings.generate_timeout_shadowed_note')}</p>
      )}
      {(action.error || query.isError) && (
        <div role="alert" className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <span>{t('liveVoice.status_failed')}</span>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
    </>
  );
}
