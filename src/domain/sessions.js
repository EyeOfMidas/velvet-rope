// Session lifetime rules: a sliding expiry whose length depends on the device's kind. Pure; callers
// pass the clock and the lifetime.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Default sliding lifetimes by device kind. A device key can't re-sign-in without a scan, so it lasts longer. */
export const DEFAULT_SESSION_TTL_MS = Object.freeze({ passkey: SESSION_TTL_MS, key: 400 * 24 * 60 * 60 * 1000 });

export function sessionExpiresAt(now, ttlMs = SESSION_TTL_MS) {
  return now + ttlMs;
}

export function isSessionLive(session, now) {
  return Boolean(session) && now < session.expires_at;
}
