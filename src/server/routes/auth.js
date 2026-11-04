// Sign in: a discoverable passkey assertion identifies both the device and its group, so the
// browser offers every passkey this site has and the one picked decides where you land.
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { challengeOf, saveChallenge, takeChallenge } from '../challenges.js';
import { sessionView } from '../sessions.js';

const PURPOSE = 'sign-in';

function findCredential(db, credentialId) {
  return db
    .prepare(
      `SELECT c.credential_id, c.public_key, c.sign_count, c.transports,
              d.id AS device_id, d.user_handle, d.revoked_at, d.label, d.kind,
              m.id AS member_id, m.name, m.role, m.ended_at,
              g.id AS group_id, g.name AS group_name
         FROM credentials c
         JOIN devices d ON d.id = c.device_id
         JOIN members m ON m.id = d.member_id
         JOIN groups g ON g.id = m.group_id
        WHERE c.credential_id = ?`,
    )
    .get(credentialId);
}

export default async function authRoutes(app, { db, now, rp, rateLimit, sessions, refuse, events, runHook, transact }) {
  const ceremony = { onRequest: rateLimit('ceremony') };

  app.post('/auth/options', ceremony, async () => {
    const options = await generateAuthenticationOptions({
      rpID: rp.id,
      userVerification: 'preferred',
    });
    saveChallenge(db, { challenge: options.challenge, purpose: PURPOSE, data: {}, now: now() });
    return options;
  });

  app.post('/auth/sign-out', async (request, reply) => {
    // A device key is its session cookie, so ending the session would change nothing: forget the device.
    const session = sessions.resolve(request, now());
    if (session?.device.kind === 'key') {
      const forgotten = transact(request, reply, () => {
        runHook('onDeviceRevoked', {
          group: session.group,
          member: session.member,
          device: session.device,
          reason: 'signed-out',
        });
        db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND group_id = ?').run(
          now(),
          session.device.id,
          session.group.id,
        );
        db.prepare('DELETE FROM sessions WHERE device_id = ?').run(session.device.id);
      });
      if (!forgotten) return reply;
      events.publishTo(session.device.id, 'session-revoked', {});
      events.disconnect(session.device.id);
      events.publish(session.group.id, 'members-changed', {});
      sessions.clearCookie(reply);
      return { forgotDevice: true };
    }
    sessions.end(request);
    sessions.clearCookie(reply);
    return reply.code(204).send();
  });

  app.post('/auth', ceremony, async (request, reply) => {
    const response = request.body?.response;
    const challenge = response && challengeOf(response);
    const pending = challenge && takeChallenge(db, { challenge, purpose: PURPOSE, now: now() });
    if (!pending) return refuse(reply, 400, 'bad_challenge');
    const row = typeof response.id === 'string' && findCredential(db, response.id);
    // Unknown (never registered, or its group was deleted), revoked and ended look the same. Saying
    // so only tells the caller that this id can't sign in here, which a failed sign-in shows anyway.
    if (!row || row.revoked_at !== null || row.ended_at !== null) return refuse(reply, 401, 'removed');
    // Discoverable assertions carry the user handle; it must be the one this device registered.
    const userHandle = response.response?.userHandle;
    if (userHandle && userHandle !== row.user_handle) {
      return refuse(reply, 400, 'verification_failed');
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: false,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(row.public_key),
          counter: row.sign_count,
          transports: JSON.parse(row.transports ?? '[]'),
        },
      });
    } catch {
      // The error text can echo challenges; don't log or return it.
      verification = { verified: false };
    }
    if (!verification.verified) return refuse(reply, 400, 'verification_failed');

    const t = now();
    const token = db.transaction(() => {
      db.prepare('UPDATE credentials SET sign_count = ? WHERE credential_id = ?').run(
        verification.authenticationInfo.newCounter,
        row.credential_id,
      );
      db.prepare('UPDATE devices SET last_used_at = ? WHERE id = ?').run(t, row.device_id);
      return sessions.create(row.device_id, t);
    })();
    sessions.setCookie(reply, token, row.kind);
    return sessionView({
      member: { id: row.member_id, name: row.name, role: row.role },
      device: { id: row.device_id, label: row.label, kind: row.kind },
      group: { id: row.group_id, name: row.group_name },
    });
  });
}
