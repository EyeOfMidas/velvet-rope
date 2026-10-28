// The role matrix. Pure: the app defines its roles once, and both server and client ask
// roles.can(role, capability). There is no owner: a group's creator is just its first admin,
// and all admins are equal. Per-target rules (anyone may leave, the group always keeps one
// admin) are in canManageMember.

/** Capabilities velvet-rope itself checks. The app's admin role must have all of them. */
export const LIBRARY_CAPABILITIES = Object.freeze(['link', 'manageMembers', 'deleteGroup']);

const MANAGE_ACTIONS = new Set(['rename', 'setRole', 'revoke']);
const OK = Object.freeze({ ok: true });
const no = (reason) => ({ ok: false, reason });

/**
 * `grants`: { role: [capability, ...] }, e.g. { admin: ['read', 'link', ...], viewer: ['read'] }.
 * `admin`: the role that manages members and that the last-admin guard protects.
 * `linked`: the role a newly linked device starts with (the lowest one, usually).
 */
export function defineRoles(grants, { admin, linked }) {
  const table = new Map(Object.entries(grants).map(([role, caps]) => [role, new Set(caps)]));
  if (!table.has(admin)) throw new Error(`defineRoles: admin role "${admin}" isn't defined`);
  if (!table.has(linked)) throw new Error(`defineRoles: linked role "${linked}" isn't defined`);
  const missing = LIBRARY_CAPABILITIES.filter((cap) => !table.get(admin).has(cap));
  if (missing.length) {
    throw new Error(`defineRoles: the admin role needs ${missing.join(', ')}`);
  }

  const isRole = (role) => typeof role === 'string' && table.has(role);
  const can = (role, capability) => isRole(role) && table.get(role).has(capability);

  /** Whether `change` would take `target` out of the admins. */
  function removesAdmin(target, change) {
    if (target.role !== admin) return false;
    if (change.action === 'setRole') return change.role !== admin;
    return change.action === 'leave' || change.action === 'revoke';
  }

  /**
   * Per-target member management. `actor` and `target` are { id, role }; `change` is
   * { action: 'rename' | 'setRole' | 'revoke' | 'leave', role? }; `admins` is the group's count
   * of live admins (missing counts as 1, so the guard fails closed).
   * Returns { ok: true } or { ok: false, reason } where reason is one of:
   *   forbidden   — the actor may not do this at all
   *   invalidRole — setRole to an unknown role
   *   lastAdmin   — the change would leave the group with no admin
   */
  function canManageMember(actor, target, change, admins = 1) {
    const action = change?.action;
    if (action === 'leave') {
      if (actor.id !== target.id || !isRole(actor.role)) return no('forbidden');
    } else {
      if (!MANAGE_ACTIONS.has(action) || !can(actor.role, 'manageMembers')) return no('forbidden');
      if (action === 'setRole' && !isRole(change.role)) return no('invalidRole');
    }
    return removesAdmin(target, change) && admins <= 1 ? no('lastAdmin') : OK;
  }

  return Object.freeze({
    names: Object.freeze([...table.keys()]),
    admin,
    linked,
    isRole,
    can,
    canManageMember,
  });
}
