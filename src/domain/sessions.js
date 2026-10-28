// Session lifetime rules: 30-day sliding expiry. Pure; callers pass the clock.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sessionExpiresAt(now) {
  return now + SESSION_TTL_MS;
}

export function isSessionLive(session, now) {
  return Boolean(session) && now < session.expires_at;
}
