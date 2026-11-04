// Create a group: registration options, then verify and create the group, its first member (an
// admin) with their first device, and a session in one transaction. `groupCreation` decides who may: 'open' (anyone),
// 'invite' (needs a single-use invite code) or 'closed' (nobody).
import { MAX_GROUP_NAME, MAX_LABEL, cleanText } from '../../domain/text.js';
import { challengeOf, saveChallenge, takeChallenge } from '../challenges.js';
import { Refusal } from '../hooks.js';
import { spendInvite, hashIfUsable } from '../invites.js';
import { insertDevice, insertMember, registrationOptions, verifyRegistration } from '../registration.js';
import { sessionView } from '../sessions.js';

const PURPOSE = 'create-group';

export default async function groupRoutes(
  app,
  {
    db,
    now,
    rp,
    roles,
    ids,
    groupCreation,
    credentials,
    hooks,
    maxProfileBytes,
    rateLimit,
    sessions,
    runHook,
    transact,
    attempt,
    refuse,
  },
) {
  // The steps both ways of creating a group share: the group, its admin, their first device and
  // a session, in one transaction. `device` is the details insertDevice needs (a passkey's, or a key's).
  function createGroupWithDevice(request, reply, { groupName, name, inviteHash, profile, device: deviceDetails }) {
    const t = now();
    const group = { id: ids.group(), name: groupName };
    const result = transact(request, reply, () => {
      if (groupCreation === 'invite' && !spendInvite(db, inviteHash ?? '', t)) {
        throw new Refusal(403, 'invite_invalid');
      }
      db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(group.id, group.name, t);
      const member = insertMember(db, { id: ids.member(), groupId: group.id, name, role: roles.admin, now: t });
      runHook('onMemberCreated', { group, member, profile, via: 'create-group' });
      const device = insertDevice(db, { id: ids.device(), memberId: member.id, ...deviceDetails, now: t });
      runHook('onGroupCreated', group);
      return { member, device, token: sessions.create(device.id, t) };
    });

    if (!result) return reply;
    const created = result.value;
    sessions.setCookie(reply, created.token, created.device.kind);
    return reply.code(201).send(sessionView({ member: created.member, device: created.device, group }));
  }

  const passkeysOff = !credentials.includes('passkey');

  app.post('/groups/options', { onRequest: rateLimit('groupCreation') }, async (request, reply) => {
    if (passkeysOff) return refuse(reply, 403, 'passkey_not_allowed');
    if (groupCreation === 'closed') return refuse(reply, 403, 'group_creation_closed');
    const groupName = cleanText(request.body?.groupName, MAX_GROUP_NAME);
    const label = cleanText(request.body?.label, MAX_LABEL);
    if (!groupName || !label) return refuse(reply, 400, 'names_required');
    // The member's name is optional and defaults to the device label.
    const name = cleanText(request.body?.name, MAX_LABEL) || label;
    // Invite mode: check the code now, spend it only when the group is made.
    let inviteHash;
    if (groupCreation === 'invite') {
      const code = request.body?.invite;
      if (!code) return refuse(reply, 403, 'invite_required');
      inviteHash = hashIfUsable(db, code, now());
      if (!inviteHash) return refuse(reply, 403, 'invite_invalid');
    }
    const options = await registrationOptions(rp, { name: `${groupName} · ${label}` });
    saveChallenge(db, {
      challenge: options.challenge,
      purpose: PURPOSE,
      data: { groupName, label, name, userHandle: options.user.id, inviteHash },
      now: now(),
    });
    return options;
  });

  app.post('/groups', { onRequest: rateLimit('ceremony') }, async (request, reply) => {
    if (passkeysOff) return refuse(reply, 403, 'passkey_not_allowed');
    if (groupCreation === 'closed') return refuse(reply, 403, 'group_creation_closed');
    const response = request.body?.response;
    const challenge = response && challengeOf(response);
    const pending = challenge && takeChallenge(db, { challenge, purpose: PURPOSE, now: now() });
    if (!pending) return refuse(reply, 400, 'bad_challenge');

    const registrationInfo = await verifyRegistration(rp, response, challenge);
    if (!registrationInfo) return refuse(reply, 400, 'verification_failed');

    return createGroupWithDevice(request, reply, {
      groupName: pending.groupName,
      name: pending.name,
      inviteHash: pending.inviteHash,
      profile: null,
      device: {
        label: pending.label,
        userHandle: pending.userHandle,
        registrationInfo,
      },
    });
  });

  // A device that can't make a passkey creates its group in one step, with a device key.
  app.post('/groups/key', { onRequest: rateLimit('groupCreation') }, async (request, reply) => {
    if (!credentials.includes('key')) return refuse(reply, 403, 'key_not_allowed');
    if (groupCreation === 'closed') return refuse(reply, 403, 'group_creation_closed');
    const groupName = cleanText(request.body?.groupName, MAX_GROUP_NAME);
    const label = cleanText(request.body?.label, MAX_LABEL);
    if (!groupName || !label) return refuse(reply, 400, 'names_required');
    const name = cleanText(request.body?.name, MAX_LABEL) || label;
    let inviteHash;
    if (groupCreation === 'invite') {
      const code = request.body?.invite;
      if (!code) return refuse(reply, 403, 'invite_required');
      inviteHash = hashIfUsable(db, code, now());
      if (!inviteHash) return refuse(reply, 403, 'invite_invalid');
    }
    // The profile is the app's own data: size-checked and vetted before anything is created.
    let profile = null;
    const given = request.body?.profile;
    if (given !== undefined && given !== null) {
      if (Buffer.byteLength(JSON.stringify(given)) > maxProfileBytes) return refuse(reply, 413, 'profile_too_large');
      const vetted = await attempt(request, reply, () => hooks.validateProfile(given));
      if (!vetted) return reply;
      profile = vetted.value;
    }
    return createGroupWithDevice(request, reply, {
      groupName,
      name,
      inviteHash,
      profile,
      device: { label, kind: 'key' },
    });
  });
}
