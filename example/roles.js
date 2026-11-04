// The example's roles, shared by its server and its page.
import { defineRoles } from '../src/domain/index.js';

export const roles = defineRoles(
  {
    // 'link', 'manageMembers', 'deleteGroup' and 'linkOwnDevice' are velvet-rope's; the rest are the example's.
    admin: ['read', 'write', 'delete', 'link', 'manageMembers', 'deleteGroup', 'linkOwnDevice'],
    collaborator: ['read', 'write', 'delete', 'link'],
    contributor: ['read', 'write'],
    viewer: ['read'],
  },
  { admin: 'admin', linked: 'viewer' },
);

/** Contributors edit only the notes they wrote; collaborators and admins edit any. */
export function canEditNote(session, note) {
  if (roles.can(session.member.role, 'delete')) return true;
  return roles.can(session.member.role, 'write') && note.created_by === session.member.id;
}
