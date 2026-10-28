// Manage a group's members (its passkeys): list, rename, change role, revoke, leave. Every query
// is scoped to the session's group; the rules live in the app's roles (defineRoles). Event data
// carries no secrets.
import { MAX_LABEL, cleanText } from '../../domain/text.js';

const COLUMNS = 'id, label, role, created_at, last_used_at';
const REFUSALS = {
  forbidden: [403, 'manage_forbidden'],
  invalidRole: [400, 'invalid_role'],
  lastAdmin: [409, 'last_admin'],
};

function item(row, session) {
  return { ...row, current: row.id === session.passkey.id };
}

export default async function memberRoutes(app, { db, now, roles, events, sessions, hooks, refuse }) {
  const signedIn = { onRequest: app.requireSession };
  const refuseVerdict = (reply, verdict) => refuse(reply, ...REFUSALS[verdict.reason]);

  /** A live passkey of the group, or undefined. Never reads across groups. */
  const findLive = (groupId, id) =>
    db.prepare(`SELECT ${COLUMNS} FROM passkeys WHERE id = ? AND group_id = ? AND revoked_at IS NULL`).get(id, groupId);

  /** How many live admins the group has, for the last-admin guard. */
  const adminCount = (groupId) =>
    db
      .prepare(`SELECT COUNT(*) FROM passkeys WHERE group_id = ? AND role = ? AND revoked_at IS NULL`)
      .pluck()
      .get(groupId, roles.admin);

  /** Revokes the passkey and ends its sessions in one transaction, then tells everyone. */
  function revokePasskey(groupId, actorId, target, action) {
    const at = now();
    db.transaction(() => {
      db.prepare('UPDATE passkeys SET revoked_at = ? WHERE id = ? AND group_id = ?').run(at, target.id, groupId);
      db.prepare('DELETE FROM sessions WHERE passkey_id = ?').run(target.id);
      hooks.onAudit(db, {
        groupId,
        actorId,
        action,
        target: target.id,
        detail: { label: target.label },
        at,
      });
    })();
    // Only the revoked passkey's own streams hear session-revoked, and then they end.
    events.publishTo(target.id, 'session-revoked', {});
    events.disconnect(target.id);
    events.publish(groupId, 'members-changed', {});
  }

  app.get('/members', signedIn, async (request) => {
    const { session } = request;
    const rows = db
      .prepare(
        `SELECT ${COLUMNS} FROM passkeys
          WHERE group_id = ? AND revoked_at IS NULL
          ORDER BY created_at, id`,
      )
      .all(session.group.id);
    return rows.map((row) => item(row, session));
  });

  app.patch('/members/:id', signedIn, async (request, reply) => {
    const { session } = request;
    const groupId = session.group.id;
    const target = findLive(groupId, request.params.id);
    if (!target) return refuse(reply, 404, 'member_not_found');

    const body = request.body ?? {};
    const hasLabel = body.label !== undefined;
    const hasRole = body.role !== undefined;
    const changes = [];
    if (hasLabel) changes.push({ action: 'rename' });
    if (hasRole) changes.push({ action: 'setRole', role: body.role });
    // An empty body is still checked, so someone who can't manage members gets 403, not 400.
    const admins = adminCount(groupId);
    for (const change of changes.length ? changes : [{ action: 'rename' }]) {
      const verdict = roles.canManageMember(session.passkey, target, change, admins);
      if (!verdict.ok) return refuseVerdict(reply, verdict);
    }
    if (!hasLabel && !hasRole) return refuse(reply, 400, 'nothing_to_change');
    const label = hasLabel ? cleanText(body.label, MAX_LABEL) : target.label;
    if (!label) return refuse(reply, 400, 'label_required');
    const role = hasRole ? body.role : target.role;

    const renamed = label !== target.label;
    const roleChanged = role !== target.role;
    if (!renamed && !roleChanged) return item(target, session);

    const at = now();
    const audit = (action, from, to) =>
      hooks.onAudit(db, {
        groupId,
        actorId: session.passkey.id,
        action,
        target: target.id,
        detail: { from, to },
        at,
      });
    db.transaction(() => {
      db.prepare('UPDATE passkeys SET label = ?, role = ? WHERE id = ? AND group_id = ?').run(
        label,
        role,
        target.id,
        groupId,
      );
      if (roleChanged) audit('role-change', target.role, role);
      if (renamed) audit('rename', target.label, label);
    })();
    if (roleChanged) events.publishTo(target.id, 'role-changed', { role });
    events.publish(groupId, 'members-changed', {});
    return item(findLive(groupId, target.id), session);
  });

  app.delete('/members/:id', signedIn, async (request, reply) => {
    const { session } = request;
    const target = findLive(session.group.id, request.params.id);
    if (!target) return refuse(reply, 404, 'member_not_found');
    const admins = adminCount(session.group.id);
    const verdict = roles.canManageMember(session.passkey, target, { action: 'revoke' }, admins);
    if (!verdict.ok) return refuseVerdict(reply, verdict);

    revokePasskey(session.group.id, session.passkey.id, target, 'revoke');
    if (target.id === session.passkey.id) sessions.clearCookie(reply);
    return reply.code(204).send();
  });

  app.post('/members/leave', signedIn, async (request, reply) => {
    const { session } = request;
    const admins = adminCount(session.group.id);
    const leave = { action: 'leave' };
    const verdict = roles.canManageMember(session.passkey, session.passkey, leave, admins);
    if (!verdict.ok) return refuseVerdict(reply, verdict);

    revokePasskey(session.group.id, session.passkey.id, session.passkey, 'leave');
    sessions.clearCookie(reply);
    return reply.code(204).send();
  });
}
