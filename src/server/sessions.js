// Sessions: a 256-bit random cookie value, stored only as its SHA-256 hash, with a sliding expiry
// that depends on the device's kind. One session belongs to one device; a device may have several
// (one per browser tab that signed in is fine). The device belongs to a member, whose role decides
// what the session may do.
import { DEFAULT_SESSION_TTL_MS, isSessionLive, sessionExpiresAt } from '../domain/sessions.js';
import { randomToken, sha256Hex } from './tokens.js';

export function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * A session as routes and apps see it, minus the token: { member, device, group } plus the
 * deprecated `passkey` alias of the 0.2 shape ({ id: device.id, label, role }), removed in 0.4.
 */
export function sessionView({ member, device, group }) {
  return { member, device, group, passkey: { id: device.id, label: device.label, role: member.role } };
}

// Browsers cap a cookie's Max-Age at 400 days, so a longer lifetime still sends 400.
const MAX_COOKIE_AGE_MS = 400 * 24 * 60 * 60 * 1000;

/** Session operations bound to the database and the session cookie's name. */
export function createSessions({ db, cookieName, sessionTtlMs = DEFAULT_SESSION_TTL_MS }) {
  const cookie = (value, maxAge) =>
    `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

  return {
    cookieName,

    /** Inserts a session row and returns the raw cookie value (never stored). */
    create(deviceId, now) {
      const token = randomToken();
      const kind = db.prepare('SELECT kind FROM devices WHERE id = ?').pluck().get(deviceId);
      db.prepare('INSERT INTO sessions (id_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
        sha256Hex(token),
        deviceId,
        now,
        sessionExpiresAt(now, sessionTtlMs[kind]),
      );
      return token;
    },

    /** `kind` is the session's device kind; it sets the cookie's Max-Age. */
    setCookie(reply, token, kind) {
      reply.header('set-cookie', cookie(token, Math.floor(Math.min(sessionTtlMs[kind], MAX_COOKIE_AGE_MS) / 1000)));
    },

    clearCookie(reply) {
      reply.header('set-cookie', cookie('', 0));
    },

    /** Deletes the request's session row, if any. Other sessions of the same device stay. */
    end(request) {
      const token = readCookie(request.headers.cookie, cookieName);
      if (token) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256Hex(token));
    },

    /**
     * Resolves the request's session to { token, member, device, group } (see sessionView), sliding its expiry, or
     * returns null. Every group-scoped query should take its group id from here.
     */
    resolve(request, now) {
      const token = readCookie(request.headers.cookie, cookieName);
      if (!token) return null;
      const idHash = sha256Hex(token);
      const row = db
        .prepare(
          `SELECT s.expires_at, m.id AS member_id, m.name, m.role, d.id AS device_id, d.label, d.kind,
                  g.id AS group_id, g.name AS group_name
             FROM sessions s
             JOIN devices d ON d.id = s.device_id AND d.revoked_at IS NULL
             JOIN members m ON m.id = d.member_id AND m.ended_at IS NULL
             JOIN groups g ON g.id = m.group_id
            WHERE s.id_hash = ?`,
        )
        .get(idHash);
      if (!isSessionLive(row, now)) {
        if (row) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
        return null;
      }
      db.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').run(
        sessionExpiresAt(now, sessionTtlMs[row.kind]),
        idHash,
      );
      return {
        token,
        ...sessionView({
          member: { id: row.member_id, name: row.name, role: row.role },
          device: { id: row.device_id, label: row.label, kind: row.kind },
          group: { id: row.group_id, name: row.group_name },
        }),
      };
    },
  };
}
