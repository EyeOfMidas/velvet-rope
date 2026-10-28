// Server-side store for pending WebAuthn ceremonies. Rows are keyed by the challenge's
// SHA-256, so the raw challenge is never stored. Taking a challenge deletes it: single use.
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import { challengeExpiresAt, isChallengeLive } from '../domain/challenges.js';
import { sha256Hex } from './tokens.js';

/** The challenge a WebAuthn response claims to answer (unverified), or null if unreadable. */
export function challengeOf(response) {
  try {
    return decodeClientDataJSON(response.response.clientDataJSON).challenge;
  } catch {
    return null;
  }
}

export function saveChallenge(db, { challenge, purpose, data, now }) {
  db.prepare('DELETE FROM challenges WHERE expires_at <= ?').run(now);
  db.prepare(
    'INSERT INTO challenges (challenge_hash, purpose, data_json, expires_at) VALUES (?, ?, ?, ?)',
  ).run(sha256Hex(challenge), purpose, JSON.stringify(data), challengeExpiresAt(now));
}

/** Returns the ceremony's data, or null if the challenge is unknown, used, expired or for another purpose. */
export function takeChallenge(db, { challenge, purpose, now }) {
  const row = db
    .prepare('DELETE FROM challenges WHERE challenge_hash = ? RETURNING *')
    .get(sha256Hex(challenge));
  if (!row || row.purpose !== purpose || !isChallengeLive(row, now)) return null;
  return JSON.parse(row.data_json);
}
