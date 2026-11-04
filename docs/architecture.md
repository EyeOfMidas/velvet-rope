# Architecture

How velvet-rope is put together, for people and agents working on it.

## Layers

| Entry point | Folder | Runs in | May import |
| ----------- | ------ | ------- | ---------- |
| `velvet-rope/domain` | `src/domain/` | anywhere | nothing |
| `velvet-rope/server` | `src/server/` | Node | domain |
| `velvet-rope/client` | `src/client/` | browser | domain |
| `velvet-rope/ui` | `src/ui/` | browser | client |
| `velvet-rope/testing` | `src/testing/` | Node (tests) | server |

The **domain** holds the rules both sides must agree on:

- the role matrix and the member and device verdicts (`roles.js`: `canManageMember`,
  `canManageDevice`, and the library capabilities `link`, `linkOwnDevice`, `manageMembers` and
  `deleteGroup`);
- the link-request lifecycle and its outcomes (`link-request.js`: `claimLinkRequest`,
  `allowedOutcomes`, `renewLinkRequest`);
- expiry for sessions (by device kind), challenges and invites;
- text cleaning.

It's pure: callers pass the clock and the roles.

## Server

`plugin.js` is one Fastify plugin. It isn't encapsulated, so its decorators and CSRF hook reach
the whole app.

- `options.js` turns the plugin options into the context every route module receives: `db`,
  `now`, `rp`, `roles`, `ids`, `cookies`, `credentials`, `events`, `hooks`, `sessions`, `refuse`,
  the hook tools and the rest. Defaults live here.
- `routes/*.js` holds one module per resource, mounted under `prefix`:

  | Module | Routes |
  | ------ | ------ |
  | `groups.js` | create a group, with a passkey or a device key |
  | `auth.js` | sign in and sign out |
  | `me.js` | who this session is |
  | `link-requests.js` | joining by QR: request, renew, peek, claim, complete |
  | `members.js` | list and manage members |
  | `devices.js` | rename or revoke a device; upgrade a key device to a passkey |
  | `group.js` | delete the group |
  | `events.js` | the group's Server-Sent Events stream |

- `hooks.js`: how the app's hooks take part in a change (see below).
- `sessions.js`: cookie sessions, which resolve to `{ token, member, device, group }`, plus the
  deprecated `passkey` alias that `sessionView` builds and 0.4 drops. A session's lifetime comes
  from its device's kind. A key device's cookie is its key.
- `csrf.js`: the guard for the whole app. The CSRF header is always required on mutating
  requests, and JSON only when the request has a body.
- `registration.js` and `challenges.js`: WebAuthn ceremonies, with challenges stored hashed and
  used once. `registration.js` also inserts members and devices.
- `hub.js` and `stream.js`: in-process pub/sub keyed by group and by `deviceId`, and the SSE
  plumbing. The app may pass its own hub as `events`, and `eventsRoute: false` leaves out the
  built-in stream.
- `db/`: a small adapter so better-sqlite3 and `node:sqlite` look the same.
- `migrate.js` and `migrations/`: numbered SQL files, tracked in `velvet_rope_schema`.
- `sweep.js`: periodic deletion of expired rows. The app starts it; the plugin doesn't.

### Hooks and transactions

`hooks.js` holds the tools every route that changes data uses. They come from `options.js` in
the context:

- `Refusal(status, code, message?)` is what a hook (or a route) throws to veto a change.
- `runHook(name, ...args)` calls the app's hook as `hook(db, ...args)`. Call it only inside
  `transact`. A hook that returns a promise is refused, because a SQLite transaction is
  synchronous and the work would land after the commit.
- `transact(request, reply, fn)` runs `fn` in a transaction. It returns `{ value }`. For a
  `Refusal` it replies with its status, code and message, and for any other error it replies
  with a plain 500 `server_error`, since an error's text can hold internals. Either way it
  returns `null`. Routes publish events only after it returns a value, so a rolled-back change
  tells nobody.
