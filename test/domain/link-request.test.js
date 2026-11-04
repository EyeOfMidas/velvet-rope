import { describe, it, expect } from 'vitest';
import {
  LINK_REQUEST_TTL_MS,
  allowedOutcomes,
  claimLinkRequest,
  completeLinkRequest,
  linkRequestStatus,
  newLinkRequest,
  renewLinkRequest,
} from '../../src/domain/link-request.js';
import { defineRoles } from '../../src/domain/roles.js';

const roles = defineRoles(
  {
    admin: ['link', 'manageMembers', 'deleteGroup', 'linkOwnDevice'],
    collaborator: ['link'],
    contributor: [],
    viewer: [],
  },
  { admin: 'admin', linked: 'viewer' },
);

const T0 = 1_000_000;
const admin = { role: 'admin', deviceId: 'dev-admin', groupId: 'group-a', memberId: 'mem-admin' };
const NEW_MEMBER = { outcome: 'new-member' };

function claimed(now = T0) {
  const result = claimLinkRequest(newLinkRequest(T0), admin, now, roles, NEW_MEMBER);
  if (!result.ok) throw new Error(`claim failed: ${result.reason}`);
  return result.request;
}

describe('newLinkRequest', () => {
  it('starts pending, unclaimed, and expires five minutes after creation', () => {
    expect(LINK_REQUEST_TTL_MS).toBe(5 * 60 * 1000);
    expect(newLinkRequest(T0)).toEqual({
      status: 'pending',
      group_id: null,
      role: null,
      claimed_by: null,
      created_at: T0,
      expires_at: T0 + LINK_REQUEST_TTL_MS,
    });
  });
});

describe('linkRequestStatus', () => {
  it('is pending until the expiry instant, then expired', () => {
    const request = newLinkRequest(T0);
    expect(linkRequestStatus(request, request.expires_at - 1)).toBe('pending');
    expect(linkRequestStatus(request, request.expires_at)).toBe('expired');
  });

  it('expires a claimed request that is never completed', () => {
    const request = claimed();
    expect(linkRequestStatus(request, request.expires_at - 1)).toBe('claimed');
    expect(linkRequestStatus(request, request.expires_at)).toBe('expired');
  });

  it('keeps a completed request completed forever', () => {
    const done = completeLinkRequest(claimed(), T0 + 1).request;
    expect(linkRequestStatus(done, T0 + 10 * LINK_REQUEST_TTL_MS)).toBe('completed');
  });
});

