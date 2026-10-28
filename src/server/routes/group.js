// DELETE /group removes the signed-in group (needs 'deleteGroup'). Every row that belongs to it
// goes through ON DELETE CASCADE: passkeys and their credentials and sessions, link requests, and
// any app table that references groups(id) the same way.
export default async function currentGroupRoutes(
  app,
  { db, roles, events, sessions, hooks, refuse },
) {
  app.delete('/group', { onRequest: app.requireSession }, async (request, reply) => {
    const { session } = request;
    if (!roles.can(session.passkey.role, 'deleteGroup')) {
      return refuse(reply, 403, 'delete_forbidden');
    }
    const { id, name } = session.group;
    // The client asks for the name to be typed; the server checks it too.
    if (request.body?.name !== name) return refuse(reply, 400, 'confirm_name');

    const passkeyIds = db.prepare('SELECT id FROM passkeys WHERE group_id = ?').pluck().all(id);
    db.transaction(() => {
      hooks.onGroupDeleted(db, session.group);
      db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    })();
    // An audit log kept in the group goes with it, so the server log keeps the only record (ids only).
    request.log.info({ groupId: id }, 'group deleted');

    events.publish(id, 'group-deleted', { name });
    for (const passkeyId of passkeyIds) events.disconnect(passkeyId);
    sessions.clearCookie(reply);
    return reply.code(204).send();
  });
}
