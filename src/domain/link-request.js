// The link-request lifecycle. Pure: callers pass the clock, the scanner and the app's roles.
//
//   pending ──claim──► claimed ──complete──► completed
//      └────── 5 minutes after creation ──────► expired (derived, never stored)
//
// Claiming doesn't extend the expiry: the whole ceremony has the TTL. A pending request can be
// renewed while its page is open, but never past created_at + maxAgeMs.
export const LINK_REQUEST_TTL_MS = 5 * 60 * 1000;

export function newLinkRequest(now, ttlMs = LINK_REQUEST_TTL_MS) {
  return {
    status: 'pending',
    group_id: null,
    role: null,
    claimed_by: null,
    created_at: now,
    expires_at: now + ttlMs,
  };
}

/** 'pending' | 'claimed' | 'completed' | 'expired' */
export function linkRequestStatus(request, now) {
  if (request.status !== 'completed' && now >= request.expires_at) return 'expired';
  return request.status;
}

// What each outcome needs, who the device joins, and which signOut choices it allows.
const OUTCOMES = {
  'new-member': { capability: 'link', signOut: ['none'] },
  'own-device': { capability: 'linkOwnDevice', signOut: ['none', 'scanner', 'others'] },
  member: { capability: 'manageMembers', signOut: ['none', 'others'] },
};

/**
 * The scan is the approval, and the scanner chooses what the device becomes:
 *   new-member  a new member with `roles.linked`, never more; an admin raises it later
 *   own-device  another device of the scanner's member
 *   member      a device of the member `memberId` (relink); the caller checks that member is
 *               live and in the scanner's group
 * `signOut` ('none' | 'scanner' | 'others') is only recorded here; completion applies it.
 * scanner: { role, deviceId, groupId, memberId }.
 * Rejections: 'bad_outcome', 'forbidden', 'expired', 'taken'.
 */
export function claimLinkRequest(request, scanner, now, roles, { outcome, memberId, signOut = 'none' } = {}) {
  const rule = Object.hasOwn(OUTCOMES, outcome) ? OUTCOMES[outcome] : null;
  if (!rule || !rule.signOut.includes(signOut)) return { ok: false, reason: 'bad_outcome' };
  if (outcome === 'member' && (typeof memberId !== 'string' || !memberId)) return { ok: false, reason: 'bad_outcome' };
  if (!roles.can(scanner.role, rule.capability)) return { ok: false, reason: 'forbidden' };
  const status = linkRequestStatus(request, now);
  if (status === 'expired') return { ok: false, reason: 'expired' };
  if (status !== 'pending') return { ok: false, reason: 'taken' };
  return {
    ok: true,
    request: {
      ...request,
      status: 'claimed',
      group_id: scanner.groupId,
      role: outcome === 'new-member' ? roles.linked : null,
      claimed_by: scanner.deviceId,
      outcome,
      member_id: { 'new-member': null, 'own-device': scanner.memberId, member: memberId }[outcome],
      sign_out: signOut,
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

/** Rejections: 'expired', 'claimed' (a claimed or completed request keeps its expiry). */
export function renewLinkRequest(request, now, ttlMs, maxAgeMs) {
  const status = linkRequestStatus(request, now);
  if (status === 'expired') return { ok: false, reason: 'expired' };
  if (status !== 'pending') return { ok: false, reason: 'claimed' };
  const expires_at = Math.min(now + ttlMs, request.created_at + maxAgeMs);
  return { ok: true, request: { ...request, expires_at: Math.max(expires_at, request.expires_at) } };
}

/** The outcomes a scanner with this role may choose, in the table's order. Claiming enforces the same rule. */
export function allowedOutcomes(role, roles) {
  return Object.keys(OUTCOMES).filter((outcome) => roles.can(role, OUTCOMES[outcome].capability));
}
