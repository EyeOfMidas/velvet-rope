// Sessions: a 256-bit random cookie value, stored only as its SHA-256 hash, with a 30-day sliding
// expiry. One session belongs to one passkey; a passkey may have several (one per browser tab
// that signed in is fine).
import { SESSION_TTL_MS, isSessionLive, sessionExpiresAt } from '../domain/sessions.js';
import { randomToken, sha256Hex } from './tokens.js';

export function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Session operations bound to the database and the session cookie's name. */
export function createSessions({ db, cookieName }) {
  const cookie = (value, maxAge) =>
    `${cookieName}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

  return {
    cookieName,

    /** Inserts a session row and returns the raw cookie value (never stored). */
    create(passkeyId, now) {
      const token = randomToken();
      db.prepare(
        'INSERT INTO sessions (id_hash, passkey_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ).run(sha256Hex(token), passkeyId, now, sessionExpiresAt(now));
      return token;
    },

    setCookie(reply, token) {
      reply.header('set-cookie', cookie(token, Math.floor(SESSION_TTL_MS / 1000)));
    },

    clearCookie(reply) {
      reply.header('set-cookie', cookie('', 0));
    },

    /** Deletes the request's session row, if any. Other sessions of the same passkey stay. */
    end(request) {
      const token = readCookie(request.headers.cookie, cookieName);
      if (token) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256Hex(token));
    },

    /**
     * Resolves the request's session to { token, passkey, group }, sliding its expiry, or
     * returns null. Every group-scoped query should take its group id from here.
     */
    resolve(request, now) {
      const token = readCookie(request.headers.cookie, cookieName);
      if (!token) return null;
      const idHash = sha256Hex(token);
      const row = db
        .prepare(
          `SELECT s.expires_at, p.id AS passkey_id, p.label, p.role, g.id AS group_id, g.name AS group_name
             FROM sessions s
             JOIN passkeys p ON p.id = s.passkey_id AND p.revoked_at IS NULL
             JOIN groups g ON g.id = p.group_id
            WHERE s.id_hash = ?`,
        )
        .get(idHash);
      if (!isSessionLive(row, now)) {
        if (row) db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
        return null;
      }
      db.prepare('UPDATE sessions SET expires_at = ? WHERE id_hash = ?').run(
        sessionExpiresAt(now),
        idHash,
      );
      return {
        token,
        passkey: { id: row.passkey_id, label: row.label, role: row.role },
        group: { id: row.group_id, name: row.group_name },
      };
    },
  };
}
