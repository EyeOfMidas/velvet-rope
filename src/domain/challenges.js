// WebAuthn challenge lifetime: single-use, five minutes. Pure; callers pass the clock.
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function challengeExpiresAt(now) {
  return now + CHALLENGE_TTL_MS;
}

export function isChallengeLive(challenge, now) {
  return Boolean(challenge) && now < challenge.expires_at;
}
