import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/components/bridge', () => ({ getBridge: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { GithubStar } from './github-star';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('shows the bundled count without contacting GitHub', () => {
  const fetchCount = vi.fn();
  vi.stubGlobal('fetch', fetchCount);
  render(<GithubStar />);
  expect(screen.getByText('43,638')).toBeVisible();
  expect(screen.getByRole('link', { name: 'support.star_github' })).toHaveAttribute(
    'href',
    'https://github.com/debpalash/VoiceStudio',
  );
  expect(fetchCount).not.toHaveBeenCalled();
});
