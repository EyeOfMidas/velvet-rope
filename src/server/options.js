// Turns the plugin's options into the context every route gets. Defaults live here, so a route
// never has to wonder whether an option was given.
import { randomUUID } from 'node:crypto';
import { DEFAULT_SESSION_TTL_MS } from '../domain/sessions.js';
import { wrapDatabase } from './db/index.js';
import { Refusal, createHookTools } from './hooks.js';
import { createHub } from './hub.js';
import { defaultMessages } from './messages.js';
import { createSessions } from './sessions.js';

const CREDENTIAL_POLICIES = [['passkey'], ['passkey', 'key'], ['key']];

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

  const credentials = options.credentials === undefined ? ['passkey'] : options.credentials;
  if (!CREDENTIAL_POLICIES.some((ok) => JSON.stringify(ok) === JSON.stringify(credentials))) {
    throw new Error("velvet-rope: `credentials` must be ['passkey'], ['passkey', 'key'] or ['key']");
  }

  const sessionTtlMs = { ...DEFAULT_SESSION_TTL_MS, ...options.sessionTtlMs };
  for (const kind of ['passkey', 'key']) {
    if (!(Number.isFinite(sessionTtlMs[kind]) && sessionTtlMs[kind] > 0)) {
      throw new Error(`velvet-rope: \`sessionTtlMs.${kind}\` must be a positive number of milliseconds`);
    }
  }

  const ids = { group: randomUUID, member: randomUUID, device: randomUUID, ...options.ids };
  for (const kind of ['group', 'member', 'device']) {
    if (typeof ids[kind] !== 'function') throw new Error(`velvet-rope: \`ids.${kind}\` must be a function`);
  }

  // Behind HTTPS the session cookie carries the __Host- prefix, so the browser only accepts it
  // Secure, host-only and on Path=/. Plain-http localhost (dev) can't use the prefix.
  const cookiePrefix = options.cookiePrefix ?? 'velvet_rope';
  const secure = rp.origin.startsWith('https://');
  // sessionCookieName, when given, replaces the whole session name (prefix included) for apps that
  // must keep an existing cookie; it must be an RFC 6265 token.
  if (
    options.sessionCookieName !== undefined &&
    !(typeof options.sessionCookieName === 'string' && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(options.sessionCookieName))
  ) {
    throw new Error('velvet-rope: `sessionCookieName` must be a non-empty string of valid cookie-name characters');
  }
  const cookies = {
    session: options.sessionCookieName ?? `${secure ? '__Host-' : ''}${cookiePrefix}_session`,
    link: `${cookiePrefix}_link`,
  };
  const csrfHeader = options.csrfHeader ?? 'X-Velvet-Rope';
  const messages = { ...defaultMessages({ roles, csrfHeader }), ...options.messages };
  const now = options.now ?? Date.now;
  // onGroupDeleted is the deprecated name of onGroupDeleting; it only counts when the new one isn't given.
  const { onGroupDeleted, ...given } = options.hooks ?? {};
  const hooks = {
    onAudit: noop,
    onGroupCreated: noop,
    onMemberCreated: noop,
    onMemberEnded: noop,
    onDeviceRevoked: noop,
    // A join request's profile is the app's own data, so nothing is accepted until the app vets it.
    validateProfile: () => {
      throw new Refusal(400, 'profile_invalid');
    },
    ...given,
    onGroupDeleting: given.onGroupDeleting ?? onGroupDeleted ?? noop,
  };
  const { runHook, transact, attempt } = createHookTools({ db, hooks, messages });

  return {
    db,
    now,
    rp,
    roles,
    ids,
    prefix: (options.prefix ?? '/api').replace(/\/$/, ''),
    cookies,
    csrfHeader,
    groupCreation,
    credentials,
    linkRequestTtlMs: options.linkRequestTtlMs ?? 5 * 60 * 1000,
    linkRequestMaxAgeMs: options.linkRequestMaxAgeMs ?? 60 * 60 * 1000,
    maxProfileBytes: options.maxProfileBytes ?? 16 * 1024,
    rateLimit: options.rateLimit ?? (() => noLimit),
    events: options.events ?? createHub(),
    eventsRoute: options.eventsRoute ?? true,
    heartbeatMs: options.heartbeatMs,
    hooks,
    /** Calls an app hook inside a transaction; see hooks.js. */
    runHook,
    /** Runs a change in a transaction and replies with any Refusal or error; see hooks.js. */
    transact,
    /** Like transact, for async work outside a transaction; see hooks.js. */
    attempt,
    messages,
    sessions: createSessions({ db, cookieName: cookies.session, sessionTtlMs }),
    /** Sends { error: code, message } with the app's wording for `code`. */
    refuse: (reply, status, code) => reply.code(status).send({ error: code, message: messages[code] ?? code }),
  };
}
