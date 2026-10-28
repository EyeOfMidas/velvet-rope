// Group-creation invites: a 256-bit random code, stored only as its SHA-256 hash, single use.
// Codes are never logged.
import { inviteExpiresAt, isInviteUsable } from '../domain/invites.js';
import { wrapDatabase } from './db/index.js';
import { randomToken, sha256Hex } from './tokens.js';

/** Inserts an invite and returns the raw code (never stored). */
export function createInvite(database, now) {
  const code = randomToken();
  wrapDatabase(database)
    .prepare('INSERT INTO invites (code_hash, created_at, expires_at) VALUES (?, ?, ?)')
    .run(sha256Hex(code), now, inviteExpiresAt(now));
  return code;
}

/** Returns the code's hash if it can make a store now, else null. Doesn't spend it. */
export function usableInvite(db, code, now) {
  if (typeof code !== 'string' || !code) return null;
  const codeHash = sha256Hex(code);
  const row = db.prepare('SELECT * FROM invites WHERE code_hash = ?').get(codeHash);
  return isInviteUsable(row, now) ? codeHash : null;
}

/** Marks the invite used if it still can be; returns whether it was. Call inside the transaction. */
export function spendInvite(db, codeHash, now) {
  return (
    db
      .prepare(
        `UPDATE invites SET used_at = ?
          WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .run(now, codeHash, now).changes === 1
  );
}
