import { describe, it, expect } from 'vitest';
import { SESSION_TTL_MS, sessionExpiresAt, isSessionLive } from '../../src/domain/sessions.js';

const DAY = 24 * 60 * 60 * 1000;

describe('session expiry', () => {
  it('lasts 30 days from the moment it is issued or refreshed', () => {
    expect(SESSION_TTL_MS).toBe(30 * DAY);
    expect(sessionExpiresAt(1_000, SESSION_TTL_MS)).toBe(1_000 + 30 * DAY);
  });

  it('defaults to 30 days when no lifetime is passed', () => {
    expect(sessionExpiresAt(1_000)).toBe(1_000 + 30 * DAY);
  });

  it('uses the lifetime the caller passes', () => {
    expect(sessionExpiresAt(1_000, 400 * DAY)).toBe(1_000 + 400 * DAY);
  });

  it('is live until its expiry and dead from then on', () => {
    const session = { expires_at: 5_000 };
    expect(isSessionLive(session, 4_999)).toBe(true);
    expect(isSessionLive(session, 5_000)).toBe(false);
    expect(isSessionLive(session, 9_000)).toBe(false);
  });

  it('treats a missing session as not live', () => {
    expect(isSessionLive(undefined, 0)).toBe(false);
  });
});
