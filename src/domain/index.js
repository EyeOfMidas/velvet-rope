// velvet-rope/domain: pure rules shared by server and client. No I/O; callers pass the clock.
export { LIBRARY_CAPABILITIES, defineRoles } from './roles.js';
export {
  LINK_REQUEST_TTL_MS,
  claimLinkRequest,
  completeLinkRequest,
  linkRequestStatus,
  newLinkRequest,
} from './link-request.js';
export { SESSION_TTL_MS, isSessionLive, sessionExpiresAt } from './sessions.js';
export { CHALLENGE_TTL_MS, challengeExpiresAt, isChallengeLive } from './challenges.js';
export { INVITE_TTL_MS, inviteExpiresAt, isInviteUsable } from './invites.js';
export { MAX_GROUP_NAME, MAX_LABEL, cleanText } from './text.js';
