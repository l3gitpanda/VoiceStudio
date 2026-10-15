import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: any) => select({ location: { pathname: '/' } }),
  Link: ({ to, activeProps: _activeProps, children, ...props }: any) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/store/workspace', () => ({ setWorkspace: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ apiJson: vi.fn(async () => ({ enabled: false })) }));

import { setLiveVoiceEnabled } from '@/lib/store/live-voice-enabled';
import { WorkspaceNavigation } from './workspace-menu';

afterEach(() => cleanup());

it('lists Live Voice only while the opt-in is on', async () => {
  render(<WorkspaceNavigation />);
  await act(async () => {});
  expect(screen.queryByRole('link', { name: 'nav.live_voice' })).not.toBeInTheDocument();
  act(() => setLiveVoiceEnabled(true));
  expect(screen.getByRole('link', { name: 'nav.live_voice' })).toHaveAttribute('href', '/live-voice');
  act(() => setLiveVoiceEnabled(false));
  expect(screen.queryByRole('link', { name: 'nav.live_voice' })).not.toBeInTheDocument();
});
