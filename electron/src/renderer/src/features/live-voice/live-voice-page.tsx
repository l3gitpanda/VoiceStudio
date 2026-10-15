import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MicIcon, SquareIcon } from 'lucide-react';
import { WorkspaceHeader } from '@/components/app-shell/workspace-header';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useProfiles } from '@/hooks/use-profiles';
import { setLiveVoiceSettings, useLiveVoiceSettings } from '@/lib/store/live-voice-settings';
import { DevicePickers } from './device-pickers';
import { LatencyReadout } from './latency-readout';
import { LiveVoiceSetup } from './live-voice-setup';
import { QualityControls } from './quality-controls';
import { maySpeakAs, TargetVoicePicker } from './target-voice-picker';
import { TypeToTalk } from './type-to-talk';
import { useLiveVoiceSession, useLiveVoiceStatus } from './use-live-voice';
import { VirtualCableHelp } from './virtual-cable-help';

export function LiveVoicePage() {
  const { t } = useTranslation();
  const status = useLiveVoiceStatus();
  const profiles = useProfiles();
  const settings = useLiveVoiceSettings();
  const session = useLiveVoiceSession();
  const enabled = status.data?.enabled === true;
  // Seed-VC installed: the voice changer itself. Type to talk needs only `enabled`.
  const ready = enabled && status.data?.available === true;
  const active = session.stage !== 'idle';
  const { refetch } = status;
  // A session that just ended still reads "busy" until the next poll.
  useEffect(() => {
    if (!active) void refetch();
  }, [active, refetch]);
  const voice = (profiles.data ?? []).find((p) => p.id === settings.profileId);
  const eligible = !!voice && maySpeakAs(voice);
  const canStart = ready && !active && eligible && !status.data?.busy;
  const stageLabel =
    session.stage === 'connecting'
      ? t('liveVoice.connecting')
      : session.stage === 'loading'
        ? t('liveVoice.loading')
        : session.stage === 'running'
          ? t('liveVoice.running')
          : '';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader>
        <h1 className="text-sm font-medium">{t('liveVoice.title')}</h1>
      </WorkspaceHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto w-full max-w-3xl space-y-6">
          <p className="text-sm text-muted-foreground">{t('liveVoice.subtitle')}</p>
          <LiveVoiceSetup
            status={status.data}
            failed={status.isError && !status.data}
            retry={() => void status.refetch()}
          />
          {enabled && (
            <>
              <DevicePickers
                inputDeviceId={settings.inputDeviceId}
                outputDeviceId={settings.outputDeviceId}
                disabled={active}
                onInputChange={(inputDeviceId) => setLiveVoiceSettings({ inputDeviceId })}
                onOutputChange={(outputDeviceId) =>
                  setLiveVoiceSettings({ outputDeviceId, monitor: outputDeviceId ? settings.monitor : false })
                }
              />
              <TargetVoicePicker
                profiles={profiles.data ?? []}
                value={settings.profileId}
                disabled={active}
                onChange={(profileId) => setLiveVoiceSettings({ profileId })}
              />
            </>
          )}
          {ready && (
            <>
              <QualityControls
                value={settings.preset}
                disabled={active}
                onChange={(preset) => setLiveVoiceSettings({ preset })}
              />
              <div className="space-y-3">
                <label className="flex items-center gap-3 text-sm">
                  <Switch checked={session.bypass} onCheckedChange={session.setBypass} />
                  {t('liveVoice.bypass')}
                </label>
                <div className="space-y-1">
                  <label className="flex items-center gap-3 text-sm">
                    <Switch
                      checked={settings.monitor && !!settings.outputDeviceId}
                      disabled={!settings.outputDeviceId}
                      onCheckedChange={(monitor) => {
                        setLiveVoiceSettings({ monitor });
                        session.setMonitor(monitor);
                      }}
                    />
                    {t('liveVoice.monitor')}
                  </label>
                  <p className="text-xs text-muted-foreground">{t('liveVoice.monitor_hint')}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {active ? (
                  <Button className="min-w-40" variant="secondary" onClick={session.stop}>
                    <SquareIcon />
                    {t('liveVoice.stop')}
                  </Button>
                ) : (
                  <Button className="min-w-40" disabled={!canStart} onClick={() => void session.start(settings)}>
                    <MicIcon />
                    {t('liveVoice.start')}
                  </Button>
                )}
                {stageLabel && (
                  <span role="status" className="text-sm text-muted-foreground">
                    {stageLabel}
                  </span>
                )}
              </div>
              {session.error && (
                <div role="alert" className="space-y-1 rounded-lg border border-destructive/40 p-3 text-sm">
                  <p>{t(`liveVoice.error_${session.error.code}`)}</p>
                  {session.error.detail && (
                    <p className="text-xs text-muted-foreground">
                      {session.error.code === 'mic_failed' ? t(session.error.detail) : session.error.detail}
                    </p>
                  )}
                </div>
              )}
              {session.ready && session.stage === 'running' && (
                <LatencyReadout ready={session.ready} stats={session.stats} playback={session.playback} />
              )}
            </>
          )}
          {enabled && (
            <>
              <TypeToTalk
                profileId={eligible ? settings.profileId : ''}
                deviceId={settings.outputDeviceId}
                monitor={settings.monitor}
              />
              <VirtualCableHelp />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
