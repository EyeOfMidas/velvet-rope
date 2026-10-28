// The link-request lifecycle. Pure: callers pass the clock, the scanner and the app's roles.
//
//   pending ──claim──► claimed ──complete──► completed
//      └────── 5 minutes after creation ──────► expired (derived, never stored)
//
// Claiming doesn't extend the expiry: the whole ceremony has five minutes.
export const LINK_REQUEST_TTL_MS = 5 * 60 * 1000;

export function newLinkRequest(now) {
  return {
    status: 'pending',
    group_id: null,
    role: null,
    linked_by: null,
    created_at: now,
    expires_at: now + LINK_REQUEST_TTL_MS,
  };
}

/** 'pending' | 'claimed' | 'completed' | 'expired' */
export function linkRequestStatus(request, now) {
  if (request.status !== 'completed' && now >= request.expires_at) return 'expired';
  return request.status;
}

/**
 * The scan is the approval: a scanner who can link claims the request for their group. The new
 * device gets `roles.linked`, never more; an admin raises it later.
 * scanner: { role, passkeyId, groupId }. Rejections: 'forbidden', 'expired', 'taken'.
 */
export function claimLinkRequest(request, scanner, now, roles) {
  if (!roles.can(scanner.role, 'link')) return { ok: false, reason: 'forbidden' };
  const status = linkRequestStatus(request, now);
  if (status === 'expired') return { ok: false, reason: 'expired' };
  if (status !== 'pending') return { ok: false, reason: 'taken' };
  return {
    ok: true,
    request: {
      ...request,
      status: 'claimed',
      group_id: scanner.groupId,
      role: roles.linked,
      linked_by: scanner.passkeyId,
    },
  };
}

/** Rejections: 'expired', 'not-claimed'. */
export function completeLinkRequest(request, now) {
  const status = linkRequestStatus(request, now);
  if (status === 'expired') return { ok: false, reason: 'expired' };
  if (status !== 'claimed') return { ok: false, reason: 'not-claimed' };
  return { ok: true, request: { ...request, status: 'completed' } };
}
