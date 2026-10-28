import { describe, it, expect } from 'vitest';
import { CHALLENGE_TTL_MS, challengeExpiresAt, isChallengeLive } from '../../src/domain/challenges.js';

describe('challenge expiry', () => {
  it('expires five minutes after it is issued', () => {
    expect(CHALLENGE_TTL_MS).toBe(5 * 60 * 1000);
    expect(challengeExpiresAt(10)).toBe(10 + 5 * 60 * 1000);
  });

  it('is live before expiry only', () => {
    expect(isChallengeLive({ expires_at: 100 }, 99)).toBe(true);
    expect(isChallengeLive({ expires_at: 100 }, 100)).toBe(false);
    expect(isChallengeLive(undefined, 0)).toBe(false);
  });
});