describe('claimLinkRequest', () => {
  it('claims a pending request for the scanner’s group with the linked role', () => {
    const result = claimLinkRequest(newLinkRequest(T0), admin, T0 + 1, roles, NEW_MEMBER);
    expect(result).toEqual({
      ok: true,
      request: {
        ...newLinkRequest(T0),
        status: 'claimed',
        group_id: 'group-a',
        role: 'viewer',
        claimed_by: 'dev-admin',
        outcome: 'new-member',
        member_id: null,
        sign_out: 'none',
      },
    });
  });

  it.each(['admin', 'collaborator'])('lets a %s claim', (role) => {
    const result = claimLinkRequest(newLinkRequest(T0), { ...admin, role }, T0, roles, NEW_MEMBER);
    expect(result.ok).toBe(true);
    expect(result.request.role).toBe('viewer');
  });

  it.each(['contributor', 'viewer', 'nobody'])('forbids a %s and leaves the request alone', (role) => {
    const request = newLinkRequest(T0);
    const result = claimLinkRequest(request, { ...admin, role }, T0, roles, NEW_MEMBER);
    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    expect(linkRequestStatus(request, T0)).toBe('pending');
  });

  it('rejects an expired request', () => {
    const request = newLinkRequest(T0);
    expect(claimLinkRequest(request, admin, request.expires_at, roles, NEW_MEMBER)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a request that is already claimed, by any group', () => {
    expect(claimLinkRequest(claimed(), admin, T0 + 2, roles, NEW_MEMBER)).toEqual({
      ok: false,
      reason: 'taken',
    });
    expect(
      claimLinkRequest(claimed(), { ...admin, groupId: 'group-b', deviceId: 'dev-b' }, T0 + 2, roles, NEW_MEMBER),
    ).toEqual({
      ok: false,
      reason: 'taken',
    });
  });

  it('rejects a completed request', () => {
    const done = completeLinkRequest(claimed(), T0 + 1).request;
    expect(claimLinkRequest(done, admin, T0 + 2, roles, NEW_MEMBER)).toEqual({ ok: false, reason: 'taken' });
  });
});

describe('claimLinkRequest outcomes', () => {
  // collaborator: link only; contributor: nothing; admin: everything. A "linker" with
  // linkOwnDevice but not link, and a "manager" with manageMembers only, isolate each capability.
  const caps = defineRoles(
    {
      admin: ['link', 'manageMembers', 'deleteGroup', 'linkOwnDevice'],
      linker: ['link'],
      owner: ['linkOwnDevice'],
      manager: ['manageMembers'],
      viewer: [],
    },
    { admin: 'admin', linked: 'viewer' },
  );
  const claim = (role, options) => claimLinkRequest(newLinkRequest(T0), { ...admin, role }, T0 + 1, caps, options);

  const MATRIX = [
    // outcome, needs (the one role that has only that capability), allowed signOut values
    ['new-member', 'linker', ['none']],
    ['own-device', 'owner', ['none', 'scanner', 'others']],
    ['member', 'manager', ['none', 'others']],
  ];
  const ALL_SIGN_OUT = ['none', 'scanner', 'others'];

  describe.each(MATRIX)('%s', (outcome, role, allowed) => {
    const memberId = outcome === 'member' ? 'mem-target' : undefined;

    it.each(ALL_SIGN_OUT)('with signOut %s and the capability', (signOut) => {
      const result = claim(role, { outcome, memberId, signOut });
      if (!allowed.includes(signOut)) {
        expect(result).toEqual({ ok: false, reason: 'bad_outcome' });
        return;
      }
      expect(result.ok).toBe(true);
      expect(result.request).toMatchObject({
        status: 'claimed',
        group_id: 'group-a',
        claimed_by: 'dev-admin',
        outcome,
        sign_out: signOut,
        member_id: { 'new-member': null, 'own-device': 'mem-admin', member: 'mem-target' }[outcome],
        role: outcome === 'new-member' ? 'viewer' : null,
      });
    });

    it.each(ALL_SIGN_OUT)('forbids signOut %s without the capability', (signOut) => {
      const result = claim('viewer', { outcome, memberId, signOut });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe(allowed.includes(signOut) ? 'forbidden' : 'bad_outcome');
    });

    it('defaults signOut to none', () => {
      expect(claim(role, { outcome, memberId }).request.sign_out).toBe('none');
    });
  });

  it('needs a capability specific to the outcome', () => {
    expect(claim('owner', { outcome: 'new-member' })).toEqual({ ok: false, reason: 'forbidden' });
    expect(claim('linker', { outcome: 'own-device' })).toEqual({ ok: false, reason: 'forbidden' });
    expect(claim('linker', { outcome: 'member', memberId: 'm' })).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('rejects a missing or unknown outcome', () => {
    expect(claim('admin', undefined)).toEqual({ ok: false, reason: 'bad_outcome' });
    expect(claim('admin', {})).toEqual({ ok: false, reason: 'bad_outcome' });
    expect(claim('admin', { outcome: 'nobody' })).toEqual({ ok: false, reason: 'bad_outcome' });
  });

  it('rejects an unknown signOut', () => {
    expect(claim('admin', { outcome: 'own-device', signOut: 'all' })).toEqual({ ok: false, reason: 'bad_outcome' });
  });

  it('needs a memberId for member, and ignores one elsewhere', () => {
    expect(claim('admin', { outcome: 'member' })).toEqual({ ok: false, reason: 'bad_outcome' });
    expect(claim('admin', { outcome: 'member', memberId: '' })).toEqual({ ok: false, reason: 'bad_outcome' });
    expect(claim('admin', { outcome: 'new-member', memberId: 'x' }).request.member_id).toBeNull();
    expect(claim('admin', { outcome: 'own-device', memberId: 'x' }).request.member_id).toBe('mem-admin');
  });

  it('still reports expired and taken', () => {
    const request = newLinkRequest(T0);
    expect(claimLinkRequest(request, admin, request.expires_at, caps, NEW_MEMBER)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(claimLinkRequest(claimed(), admin, T0 + 2, caps, NEW_MEMBER)).toEqual({ ok: false, reason: 'taken' });
  });
});

describe('completeLinkRequest', () => {
  it('completes a claimed request before expiry', () => {
    const request = claimed();
    expect(completeLinkRequest(request, request.expires_at - 1)).toEqual({
      ok: true,
      request: { ...request, status: 'completed' },
    });
  });

  it('rejects a pending request', () => {
    expect(completeLinkRequest(newLinkRequest(T0), T0 + 1)).toEqual({
      ok: false,
      reason: 'not-claimed',
    });
  });

  it('rejects a claimed request after expiry', () => {
    const request = claimed();
    expect(completeLinkRequest(request, request.expires_at)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects completing twice', () => {
    const done = completeLinkRequest(claimed(), T0 + 1).request;
    expect(completeLinkRequest(done, T0 + 2)).toEqual({ ok: false, reason: 'not-claimed' });
  });
});

describe('renewLinkRequest', () => {
  const TTL = 5 * 60 * 1000;
  const MAX = 60 * 60 * 1000;

  it('extends a pending request by the TTL from now', () => {
    const r = renewLinkRequest(newLinkRequest(T0, TTL), T0 + 4 * 60 * 1000, TTL, MAX);
    expect(r.ok).toBe(true);
    expect(r.request.expires_at).toBe(T0 + 9 * 60 * 1000);
  });

  it('stops at created_at plus the max age', () => {
    const r = renewLinkRequest({ ...newLinkRequest(T0, TTL), expires_at: T0 + MAX - 1000 }, T0 + MAX - 2000, TTL, MAX);
    expect(r.request.expires_at).toBe(T0 + MAX);
  });

  it('refuses claimed and expired requests', () => {
    expect(renewLinkRequest(claimed(), T0 + 1, TTL, MAX)).toEqual({ ok: false, reason: 'claimed' });
    const req = newLinkRequest(T0, TTL);
    expect(renewLinkRequest(req, req.expires_at, TTL, MAX)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('allowedOutcomes', () => {
  it('lists what each role may choose, in order', () => {
    expect(allowedOutcomes('admin', roles)).toEqual(['new-member', 'own-device', 'member']);
    expect(allowedOutcomes('collaborator', roles)).toEqual(['new-member']);
    expect(allowedOutcomes('contributor', roles)).toEqual([]);
    expect(allowedOutcomes('viewer', roles)).toEqual([]);
  });
});
