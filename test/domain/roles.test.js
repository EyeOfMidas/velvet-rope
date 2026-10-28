import { describe, it, expect } from 'vitest';
import { defineRoles } from '../../src/domain/roles.js';

// A four-role sample matrix: an admin, a role that can link, and two that can't.
const roles = defineRoles(
  {
    admin: ['read', 'write', 'link', 'manageMembers', 'deleteGroup'],
    collaborator: ['read', 'write', 'link'],
    contributor: ['read', 'write'],
    viewer: ['read'],
  },
  { admin: 'admin', linked: 'viewer' },
);
const canManageMember = roles.canManageMember;

describe('defineRoles', () => {
  it('lists the roles in the order given', () => {
    expect(roles.names).toEqual(['admin', 'collaborator', 'contributor', 'viewer']);
    expect(roles.admin).toBe('admin');
    expect(roles.linked).toBe('viewer');
  });

  it('answers can() from the matrix', () => {
    expect(roles.can('admin', 'deleteGroup')).toBe(true);
    expect(roles.can('collaborator', 'link')).toBe(true);
    expect(roles.can('contributor', 'link')).toBe(false);
    expect(roles.can('viewer', 'read')).toBe(true);
  });

  it('denies unknown roles and capabilities', () => {
    expect(roles.can('owner', 'read')).toBe(false);
    expect(roles.can(undefined, 'read')).toBe(false);
    expect(roles.can('admin', 'launchRockets')).toBe(false);
    expect(roles.can('toString', 'read')).toBe(false);
    expect(roles.can('admin', 'toString')).toBe(false);
  });

  it('refuses a matrix whose admin or linked role is missing', () => {
    expect(() => defineRoles({ viewer: [] }, { admin: 'admin', linked: 'viewer' })).toThrow(/admin/);
    expect(() =>
      defineRoles({ admin: ['link', 'manageMembers', 'deleteGroup'] }, { admin: 'admin', linked: 'guest' }),
    ).toThrow(/guest/);
  });

  it('refuses an admin role without the library capabilities', () => {
    expect(() => defineRoles({ admin: ['link'] }, { admin: 'admin', linked: 'admin' })).toThrow(
      /manageMembers, deleteGroup/,
    );
  });
});

