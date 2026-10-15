import { describe, expect, it } from 'vitest';
import html from '../index.html?raw';

describe('renderer content security policy', () => {
  it('lets the renderer connect only to the local backend', () => {
    const connect = /connect-src ([^;"]+)/.exec(html)?.[1].trim().split(/\s+/);
    expect(connect).toEqual(["'self'", 'blob:', 'ws:', 'http://localhost:*', 'http://127.0.0.1:*']);
  });

  it('embeds no remote frames', () => {
    expect(html).not.toMatch(/frame-src|forms\.gle|google\.com/);
  });
});
