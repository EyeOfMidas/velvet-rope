// Test helpers that work on the database directly, for setting up a scene quickly. Use the real
// routes (and the soft authenticator) when the ceremony itself is what's under test.
import { randomUUID } from 'node:crypto';
import { wrapDatabase } from '../server/db/index.js';
import { createSessions } from '../server/sessions.js';

/**
 * Inserts a member with one passkey device (without a credential) into the group and signs the
 * device in. Returns { memberId, deviceId, token }: send `${cookieName}=${token}` as the cookie.
 */
export function addMember(database, { groupId, role, label = `${role} device`, now = Date.now() }) {
  const db = wrapDatabase(database);
  const memberId = randomUUID();
  db.prepare('INSERT INTO members (id, group_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)').run(
    memberId,
    groupId,
    label,
    role,
    now,
  );
  const { deviceId, token } = addDevice(db, { memberId, label, now });
  return { memberId, deviceId, token };
}

/**
 * Adds a device to an existing member and signs it in; returns { deviceId, token }. A passkey
 * device gets a user handle (and no credential); a `key` device has none.
 */
export function addDevice(database, { memberId, kind = 'passkey', label = `${kind} device`, now = Date.now() }) {
  const db = wrapDatabase(database);
  const deviceId = randomUUID();
  db.prepare(
    `INSERT INTO devices (id, member_id, group_id, label, kind, user_handle, created_at)
     SELECT ?, id, group_id, ?, ?, ?, ? FROM members WHERE id = ?`,
  ).run(deviceId, label, kind, kind === 'passkey' ? randomUUID() : null, now, memberId);
  return { deviceId, token: createSession(db, deviceId, now) };
}

/** A new session for an existing device; returns the raw cookie value. */
export function createSession(database, deviceId, now = Date.now()) {
  return createSessions({ db: wrapDatabase(database), cookieName: 'unused' }).create(deviceId, now);
}