- `attempt(request, reply, fn)` is the same for async work outside a transaction. It's used for
  `validateProfile`.

A hook that isn't given is a no-op, except `validateProfile`, which refuses everything until the
app supplies one. `options.js` folds the deprecated `onGroupDeleted` into `onGroupDeleting`.

## Data model (0.3)

```
groups ─┬─< members ──< devices ─┬─< credentials   (WebAuthn public keys)
        │                         └─< sessions      (cookie hash, sliding expiry)
        └─< link_requests                           (join-by-QR, 5-minute life)
invites                                             (group-creation codes)
challenges                                          (pending ceremonies)
```

A member is a person, with a name and a role. A device is one browser that signs in as them. It
has a label and a `kind`: a `passkey` device has a WebAuthn user handle and a credential, and a
`key` device has neither, because its session cookie is the key. A member has any number of
devices.

Ending a member sets `ended_at` and `ended_reason` (`leave` or `removed`) and revokes their
devices. Revoking a device sets `revoked_at`. The rows are kept, so ids in app tables still
resolve. Migration `002-members.sql` converted 0.2's `passkeys` into both tables with the same
id, so an old passkey id is now both a member id and a device id.

App tables reference `groups(id)` with `ON DELETE CASCADE`, so deleting a group removes
everything that belongs to it.

## Joining by QR

1. The new device creates a link request, with a label and optionally a name and a profile. The
   profile is size-checked, then vetted by `validateProfile`. The token goes into its QR code (as
   a URL fragment) and into an HttpOnly cookie scoped to `/link-requests`. The request lasts
   `linkRequestTtlMs`, and the page renews it up to `linkRequestMaxAgeMs`.
2. A signed-in device scans the code. `peek` previews it and reports `allowedOutcomes(role)`.
3. The scanner claims it with an outcome. The scan is the approval. `claimLinkRequest` checks the
   capability each outcome needs:

   | Outcome | Becomes | Needs |
   | ------- | ------- | ----- |
   | `new-member` | A new member with the `linked` role | `link` |
   | `own-device` | A device of the scanner's member | `linkOwnDevice` |
   | `member` | A device of the live member `memberId` in the scanner's group | `manageMembers` |

   The claim records the outcome, the target member and the `signOut` choice (`none`, `scanner`
   or `others`) on the request. It applies none of them yet.
4. The new device watches its status over SSE (falling back to polling), then finishes with a
   passkey (`/complete`) or, when the `credentials` policy allows, a device key
   (`/complete-key`). Both go through `finishJoin`, in one transaction:
   - a `new-member` outcome makes the member (`onMemberCreated`, `via: 'link'`);
   - the other outcomes check again that the target member is still live, else `link_incomplete`;
   - the device and its session are made;
   - `signOut` revokes the scanner's device or the member's other devices (`onDeviceRevoked`,
     reason `replaced`), only now, so an unfinished join locks nobody out;
   - the request becomes `completed` and `onAudit` records `link`.

   Any hook may veto, and everything rolls back together. Events go out after the commit.

## Client and UI

- `client/client.js` has one function per action a person takes. The transport is injectable.
  `api.js` is the default fetch wrapper, and adds the CSRF header and JSON.
- `client/session-events.js` maps the group stream's events to callbacks.
- `ui/` holds drop-in components (`mountJoin`, the scan button, the claim dialog and the
  scanner) built with a tiny `createElement`. Their text (`*_TEXT`) and class names
  (`*_CLASSES`) can be overridden. The scan button opens the claim dialog, which peeks, offers
  the allowed outcomes and claims on confirm.

## Testing support

- `testing/soft-authenticator.js` is a software WebAuthn authenticator, so route tests run the
  real ceremonies.
- `testing/members.js` inserts members (`addMember`), their extra devices (`addDevice`) and
  sessions (`createSession`) directly, for quick setup.
- `testing/playwright.js` holds helpers for apps' browser tests.
