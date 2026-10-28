// Join a group by QR. The new device creates a request and shows its token as a QR; a signed-in
// scanner claims it (the scan is the approval: no prompt, no code, no step-up); the new device
// then registers its own passkey for the claimed group, starting with the linked role. The token
// travels only in a JSON body, an HttpOnly cookie or a URL fragment, never in a URL path or
// query, and is stored only as its SHA-256 hash. Tokens are never logged.
import { randomUUID } from 'node:crypto';
import {
  LINK_REQUEST_TTL_MS,
  claimLinkRequest,
  completeLinkRequest,
  linkRequestStatus,
  newLinkRequest,
} from '../../domain/link-request.js';
import { MAX_LABEL, cleanText } from '../../domain/text.js';
import { challengeOf, saveChallenge, takeChallenge } from '../challenges.js';
import { createHub } from '../hub.js';
import { insertPasskey, registrationOptions, verifyRegistration } from '../registration.js';
import { readCookie } from '../sessions.js';
import { eventStreams } from '../stream.js';
import { randomToken, sha256Hex } from '../tokens.js';

const PURPOSE = 'link';
const CLAIM_REFUSALS = {
  forbidden: [403, 'link_forbidden'],
  expired: [410, 'link_expired'],
  taken: [409, 'link_taken'],
};

function findByTokenHash(db, tokenHash) {
  return db
    .prepare(
      `SELECT lr.*, g.name AS group_name
         FROM link_requests lr
         LEFT JOIN groups g ON g.id = lr.group_id
        WHERE lr.token_hash = ?`,
    )
    .get(tokenHash);
}

function statusBody(row, now) {
  const status = linkRequestStatus(row, now);
  const body = { status, expiresAt: row.expires_at };
  if ((status === 'claimed' || status === 'completed') && row.group_name) {
    body.groupName = row.group_name;
  }
  return body;
}

