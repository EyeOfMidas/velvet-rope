// Join a group by QR. The new device creates a request and shows its token as a QR; a signed-in
// scanner claims it (the scan is the approval: no prompt, no code, no step-up); the new device
// then finishes with its own passkey, or a device key through complete-key, for the claimed group. The scanner chooses what the device
// becomes (a new member starting with the linked role, one of their own devices, or a device of
// another member), and finishing applies it, signing out the devices the scanner chose only then. The token
// travels only in a JSON body, an HttpOnly cookie or a URL fragment, never in a URL path or
// query, and is stored only as its SHA-256 hash. Tokens are never logged.
import { randomUUID } from 'node:crypto';
import {
  allowedOutcomes,
  claimLinkRequest,
  completeLinkRequest,
  linkRequestStatus,
  newLinkRequest,
  renewLinkRequest,
} from '../../domain/link-request.js';
import { MAX_LABEL, cleanText } from '../../domain/text.js';
import { challengeOf, saveChallenge, takeChallenge } from '../challenges.js';
import { Refusal } from '../hooks.js';
import { createHub } from '../hub.js';
import { insertDevice, insertMember, registrationOptions, verifyRegistration } from '../registration.js';
import { readCookie, sessionView } from '../sessions.js';
import { eventStreams } from '../stream.js';
import { randomToken, sha256Hex } from '../tokens.js';

