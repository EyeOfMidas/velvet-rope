// Create a group: registration options, then verify and create the group, its first passkey (an
// admin) and a session in one transaction. `groupCreation` decides who may: 'open' (anyone),
// 'invite' (needs a single-use invite code) or 'closed' (nobody).
import { randomUUID } from 'node:crypto';
import { MAX_GROUP_NAME, MAX_LABEL, cleanText } from '../../domain/text.js';
import { challengeOf, saveChallenge, takeChallenge } from '../challenges.js';
import { spendInvite, usableInvite } from '../invites.js';
import { insertPasskey, registrationOptions, verifyRegistration } from '../registration.js';

const PURPOSE = 'create-group';

export default async function groupRoutes(
  app,
  { db, now, rp, roles, groupCreation, rateLimit, sessions, hooks, refuse },
) {
  app.post('/groups/options', { onRequest: rateLimit('groupCreation') }, async (request, reply) => {
    if (groupCreation === 'closed') return refuse(reply, 403, 'group_creation_closed');
    const groupName = cleanText(request.body?.groupName, MAX_GROUP_NAME);
    const label = cleanText(request.body?.label, MAX_LABEL);
    if (!groupName || !label) return refuse(reply, 400, 'names_required');
    // Invite mode: check the code now, spend it only when the group is made.
    let inviteHash;
    if (groupCreation === 'invite') {
      const code = request.body?.invite;
      if (!code) return refuse(reply, 403, 'invite_required');
      inviteHash = usableInvite(db, code, now());
      if (!inviteHash) return refuse(reply, 403, 'invite_invalid');
    }
    const options = await registrationOptions(rp, { name: `${groupName} · ${label}` });
    saveChallenge(db, {
      challenge: options.challenge,
      purpose: PURPOSE,
      data: { groupName, label, userHandle: options.user.id, inviteHash },
      now: now(),
    });
    return options;
  });

  app.post('/groups', { onRequest: rateLimit('ceremony') }, async (request, reply) => {
    if (groupCreation === 'closed') return refuse(reply, 403, 'group_creation_closed');
    const response = request.body?.response;
    const challenge = response && challengeOf(response);
    const pending = challenge && takeChallenge(db, { challenge, purpose: PURPOSE, now: now() });
    if (!pending) return refuse(reply, 400, 'bad_challenge');

    const registrationInfo = await verifyRegistration(rp, response, challenge);
    if (!registrationInfo) return refuse(reply, 400, 'verification_failed');

    const t = now();
    const group = { id: randomUUID(), name: pending.groupName };
    const created = db.transaction(() => {
      if (groupCreation === 'invite' && !spendInvite(db, pending.inviteHash ?? '', t)) return null;
      db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(group.id, group.name, t);
      const passkey = insertPasskey(db, {
        groupId: group.id,
        label: pending.label,
        role: roles.admin,
        userHandle: pending.userHandle,
        registrationInfo,
        now: t,
      });
      hooks.onGroupCreated(db, group);
      return { passkey, token: sessions.create(passkey.id, t) };
    })();

    if (!created) return refuse(reply, 403, 'invite_invalid');
    sessions.setCookie(reply, created.token);
    return reply.code(201).send({ passkey: created.passkey, group });
  });
}