export default async function linkRequestRoutes(
  app,
  { db, now, rp, roles, prefix, cookies, events, heartbeatMs, rateLimit, sessions, hooks, refuse },
) {
  const ceremony = { onRequest: rateLimit('ceremony') };
  const joining = { onRequest: rateLimit('linkRequest') };
  const stream = eventStreams(app, heartbeatMs);
  // Status events live on their own hub, keyed by request id, so they can never reach a group's
  // subscribers or another request's.
  const statusHub = createHub();

  const linkCookie = (value, maxAge) =>
    `${cookies.link}=${value}; Path=${prefix}/link-requests; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

  /** The new device's own request, from its link cookie. */
  const currentRequest = (request) => {
    const token = readCookie(request.headers.cookie, cookies.link);
    return token ? findByTokenHash(db, sha256Hex(token)) : undefined;
  };

  const publishStatus = (tokenHash) => {
    const row = findByTokenHash(db, tokenHash);
    statusHub.publish(row.id, 'status', statusBody(row, now()));
  };

  app.post('/link-requests', joining, async (request, reply) => {
    const label = cleanText(request.body?.label, MAX_LABEL);
    if (!label) return refuse(reply, 400, 'label_required');

    const t = now();
    // Prune requests nobody finished, like challenges.
    db.prepare('DELETE FROM link_requests WHERE expires_at <= ?').run(t);
    const token = randomToken();
    const id = randomUUID();
    const row = newLinkRequest(t);
    db.prepare(
      `INSERT INTO link_requests (id, token_hash, label, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, sha256Hex(token), label, row.status, row.created_at, row.expires_at);

    reply.header('set-cookie', linkCookie(token, Math.floor(LINK_REQUEST_TTL_MS / 1000)));
    return reply.code(201).send({ id, token, expiresAt: row.expires_at });
  });

  app.get('/link-requests/current', async (request, reply) => {
    const row = currentRequest(request);
    if (!row) return refuse(reply, 404, 'link_not_found');
    return statusBody(row, now());
  });

  app.get('/link-requests/current/events', async (request, reply) => {
    const row = currentRequest(request);
    if (!row) return refuse(reply, 404, 'link_not_found');
    const send = stream(request, reply, (sendEvent) => statusHub.subscribe(row.id, sendEvent));
    send('status', statusBody(row, now()));
  });

  app.post('/link-requests/claim', joining, async (request, reply) => {
    const session = sessions.resolve(request, now());
    if (!session) return refuse(reply, 401, 'not_signed_in');
    const token = request.body?.token;
    const tokenHash = typeof token === 'string' && token ? sha256Hex(token) : null;
    const row = tokenHash && findByTokenHash(db, tokenHash);
    if (!row) return refuse(reply, 410, 'link_expired');

    const scanner = {
      role: session.passkey.role,
      passkeyId: session.passkey.id,
      groupId: session.group.id,
    };
    const result = claimLinkRequest(row, scanner, now(), roles);
    if (!result.ok) return refuse(reply, ...CLAIM_REFUSALS[result.reason]);

    const claimed = result.request;
    db.prepare(
      `UPDATE link_requests SET status = ?, group_id = ?, role = ?, linked_by = ? WHERE id = ?`,
    ).run(claimed.status, claimed.group_id, claimed.role, claimed.linked_by, row.id);
    publishStatus(tokenHash);
    return { label: row.label };
  });

  app.post('/link-requests/current/options', ceremony, async (request, reply) => {
    const row = currentRequest(request);
    if (!row) return refuse(reply, 404, 'link_not_found');
    if (linkRequestStatus(row, now()) !== 'claimed') {
      return refuse(reply, 409, 'link_not_claimed');
    }

    const existing = db
      .prepare(
        `SELECT c.credential_id, c.transports
           FROM credentials c
           JOIN passkeys p ON p.id = c.passkey_id
          WHERE p.group_id = ? AND p.revoked_at IS NULL`,
      )
      .all(row.group_id);
    const options = await registrationOptions(rp, {
      name: `${row.group_name} · ${row.label}`,
      // Ask for this device's own authenticator, not the browser's "use a phone" QR.
      localDevice: true,
      excludeCredentials: existing.map((c) => ({
        id: c.credential_id,
        transports: JSON.parse(c.transports ?? '[]'),
      })),
    });
    saveChallenge(db, {
      challenge: options.challenge,
      purpose: PURPOSE,
      data: { requestId: row.id, userHandle: options.user.id },
      now: now(),
    });
    return options;
  });

  app.post('/link-requests/current/complete', ceremony, async (request, reply) => {
    const row = currentRequest(request);
    if (!row) return refuse(reply, 404, 'link_not_found');
    const response = request.body?.response;
    const challenge = response && challengeOf(response);
    const pending = challenge && takeChallenge(db, { challenge, purpose: PURPOSE, now: now() });
    if (!pending || pending.requestId !== row.id) return refuse(reply, 400, 'bad_challenge');

    const registrationInfo = await verifyRegistration(rp, response, challenge);
    if (!registrationInfo) return refuse(reply, 400, 'verification_failed');

    const t = now();
    const result = db.transaction(() => {
      // Re-read inside the transaction: the request may have changed during verification.
      const fresh = findByTokenHash(db, row.token_hash);
      const done = completeLinkRequest(fresh, t);
      if (!done.ok) return null;
      const passkey = insertPasskey(db, {
        groupId: fresh.group_id,
        label: fresh.label,
        role: fresh.role,
        userHandle: pending.userHandle,
        registrationInfo,
        now: t,
      });
      db.prepare(`UPDATE link_requests SET status = 'completed' WHERE id = ?`).run(fresh.id);
      hooks.onAudit(db, {
        groupId: fresh.group_id,
        actorId: fresh.linked_by,
        action: 'link',
        target: passkey.id,
        detail: { label: passkey.label, role: passkey.role },
        at: t,
      });
      const token = sessions.create(passkey.id, t);
      return { token, passkey, group: { id: fresh.group_id, name: fresh.group_name } };
    })();
    if (!result) return refuse(reply, 409, 'link_incomplete');

    sessions.setCookie(reply, result.token);
    reply.header('set-cookie', linkCookie('', 0));
    publishStatus(row.token_hash);
    events.publish(result.group.id, 'members-changed', {
      id: result.passkey.id,
      label: result.passkey.label,
    });
    return reply.code(201).send({ passkey: result.passkey, group: result.group });
  });
}