const PURPOSE = 'link';
const CLAIM_REFUSALS = {
  bad_outcome: [400, 'bad_outcome'],
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

function statusBody(row, now, credentials) {
  const status = linkRequestStatus(row, now);
  const body = { status, expiresAt: row.expires_at, credentials };
  if ((status === 'claimed' || status === 'completed') && row.group_name) {
    body.groupName = row.group_name;
  }
  if ((status === 'claimed' || status === 'completed') && row.outcome) body.outcome = row.outcome;
  return body;
}

export default async function linkRequestRoutes(
  app,
  {
    db,
    now,
    rp,
    roles,
    ids,
    prefix,
    cookies,
    events,
    credentials,
    heartbeatMs,
    rateLimit,
    sessions,
    hooks,
    runHook,
    transact,
    refuse,
    attempt,
    maxProfileBytes,
    linkRequestTtlMs,
    linkRequestMaxAgeMs,
  },
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
    statusHub.publish(row.id, 'status', statusBody(row, now(), credentials));
  };

  app.post('/link-requests', joining, async (request, reply) => {
    const label = cleanText(request.body?.label, MAX_LABEL);
    if (!label) return refuse(reply, 400, 'label_required');
    const name = cleanText(request.body?.name, MAX_LABEL) || null;

    // The app vets the profile before anything is stored; its hook may be async, so no transaction.
    let profileJson = null;
    const { profile } = request.body ?? {};
    if (profile !== undefined && profile !== null) {
      if (Buffer.byteLength(JSON.stringify(profile)) > maxProfileBytes) return refuse(reply, 413, 'profile_too_large');
      const vetted = await attempt(request, reply, () => hooks.validateProfile(profile));
      if (!vetted) return reply;
      profileJson = JSON.stringify(vetted.value);
    }

    const t = now();
    // Prune requests nobody finished, like challenges.
    db.prepare('DELETE FROM link_requests WHERE expires_at <= ?').run(t);
    const token = randomToken();
    const id = randomUUID();
    const row = newLinkRequest(t, linkRequestTtlMs);
    db.prepare(
      `INSERT INTO link_requests (id, token_hash, label, name, profile_json, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sha256Hex(token), label, name, profileJson, row.status, row.created_at, row.expires_at);

    reply.header('set-cookie', linkCookie(token, Math.floor(linkRequestMaxAgeMs / 1000)));
    return reply.code(201).send({ id, token, expiresAt: row.expires_at });
  });

  // The new device keeps its code alive while its page is open; token and cookie stay the same.
  app.post('/link-requests/current/renew', joining, async (request, reply) => {
    const row = currentRequest(request);
    if (!row) return refuse(reply, 404, 'link_not_found');
    const result = renewLinkRequest(row, now(), linkRequestTtlMs, linkRequestMaxAgeMs);
    if (!result.ok) {
      return result.reason === 'expired' ? refuse(reply, 410, 'link_expired') : refuse(reply, 409, 'link_not_pending');
    }
    db.prepare('UPDATE link_requests SET expires_at = ? WHERE id = ?').run(result.request.expires_at, row.id);
    publishStatus(row.token_hash);
    return { expiresAt: result.request.expires_at };
  });

  app.get('/link-requests/current', async (request, reply) => {
    const row = currentRequest(request);
    if (!row) return refuse(reply, 404, 'link_not_found');
    return statusBody(row, now(), credentials);
  });

  app.get('/link-requests/current/events', async (request, reply) => {
    const row = currentRequest(request);
    if (!row) return refuse(reply, 404, 'link_not_found');
    const send = stream(request, reply, (sendEvent) => statusHub.subscribe(row.id, sendEvent));
    send('status', statusBody(row, now(), credentials));
  });

  // A scanner previews what they scanned before approving. Read-only; refuses as claim does.
  app.post(
    '/link-requests/peek',
    { onRequest: [app.requireSession, rateLimit('linkRequest')] },
    async (request, reply) => {
      const token = request.body?.token;
      const row = typeof token === 'string' && token ? findByTokenHash(db, sha256Hex(token)) : null;
      if (!row) return refuse(reply, 410, 'link_expired');
      const status = linkRequestStatus(row, now());
      if (status === 'expired') return refuse(reply, 410, 'link_expired');
      if (status !== 'pending') return refuse(reply, 409, 'link_taken');
      return {
        label: row.label,
        name: row.name,
        profile: row.profile_json ? JSON.parse(row.profile_json) : null,
        expiresAt: row.expires_at,
        outcomes: allowedOutcomes(request.session.member.role, roles),
      };
    },
  );

  app.post('/link-requests/claim', joining, async (request, reply) => {
    const session = sessions.resolve(request, now());
    if (!session) return refuse(reply, 401, 'not_signed_in');
    const token = request.body?.token;
    const tokenHash = typeof token === 'string' && token ? sha256Hex(token) : null;
    const row = tokenHash && findByTokenHash(db, tokenHash);
    if (!row) return refuse(reply, 410, 'link_expired');

    const scanner = {
      role: session.member.role,
      deviceId: session.device.id,
      groupId: session.group.id,
      memberId: session.member.id,
    };
    const { outcome, memberId, signOut } = request.body ?? {};
    const result = claimLinkRequest(row, scanner, now(), roles, { outcome, memberId, signOut });
    if (!result.ok) return refuse(reply, ...CLAIM_REFUSALS[result.reason]);
    // A relink target must be a live member of the scanner's own group, taken from the session.
    if (outcome === 'member') {
      const target = db
        .prepare('SELECT 1 FROM members WHERE id = ? AND group_id = ? AND ended_at IS NULL')
        .get(memberId, session.group.id);
      if (!target) return refuse(reply, 404, 'member_not_found');
    }

    const claimed = result.request;
    db.prepare(
      `UPDATE link_requests
          SET status = ?, group_id = ?, role = ?, claimed_by = ?, outcome = ?, member_id = ?, sign_out = ?
        WHERE id = ?`,
    ).run(
      claimed.status,
      claimed.group_id,
      claimed.role,
      claimed.claimed_by,
      claimed.outcome,
      claimed.member_id,
      claimed.sign_out,
      row.id,
    );
    publishStatus(tokenHash);
    return { label: row.label };
  });

  app.post('/link-requests/current/options', ceremony, async (request, reply) => {
    if (!credentials.includes('passkey')) return refuse(reply, 403, 'passkey_not_allowed');
    const row = currentRequest(request);
    if (!row) return refuse(reply, 404, 'link_not_found');
    if (linkRequestStatus(row, now()) !== 'claimed') {
      return refuse(reply, 409, 'link_not_claimed');
    }

    const existing = db
      .prepare(
        `SELECT c.credential_id, c.transports
           FROM credentials c
           JOIN devices d ON d.id = c.device_id
          WHERE d.group_id = ? AND d.revoked_at IS NULL`,
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

  /**
   * Finishes a claimed request with the new device's details ({ kind, userHandle, registrationInfo }):
   * one transaction, then the events, the cookie and the reply. Replies itself, so the passkey join
   * and the device-key join share it.
   *
   * What the device becomes was chosen by the scanner at the claim: a new member, or another device
   * of an existing member (the scanner's own, or one an admin relinks). `sign_out` then says which
   * of that member's other devices end. Nothing is applied unless all of it is, and any hook may
   * veto: the member, the device, the revocations and the request's state all roll back together.
   */
  function finishJoin(request, reply, row, details) {
    const t = now();
    const outcome = transact(request, reply, () => {
      // Re-read inside the transaction: the request may have changed during verification.
      const fresh = findByTokenHash(db, row.token_hash);
      const done = completeLinkRequest(fresh, t);
      if (!done.ok) throw new Refusal(409, 'link_incomplete');
      const group = { id: fresh.group_id, name: fresh.group_name };

      let member;
      if (fresh.outcome === 'new-member') {
        member = insertMember(db, {
          id: ids.member(),
          groupId: group.id,
          name: fresh.name || fresh.label,
          role: fresh.role,
          now: t,
        });
        runHook('onMemberCreated', {
          group,
          member,
          profile: fresh.profile_json ? JSON.parse(fresh.profile_json) : null,
          via: 'link',
        });
      } else {
        // The member may have ended since the claim; they must still be live in the request's group.
        member = db
          .prepare('SELECT id, name, role FROM members WHERE id = ? AND group_id = ? AND ended_at IS NULL')
          .get(fresh.member_id, group.id);
        if (!member) throw new Refusal(409, 'link_incomplete');
      }

      const device = insertDevice(db, {
        id: ids.device(),
        memberId: member.id,
        label: fresh.label,
        kind: details.kind,
        userHandle: details.userHandle,
        registrationInfo: details.registrationInfo,
        now: t,
      });

      const signedOut = [];
      if (fresh.sign_out === 'scanner' || fresh.sign_out === 'others') {
        // The new device is never among them. `others` includes the scanner's device when it is theirs.
        const liveDevice = `SELECT d.id, d.label, d.kind, m.id AS member_id, m.name AS member_name, m.role AS member_role
                              FROM devices d JOIN members m ON m.id = d.member_id
                             WHERE d.group_id = ? AND d.revoked_at IS NULL AND d.id != ?`;
        const leaving =
          fresh.sign_out === 'scanner'
            ? db.prepare(`${liveDevice} AND d.id = ?`).all(group.id, device.id, fresh.claimed_by)
            : db.prepare(`${liveDevice} AND d.member_id = ?`).all(group.id, device.id, member.id);
        for (const old of leaving) {
          runHook('onDeviceRevoked', {
            group,
            member: { id: old.member_id, name: old.member_name, role: old.member_role },
            device: { id: old.id, label: old.label, kind: old.kind },
            reason: 'replaced',
          });
          db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND group_id = ?').run(t, old.id, group.id);
          db.prepare('DELETE FROM sessions WHERE device_id = ?').run(old.id);
          signedOut.push(old.id);
        }
      }

      db.prepare(`UPDATE link_requests SET status = 'completed' WHERE id = ?`).run(fresh.id);
      // The actor is the person who scanned, not the device they scanned with.
      const actorId = db.prepare('SELECT member_id FROM devices WHERE id = ?').pluck().get(fresh.claimed_by) ?? null;
      runHook('onAudit', {
        groupId: group.id,
        actorId,
        action: 'link',
        target: member.id,
        detail:
          fresh.outcome === 'new-member'
            ? { label: member.name, role: member.role }
            : { label: device.label, role: member.role, outcome: fresh.outcome, signedOut },
        at: t,
      });
      const token = sessions.create(device.id, t);
      return { token, member, device, group, signedOut };
    });
    if (!outcome) return reply;

    const result = outcome.value;
    sessions.setCookie(reply, result.token, result.device.kind);
    reply.header('set-cookie', linkCookie('', 0));
    publishStatus(row.token_hash);
    events.publish(result.group.id, 'members-changed', {
      id: result.member.id,
      label: result.member.name,
    });
    for (const id of result.signedOut) {
      events.publishTo(id, 'session-revoked', {});
      events.disconnect(id);
    }
    return reply.code(201).send(sessionView(result));
  }

  app.post('/link-requests/current/complete', ceremony, async (request, reply) => {
    if (!credentials.includes('passkey')) return refuse(reply, 403, 'passkey_not_allowed');
    const row = currentRequest(request);
    if (!row) return refuse(reply, 404, 'link_not_found');
    const response = request.body?.response;
    const challenge = response && challengeOf(response);
    const pending = challenge && takeChallenge(db, { challenge, purpose: PURPOSE, now: now() });
    if (!pending || pending.requestId !== row.id) return refuse(reply, 400, 'bad_challenge');

    const registrationInfo = await verifyRegistration(rp, response, challenge);
    if (!registrationInfo) return refuse(reply, 400, 'verification_failed');

    return finishJoin(request, reply, row, {
      kind: 'passkey',
      userHandle: pending.userHandle,
      registrationInfo,
    });
  });

  // A device that can't make a passkey finishes with a device key: its session cookie is the key,
  // so there is no WebAuthn and no challenge. Only where the app's policy allows keys.
  app.post('/link-requests/current/complete-key', ceremony, async (request, reply) => {
    if (!credentials.includes('key')) return refuse(reply, 403, 'key_not_allowed');
    const row = currentRequest(request);
    if (!row) return refuse(reply, 404, 'link_not_found');
    return finishJoin(request, reply, row, { kind: 'key' });
  });
}
