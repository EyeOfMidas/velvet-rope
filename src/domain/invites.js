// Group-creation invite lifetime (groupCreation: 'invite'). Pure; callers pass the clock.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function inviteExpiresAt(now) {
  return now + INVITE_TTL_MS;
}

/** An invite can make a group if it exists, hasn't been used and hasn't expired. */
export function isInviteUsable(invite, now) {
  return Boolean(invite) && invite.used_at === null && now < invite.expires_at;
}
