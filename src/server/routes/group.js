// DELETE /group removes the signed-in group (needs 'deleteGroup'). Every row that belongs to it
// goes through ON DELETE CASCADE: members, their devices and the devices' credentials and sessions, link requests, and
// any app table that references groups(id) the same way.
export default async function currentGroupRoutes(app, { db, roles, events, sessions, runHook, transact, refuse }) {
  app.delete('/group', { onRequest: app.requireSession }, async (request, reply) => {
    const { session } = request;
    if (!roles.can(session.member.role, 'deleteGroup')) {
      return refuse(reply, 403, 'delete_forbidden');
    }
    const { id, name } = session.group;
    // The client asks for the name to be typed; the server checks it too.
    if (request.body?.name !== name) return refuse(reply, 400, 'confirm_name');

    const deviceIds = db.prepare('SELECT id FROM devices WHERE group_id = ?').pluck().all(id);
    const deleted = transact(request, reply, () => {
      runHook('onGroupDeleting', session.group);
      db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    });
    if (!deleted) return reply;
    // An audit log kept in the group goes with it, so the server log keeps the only record (ids only).
    request.log.info({ groupId: id }, 'group deleted');

    events.publish(id, 'group-deleted', { name });
    for (const deviceId of deviceIds) events.disconnect(deviceId);
    sessions.clearCookie(reply);
    return reply.code(204).send();
  });
}
