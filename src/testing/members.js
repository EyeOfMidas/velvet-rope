// Test helpers that work on the database directly, for setting up a scene quickly. Use the real
// routes (and the soft authenticator) when the ceremony itself is what's under test.
import { randomUUID } from 'node:crypto';
import { wrapDatabase } from '../server/db/index.js';
import { createSessions } from '../server/sessions.js';

/**
 * Inserts a member (a passkey, without a credential) into the group and signs it in.
 * Returns { id, token }: send `${cookieName}=${token}` as the cookie.
 */
export function addMember(database, { groupId, role, label = `${role} device`, now = Date.now() }) {
  const db = wrapDatabase(database);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO passkeys (id, group_id, label, role, user_handle, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, groupId, label, role, randomUUID(), now);
  return { id, token: createSession(db, id, now) };
}

/** A new session for an existing passkey; returns the raw cookie value. */
export function createSession(database, passkeyId, now = Date.now()) {
  return createSessions({ db: wrapDatabase(database), cookieName: 'unused' }).create(passkeyId, now);
}
