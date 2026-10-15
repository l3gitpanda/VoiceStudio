import { useTranslation } from 'react-i18next';
import { CableIcon } from 'lucide-react';
import { ExternalLink } from '@/components/external-link';
import { hostOs, type HostOs } from '@/lib/audio/live-vc/devices';

/** Per-OS pointers only: VoiceStudio never bundles or installs audio drivers. */
const GUIDES: Record<HostOs, string> = {
  windows: 'https://vb-audio.com/Cable/',
  mac: 'https://github.com/ExistentialAudio/BlackHole',
  linux: 'https://docs.pipewire.org/page_module_null_sink.html',
};

export function VirtualCableHelp({ os = hostOs() }: { os?: HostOs }) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2 rounded-lg border p-4" aria-label={t('liveVoice.cable_title')}>
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <CableIcon className="size-4 text-muted-foreground" />
        {t('liveVoice.cable_title')}
      </h3>
      <p className="text-sm text-muted-foreground">{t(`liveVoice.cable_body_${os}`)}</p>
      <ExternalLink href={GUIDES[os]}>
        {t('liveVoice.cable_link')}
      </ExternalLink>
    </section>
  );
}
