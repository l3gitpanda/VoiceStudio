import { beforeEach, expect, it } from 'vitest';
import routes from '../routes/index.ts?raw';
import {
  readLastSettingsRoute,
  rememberSettingsRoute,
  SETTINGS_ROUTE_STORAGE_KEY,
} from './settings-route';

beforeEach(() => localStorage.clear());

it('restores only real settings routes and defaults to Appearance', () => {
  expect(readLastSettingsRoute()).toBe('/settings/appearance');
  rememberSettingsRoute('/settings/models/diarisation');
  expect(readLastSettingsRoute()).toBe('/settings/models/diarisation');

  localStorage.setItem(SETTINGS_ROUTE_STORAGE_KEY, '/clone');
  expect(readLastSettingsRoute()).toBe('/settings/appearance');

  localStorage.setItem(SETTINGS_ROUTE_STORAGE_KEY, '/settings/workers');
  expect(readLastSettingsRoute()).toBe('/settings/appearance');
});

it('ignores non-settings paths rather than replacing the last page', () => {
  rememberSettingsRoute('/settings/storage');
  rememberSettingsRoute('/projects');
  expect(readLastSettingsRoute()).toBe('/settings/storage');
});

it('remembers every settings page the router can show', () => {
  // A tab missing here reopens Settings on Appearance instead of where you left.
  const paths = [...routes.matchAll(/path: '(\/settings\/[a-z-]+)'/g)].map((match) => match[1]);
  expect(paths).toContain('/settings/live-voice');
  // Logs has never been remembered; this guards the pages that are.
  for (const path of paths.filter((value) => value !== '/settings/logs')) {
    rememberSettingsRoute(path);
    expect(readLastSettingsRoute(), path).toBe(path);
  }
});
