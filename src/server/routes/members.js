// Manage a group's members (the people in it): list them with their devices, rename, change role,
// remove, leave. Every query is scoped to the session's group; the rules live in the app's roles
// (defineRoles). Ending a member revokes all their devices and ends their sessions. The app's
// hooks run inside the transaction and can veto; events go out only after it commits. Event data
// carries no secrets.
import { MAX_LABEL, cleanText } from '../../domain/text.js';

const REFUSALS = {
  forbidden: [403, 'manage_forbidden'],
  invalidRole: [400, 'invalid_role'],
  lastAdmin: [409, 'last_admin'],
};

export default async function memberRoutes(app, { db, now, roles, events, sessions, runHook, transact, refuse }) {
  const signedIn = { onRequest: app.requireSession };
  const refuseVerdict = (reply, verdict) => refuse(reply, ...REFUSALS[verdict.reason]);

  /** A live member of the group, or undefined. Never reads across groups. */
  const findLive = (groupId, id) =>
    db
      .prepare('SELECT id, name, role FROM members WHERE id = ? AND group_id = ? AND ended_at IS NULL')
      .get(id, groupId);

  /** How many live admins the group has, for the last-admin guard. */
  const adminCount = (groupId) =>
    db
      .prepare(`SELECT COUNT(*) FROM members WHERE group_id = ? AND role = ? AND ended_at IS NULL`)
      .pluck()
      .get(groupId, roles.admin);

  const liveDeviceIds = (memberId) =>
    db.prepare('SELECT id FROM devices WHERE member_id = ? AND revoked_at IS NULL').pluck().all(memberId);

  /** The group's live members, oldest first, each with their live devices; `current` marks the session's own. */
  function memberViews(session) {
    const groupId = session.group.id;
    const members = db
      .prepare(
        `SELECT id, name, role, created_at FROM members
          WHERE group_id = ? AND ended_at IS NULL ORDER BY created_at, id`,
      )
      .all(groupId);
    const devices = db
      .prepare(
        `SELECT id, member_id, label, kind, last_used_at FROM devices
          WHERE group_id = ? AND revoked_at IS NULL ORDER BY created_at, id`,
      )
      .all(groupId);
    return members.map((member) => ({
      ...member,
      current: member.id === session.member.id,
      devices: devices
        .filter((device) => device.member_id === member.id)
        .map(({ id, label, kind, last_used_at }) => ({
          id,
          label,
          kind,
          last_used_at,
          current: id === session.device.id,
        })),
    }));
  }

  /**
   * Ends the member, revokes their devices and ends their sessions in one transaction. The app's
   * onMemberEnded hook runs first and can veto the whole thing. Then tells everyone, and replies.
   */
  function endMember(request, reply, target, action, reason) {
    const { session } = request;
    const groupId = session.group.id;
    const at = now();
    const ended = transact(request, reply, () => {
      const deviceIds = liveDeviceIds(target.id);
      runHook('onMemberEnded', { group: session.group, member: target, reason, actorId: session.member.id });
      db.prepare('UPDATE members SET ended_at = ?, ended_reason = ? WHERE id = ? AND group_id = ?').run(
        at,
        reason,
        target.id,
        groupId,
      );
      db.prepare('UPDATE devices SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(at, target.id);
      db.prepare('DELETE FROM sessions WHERE device_id IN (SELECT id FROM devices WHERE member_id = ?)').run(target.id);
      runHook('onAudit', {
        groupId,
        actorId: session.member.id,
        action,
        target: target.id,
        detail: { label: target.name },
        at,
      });
      return deviceIds;
    });
    if (!ended) return reply;

    // Only the ended member's own streams hear session-revoked, and then they end.
    for (const id of ended.value) {
      events.publishTo(id, 'session-revoked', {});
      events.disconnect(id);
    }
    events.publish(groupId, 'member-ended', { id: target.id, reason });
    events.publish(groupId, 'members-changed', {});
    if (target.id === session.member.id) sessions.clearCookie(reply);
    return reply.code(204).send();
  }

  app.get('/members', signedIn, async (request) => memberViews(request.session));

  app.patch('/members/:id', signedIn, async (request, reply) => {
    const { session } = request;
    const groupId = session.group.id;
    const target = findLive(groupId, request.params.id);
    if (!target) return refuse(reply, 404, 'member_not_found');

    const body = request.body ?? {};
    // `label` is the deprecated name of `name`, from when a member was a passkey.
    const newName = body.name ?? body.label;
    const hasName = newName !== undefined;
    const hasRole = body.role !== undefined;
    const changes = [];
    if (hasName) changes.push({ action: 'rename' });
    if (hasRole) changes.push({ action: 'setRole', role: body.role });
    // An empty body is still checked, so someone who can't manage members gets 403, not 400.
    const admins = adminCount(groupId);
    for (const change of changes.length ? changes : [{ action: 'rename' }]) {
      const verdict = roles.canManageMember(session.member, target, change, admins);
      if (!verdict.ok) return refuseVerdict(reply, verdict);
    }
    if (!hasName && !hasRole) return refuse(reply, 400, 'nothing_to_change');
    const name = hasName ? cleanText(newName, MAX_LABEL) : target.name;
    if (!name) return refuse(reply, 400, 'name_required');
    const role = hasRole ? body.role : target.role;

    const renamed = name !== target.name;
    const roleChanged = role !== target.role;
    const view = () => memberViews(session).find((member) => member.id === target.id);
    if (!renamed && !roleChanged) return view();

    const at = now();
    const audit = (action, from, to) =>
      runHook('onAudit', { groupId, actorId: session.member.id, action, target: target.id, detail: { from, to }, at });
    const changed = transact(request, reply, () => {
      db.prepare('UPDATE members SET name = ?, role = ? WHERE id = ? AND group_id = ?').run(
        name,
        role,
        target.id,
        groupId,
      );
      if (roleChanged) audit('role-change', target.role, role);
      if (renamed) audit('rename', target.name, name);
    });
    if (!changed) return reply;

    if (roleChanged) for (const id of liveDeviceIds(target.id)) events.publishTo(id, 'role-changed', { role });
    events.publish(groupId, 'members-changed', {});
    return view();
  });

  app.delete('/members/:id', signedIn, async (request, reply) => {
    const { session } = request;
    const target = findLive(session.group.id, request.params.id);
    if (!target) return refuse(reply, 404, 'member_not_found');
    const admins = adminCount(session.group.id);
    const verdict = roles.canManageMember(session.member, target, { action: 'remove' }, admins);
    if (!verdict.ok) return refuseVerdict(reply, verdict);

    return endMember(request, reply, target, 'remove', 'removed');
  });

  app.post('/members/leave', signedIn, async (request, reply) => {
    const { session } = request;
    const admins = adminCount(session.group.id);
    const leave = { action: 'leave' };
    const verdict = roles.canManageMember(session.member, session.member, leave, admins);
    if (!verdict.ok) return refuseVerdict(reply, verdict);

    const target = findLive(session.group.id, session.member.id);
    return endMember(request, reply, target, 'leave', 'leave');
  });
}
