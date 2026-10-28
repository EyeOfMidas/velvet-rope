// The events velvet-rope publishes on the group's stream (GET /events), for an EventSource the
// app already has open (it may listen for its own events on the same one). Returns stop().
//   members-changed  someone joined, left, or was renamed, re-roled or revoked
//   role-changed     this device's role changed: { role }
//   session-revoked  this device was removed; the server ends the stream
//   group-deleted    an admin deleted the group: { name }; the server ends the stream
const parse = (event) => {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
};

export function connectSessionEvents(
  source,
  {
    onMembersChanged = () => {},
    onRoleChanged = () => {},
    onRevoked = () => {},
    onGroupDeleted = () => {},
  },
) {
  const listeners = {
    'members-changed': () => onMembersChanged(),
    'role-changed': (event) => {
      const role = parse(event)?.role;
      if (typeof role === 'string') onRoleChanged(role);
    },
    // Closing stops EventSource retrying into a 401.
    'session-revoked': () => {
      source.close();
      onRevoked();
    },
    'group-deleted': (event) => {
      source.close();
      onGroupDeleted({ name: parse(event)?.name ?? '' });
    },
  };
  for (const [type, listener] of Object.entries(listeners)) source.addEventListener(type, listener);
  return () => {
    for (const [type, listener] of Object.entries(listeners)) {
      source.removeEventListener?.(type, listener);
    }
  };
}
