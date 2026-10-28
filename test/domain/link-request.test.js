import { describe, it, expect } from 'vitest';
import {
  LINK_REQUEST_TTL_MS,
  claimLinkRequest,
  completeLinkRequest,
  linkRequestStatus,
  newLinkRequest,
} from '../../src/domain/link-request.js';
import { defineRoles } from '../../src/domain/roles.js';

const roles = defineRoles(
  {
    admin: ['link', 'manageMembers', 'deleteGroup'],
    collaborator: ['link'],
    contributor: [],
    viewer: [],
  },
  { admin: 'admin', linked: 'viewer' },
);

const T0 = 1_000_000;
const admin = { role: 'admin', passkeyId: 'pk-admin', groupId: 'group-a' };

function claimed(now = T0) {
  const result = claimLinkRequest(newLinkRequest(T0), admin, now, roles);
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
      linked_by: null,
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
    const result = claimLinkRequest(newLinkRequest(T0), admin, T0 + 1, roles);
    expect(result).toEqual({
      ok: true,
      request: {
        ...newLinkRequest(T0),
        status: 'claimed',
        group_id: 'group-a',
        role: 'viewer',
        linked_by: 'pk-admin',
      },
    });
  });

  it.each(['admin', 'collaborator'])('lets a %s claim', (role) => {
    const result = claimLinkRequest(newLinkRequest(T0), { ...admin, role }, T0, roles);
    expect(result.ok).toBe(true);
    expect(result.request.role).toBe('viewer');
  });

  it.each(['contributor', 'viewer', 'nobody'])(
    'forbids a %s and leaves the request alone',
    (role) => {
      const request = newLinkRequest(T0);
      const result = claimLinkRequest(request, { ...admin, role }, T0, roles);
      expect(result).toEqual({ ok: false, reason: 'forbidden' });
      expect(linkRequestStatus(request, T0)).toBe('pending');
    },
  );

  it('rejects an expired request', () => {
    const request = newLinkRequest(T0);
    expect(claimLinkRequest(request, admin, request.expires_at, roles)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a request that is already claimed, by any group', () => {
    expect(claimLinkRequest(claimed(), admin, T0 + 2, roles)).toEqual({
      ok: false,
      reason: 'taken',
    });
    expect(
      claimLinkRequest(
        claimed(),
        { ...admin, groupId: 'group-b', passkeyId: 'pk-b' },
        T0 + 2,
        roles,
      ),
    ).toEqual({ ok: false, reason: 'taken' });
  });

  it('rejects a completed request', () => {
    const done = completeLinkRequest(claimed(), T0 + 1).request;
    expect(claimLinkRequest(done, admin, T0 + 2, roles)).toEqual({ ok: false, reason: 'taken' });
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
