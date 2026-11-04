// Manage one device of a member: rename it or revoke it (a lost phone). A member always manages
// their own devices; someone else's need manageMembers (see canManageDevice). Revoking never ends
// the member, even when it was their last device. Every query is scoped to the session's group.
// The app's onDeviceRevoked hook runs inside the transaction and can veto; events go out after.
// A device-key device can also gain a passkey in place (no scan): it keeps its id, label and member.
import { MAX_LABEL, cleanText } from '../../domain/text.js';
import { challengeOf, saveChallenge, takeChallenge } from '../challenges.js';
import { Refusal } from '../hooks.js';
import { insertCredential, registrationOptions, verifyRegistration } from '../registration.js';
import { sessionView } from '../sessions.js';

const PURPOSE = 'upgrade';

export default async function deviceRoutes(
  app,
  { db, now, rp, roles, events, credentials, rateLimit, sessions, runHook, transact, refuse },
) {
  const signedIn = { onRequest: app.requireSession };
  const upgrading = { onRequest: [app.requireSession, rateLimit('ceremony')] };

  /** A live device of the group, with its member, or undefined. Never reads across groups. */
  const findLive = (groupId, id) => {
    const row = db
      .prepare(
        `SELECT d.id, d.label, d.kind, m.id AS member_id, m.name AS member_name, m.role AS member_role
           FROM devices d JOIN members m ON m.id = d.member_id
          WHERE d.id = ? AND d.group_id = ? AND d.revoked_at IS NULL`,
      )
      .get(id, groupId);
    if (!row) return undefined;
    return {
      device: { id: row.id, label: row.label, kind: row.kind },
      member: { id: row.member_id, name: row.member_name, role: row.member_role },
    };
  };

  /** The device the session may manage with `action`, or undefined after replying with the refusal. */
  function manageable(request, reply, action) {
    const { session } = request;
    const found = findLive(session.group.id, request.params.id);
    if (!found) return void refuse(reply, 404, 'device_not_found');
    const verdict = roles.canManageDevice(session.member, { memberId: found.member.id }, action);
    if (!verdict.ok) return void refuse(reply, 403, 'manage_forbidden');
    return found;
  }

  // Both upgrade routes refuse a device that is not a key device, or a policy without passkeys.
  app.post('/devices/current/passkey/options', upgrading, async (request, reply) => {
    const { session } = request;
    if (session.device.kind !== 'key') return refuse(reply, 409, 'already_passkey');
    if (!credentials.includes('passkey')) return refuse(reply, 403, 'passkey_not_allowed');

    const existing = db
      .prepare(
        `SELECT c.credential_id, c.transports
           FROM credentials c
           JOIN devices d ON d.id = c.device_id
          WHERE d.group_id = ? AND d.revoked_at IS NULL`,
      )
      .all(session.group.id);
    const options = await registrationOptions(rp, {
      name: session.device.label,
      localDevice: true,
      excludeCredentials: existing.map((c) => ({
        id: c.credential_id,
        transports: JSON.parse(c.transports ?? '[]'),
      })),
    });
    saveChallenge(db, {
      challenge: options.challenge,
      purpose: PURPOSE,
      data: { deviceId: session.device.id, userHandle: options.user.id },
      now: now(),
    });
    return options;
  });

  app.post('/devices/current/passkey', upgrading, async (request, reply) => {
    const { session } = request;
    if (session.device.kind !== 'key') return refuse(reply, 409, 'already_passkey');
    if (!credentials.includes('passkey')) return refuse(reply, 403, 'passkey_not_allowed');
    const response = request.body?.response;
    const challenge = response && challengeOf(response);
    const pending = challenge && takeChallenge(db, { challenge, purpose: PURPOSE, now: now() });
    if (!pending || pending.deviceId !== session.device.id) return refuse(reply, 400, 'bad_challenge');

    const registrationInfo = await verifyRegistration(rp, response, challenge);
    if (!registrationInfo) return refuse(reply, 400, 'verification_failed');

    const upgraded = transact(request, reply, () => {
      // Re-check inside the transaction: another request may have upgraded this device meanwhile.
      const changed = db
        .prepare(
          `UPDATE devices SET user_handle = ?, kind = 'passkey'
            WHERE id = ? AND group_id = ? AND kind = 'key' AND revoked_at IS NULL`,
        )
        .run(pending.userHandle, session.device.id, session.group.id);
      if (!changed.changes) throw new Refusal(409, 'already_passkey');
      insertCredential(db, { deviceId: session.device.id, registrationInfo });
    });
    if (!upgraded) return reply;

    sessions.setCookie(reply, session.token, 'passkey');
    events.publish(session.group.id, 'members-changed', {});
    return sessionView({ ...session, device: { ...session.device, kind: 'passkey' } });
  });

  app.patch('/devices/:id', signedIn, async (request, reply) => {
    const { session } = request;
    const found = manageable(request, reply, 'rename');
    if (!found) return reply;
    const label = cleanText(request.body?.label, MAX_LABEL);
    if (!label) return refuse(reply, 400, 'label_required');

    if (label !== found.device.label) {
      const changed = transact(request, reply, () => {
        db.prepare('UPDATE devices SET label = ? WHERE id = ? AND group_id = ?').run(
          label,
          found.device.id,
          session.group.id,
        );
        runHook('onAudit', {
          groupId: session.group.id,
          actorId: session.member.id,
          action: 'rename-device',
          target: found.device.id,
          detail: { from: found.device.label, to: label },
          at: now(),
        });
      });
      if (!changed) return reply;
      events.publish(session.group.id, 'members-changed', {});
    }
    return { id: found.device.id, label, kind: found.device.kind };
  });

  app.delete('/devices/:id', signedIn, async (request, reply) => {
    const { session } = request;
    const found = manageable(request, reply, 'revoke');
    if (!found) return reply;

    const at = now();
    const revoked = transact(request, reply, () => {
      runHook('onDeviceRevoked', {
        group: session.group,
        member: found.member,
        device: found.device,
        reason: 'revoked',
      });
      db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND group_id = ?').run(
        at,
        found.device.id,
        session.group.id,
      );
      db.prepare('DELETE FROM sessions WHERE device_id = ?').run(found.device.id);
      runHook('onAudit', {
        groupId: session.group.id,
        actorId: session.member.id,
        action: 'revoke-device',
        target: found.device.id,
        detail: { label: found.device.label, memberId: found.member.id },
        at,
      });
    });
    if (!revoked) return reply;

    events.publishTo(found.device.id, 'session-revoked', {});
    events.disconnect(found.device.id);
    events.publish(session.group.id, 'members-changed', {});
    if (found.device.id === session.device.id) sessions.clearCookie(reply);
    return reply.code(204).send();
  });
}
