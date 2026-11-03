# Architecture

How velvet-rope is put together, for people and agents working on it. This describes 0.2;
[plan/integration-plan.md](../plan/integration-plan.md) describes the changes planned for 0.3.

## Layers

| Entry point | Folder | Runs in | May import |
| ----------- | ------ | ------- | ---------- |
| `velvet-rope/domain` | `src/domain/` | anywhere | nothing |
| `velvet-rope/server` | `src/server/` | Node | domain |
| `velvet-rope/client` | `src/client/` | browser | domain |
| `velvet-rope/ui` | `src/ui/` | browser | client |
| `velvet-rope/testing` | `src/testing/` | Node (tests) | server |

The **domain** holds the rules both sides must agree on:

- the role matrix and member-management verdicts (`roles.js`);
- the link-request lifecycle (`link-request.js`);
- expiry for sessions, challenges and invites;
- text cleaning.

It's pure: callers pass the clock and the roles.

## Server

`plugin.js` is one Fastify plugin. It isn't encapsulated, so its decorators and CSRF hook reach
the whole app.

- `options.js` turns the plugin options into the context every route module receives: `db`,
  `now`, `rp`, `roles`, `cookies`, `events`, `hooks`, `sessions`, `refuse` and the rest.
- `routes/*.js` holds one module per resource, mounted under `prefix`:

  | Module | Routes |
  | ------ | ------ |
  | `groups.js` | create a group |
  | `auth.js` | sign in and sign out |
  | `me.js` | who this session is |
  | `link-requests.js` | joining by QR |
  | `members.js` | list and manage members |
  | `group.js` | delete the group |
  | `events.js` | the group's Server-Sent Events stream |

- `sessions.js`: cookie sessions, which resolve to `{ token, passkey, group }`.
- `registration.js` and `challenges.js`: WebAuthn ceremonies, with challenges stored hashed and
  used once.
- `hub.js` and `stream.js`: in-process pub/sub keyed by group and by passkey, and the SSE
  plumbing. The app may pass its own hub as `events`.
- `db/`: a small adapter so better-sqlite3 and `node:sqlite` look the same.
- `migrate.js` and `migrations/`: numbered SQL files, tracked in `velvet_rope_schema`.
- `sweep.js`: periodic deletion of expired rows. The app starts it; the plugin doesn't.

## Data model (0.2)

```
groups ─┬─< passkeys ─┬─< credentials   (WebAuthn public keys)
        │             └─< sessions      (cookie hash, sliding expiry)
        └─< link_requests               (join-by-QR, 5-minute life)
invites                                 (group-creation codes)
challenges                              (pending ceremonies)
```

Each passkey is one device and one member: it has its own WebAuthn user handle, label and role.
App tables reference `groups(id)` with `ON DELETE CASCADE`, so deleting a group removes
everything that belongs to it.

## Joining by QR

1. The new device creates a link request. The token goes into its QR code (as a URL fragment)
   and into an HttpOnly cookie scoped to `/link-requests`.
2. A signed-in device scans the code and claims the request. The scan is the approval.
3. The new device watches its status over SSE (falling back to polling), then registers its own
   passkey. That creates the passkey with the linked role and a session, in one transaction.

## Client and UI

- `client/client.js` has one function per action a person takes. The transport is injectable.
  `api.js` is the default fetch wrapper, and adds the CSRF header and JSON.
- `ui/` holds drop-in components (`mountJoin`, the scan button and the scanner) built with a tiny
  `createElement`. Their text and class names can be overridden.

## Testing support

- `testing/soft-authenticator.js` is a software WebAuthn authenticator, so route tests run the
  real ceremonies.
- `testing/members.js` inserts members directly, for quick setup.
- `testing/playwright.js` holds helpers for apps' browser tests.
