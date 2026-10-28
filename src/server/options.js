// Turns the plugin's options into the context every route gets. Defaults live here, so a route
// never has to wonder whether an option was given.
import { wrapDatabase } from './db/index.js';
import { createHub } from './hub.js';
import { defaultMessages } from './messages.js';
import { createSessions } from './sessions.js';

export const GROUP_CREATION_MODES = Object.freeze(['open', 'invite', 'closed']);

const noLimit = async () => {};
const noop = () => {};

export function resolveOptions(options) {
  const { rp, roles } = options;
  if (!options.db) {
    throw new Error('velvet-rope: `db` (a better-sqlite3 or node:sqlite database) is required');
  }
  const db = wrapDatabase(options.db);
  if (!rp?.id || !rp?.name || !rp?.origin) {
    throw new Error('velvet-rope: `rp` needs { id, name, origin }');
  }
  if (typeof roles?.canManageMember !== 'function') {
    throw new Error('velvet-rope: `roles` must come from defineRoles()');
  }
  const groupCreation = options.groupCreation ?? 'open';
  if (!GROUP_CREATION_MODES.includes(groupCreation)) {
    throw new Error('velvet-rope: `groupCreation` must be open, invite or closed');
  }

  // Behind HTTPS the session cookie carries the __Host- prefix, so the browser only accepts it
  // Secure, host-only and on Path=/. Plain-http localhost (dev) can't use the prefix.
  const cookiePrefix = options.cookiePrefix ?? 'velvet_rope';
  const secure = rp.origin.startsWith('https://');
  const cookies = {
    session: `${secure ? '__Host-' : ''}${cookiePrefix}_session`,
    link: `${cookiePrefix}_link`,
  };
  const csrfHeader = options.csrfHeader ?? 'X-Velvet-Rope';
  const messages = { ...defaultMessages({ roles, csrfHeader }), ...options.messages };
  const now = options.now ?? Date.now;

  return {
    db,
    now,
    rp,
    roles,
    prefix: (options.prefix ?? '/api').replace(/\/$/, ''),
    cookies,
    csrfHeader,
    groupCreation,
    rateLimit: options.rateLimit ?? (() => noLimit),
    events: options.events ?? createHub(),
    heartbeatMs: options.heartbeatMs,
    hooks: { onAudit: noop, onGroupCreated: noop, onGroupDeleted: noop, ...options.hooks },
    messages,
    sessions: createSessions({ db, cookieName: cookies.session }),
    /** Sends { error: code, message } with the app's wording for `code`. */
    refuse: (reply, status, code) => reply.code(status).send({ error: code, message: messages[code] ?? code }),
  };
}