// Per-target rules: admins manage any member, other admins included, and
// anyone may leave, but the group always keeps one admin. Each table is actor role (rows) ×
// target role (columns: admin, collaborator, contributor, viewer); each cell is 'ok' or the
// refusal reason. The tables run with two live admins, so the last-admin guard never fires.
describe('canManageMember', () => {
  const TARGETS = ['admin', 'collaborator', 'contributor', 'viewer'];
  const F = 'forbidden';
  const I = 'invalidRole';
  const MANAGE = {
    admin: ['ok', 'ok', 'ok', 'ok'],
    collaborator: [F, F, F, F],
    contributor: [F, F, F, F],
    viewer: [F, F, F, F],
  };
  const TABLES = {
    rename: MANAGE,
    revoke: MANAGE,
    'setRole:admin': MANAGE,
    'setRole:collaborator': MANAGE,
    'setRole:contributor': MANAGE,
    'setRole:viewer': MANAGE,
    'setRole:owner': {
      admin: [I, I, I, I],
      collaborator: [F, F, F, F],
      contributor: [F, F, F, F],
      viewer: [F, F, F, F],
    },
  };

  const changeFor = (name) => {
    const [action, role] = name.split(':');
    return role ? { action, role } : { action };
  };
  const outcome = (result) => (result.ok ? 'ok' : result.reason);
  const check = (actor, target, change, admins = 2) => outcome(canManageMember(actor, target, change, admins));

  for (const [name, table] of Object.entries(TABLES)) {
    for (const [actorRole, row] of Object.entries(table)) {
      TARGETS.forEach((targetRole, i) => {
        it(`${actorRole} ${name} on ${targetRole} → ${row[i]}`, () => {
          const actor = { id: 'actor', role: actorRole };
          const target = { id: 'target', role: targetRole };
          expect(check(actor, target, changeFor(name))).toBe(row[i]);
        });
      });
    }
  }

  it('rejects unknown roles as invalid', () => {
    const admin = { id: 'a', role: 'admin' };
    const viewer = { id: 'b', role: 'viewer' };
    expect(check(admin, viewer, { action: 'setRole', role: 'god' })).toBe(I);
    expect(check(admin, viewer, { action: 'setRole' })).toBe(I);
    expect(check(admin, viewer, { action: 'setRole', role: 'toString' })).toBe(I);
  });

  it('refuses unknown actions and unknown actor roles', () => {
    const viewer = { id: 'b', role: 'viewer' };
    expect(check({ id: 'a', role: 'admin' }, viewer, { action: 'nuke' })).toBe(F);
    expect(check({ id: 'a', role: 'owner' }, viewer, { action: 'rename' })).toBe(F);
    expect(check({ id: 'a', role: 'root' }, viewer, { action: 'rename' })).toBe(F);
  });

  describe('self-targeted changes', () => {
    const self = (role) => ({ id: 'me', role });

    for (const role of TARGETS) {
      it(`${role} can leave`, () => {
        expect(check(self(role), self(role), { action: 'leave' })).toBe('ok');
      });
    }

    it('leave only ever applies to the actor’s own member', () => {
      const admin = { id: 'a', role: 'admin' };
      expect(check(admin, { id: 'b', role: 'viewer' }, { action: 'leave' })).toBe(F);
    });

    it('an admin can revoke, rename and demote their own member', () => {
      const admin = self('admin');
      expect(check(admin, admin, { action: 'revoke' })).toBe('ok');
      expect(check(admin, admin, { action: 'rename' })).toBe('ok');
      expect(check(admin, admin, { action: 'setRole', role: 'viewer' })).toBe('ok');
    });

    it('a collaborator can’t rename their own member', () => {
      expect(check(self('collaborator'), self('collaborator'), { action: 'rename' })).toBe(F);
    });
  });

  describe('the last admin', () => {
    const L = 'lastAdmin';
    const me = { id: 'me', role: 'admin' };
    const other = { id: 'other', role: 'admin' };
    const viewer = { id: 'v', role: 'viewer' };

    it('can’t leave, revoke themselves or step down', () => {
      expect(check(me, me, { action: 'leave' }, 1)).toBe(L);
      expect(check(me, me, { action: 'revoke' }, 1)).toBe(L);
      for (const role of ['collaborator', 'contributor', 'viewer']) {
        expect(check(me, me, { action: 'setRole', role }, 1)).toBe(L);
      }
    });

    it('can still rename themselves and keep the admin role', () => {
      expect(check(me, me, { action: 'rename' }, 1)).toBe('ok');
      expect(check(me, me, { action: 'setRole', role: 'admin' }, 1)).toBe('ok');
    });

    it('doesn’t limit changes to anyone else', () => {
      expect(check(me, viewer, { action: 'revoke' }, 1)).toBe('ok');
      expect(check(me, viewer, { action: 'setRole', role: 'admin' }, 1)).toBe('ok');
      expect(check(viewer, viewer, { action: 'leave' }, 1)).toBe('ok');
    });

    it('lifts once there’s a second admin', () => {
      expect(check(me, me, { action: 'leave' }, 2)).toBe('ok');
      expect(check(me, other, { action: 'revoke' }, 2)).toBe('ok');
      expect(check(me, other, { action: 'setRole', role: 'viewer' }, 2)).toBe('ok');
    });

    it('treats a missing admin count as the last admin, so it fails closed', () => {
      expect(outcome(canManageMember(me, me, { action: 'leave' }))).toBe(L);
    });

    it('reports forbidden, not lastAdmin, to someone who can’t manage members', () => {
      expect(check(viewer, me, { action: 'revoke' }, 1)).toBe(F);
    });
  });
});
