# Velvet Rope

Passkey sign-in and in-person device linking for small, private web apps. A new device gets in
only when someone already inside scans its QR code: the scan is the approval. There's no
password, no email, no invite code to type and no prompt to accept.

- **One passkey per device.** Each one has its own WebAuthn user handle, label and role.
- **Groups and roles.** A group has members. You define the roles; velvet-rope enforces the
  admin rules (all admins are equal, and the last admin can't leave).
- **Fastify + SQLite on the server**, plain ES modules in the browser. There's no framework and
  no build step in the package.

```
npm install velvet-rope
```

Peer dependencies, depending on the parts you use: `fastify`, `@simplewebauthn/server` and
`@fastify/rate-limit` (server); `@simplewebauthn/browser`, `qrcode` and `jsqr` (browser). The
server takes a `better-sqlite3` database.

| Import                         | What it is                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `velvet-rope/domain`           | Pure rules, shared by server and client: `defineRoles`, link-request lifecycle, expiry |
| `velvet-rope/server`           | The Fastify plugin, `migrate`, `startSweeper`, `createRateLimiter`, `createInvite` |
| `velvet-rope/client`           | Headless browser API: `createClient`, `watchJoin`, `startScanner`, `renderQr`, ... |
| `velvet-rope/ui`               | Drop-in components: `mountJoin`, `mountScanButton`, `openScanner`                  |
| `velvet-rope/ui/style.css`     | Optional plain styles for the components' `vr-*` classes                           |
| `velvet-rope/testing`          | Soft authenticator for API tests, `addMember`, `createSession`                     |
| `velvet-rope/testing/playwright` | `addVirtualAuthenticator`, `twoDevices`, `linkDevice`                           |

## How joining works

1. The new device asks to join, under a label such as "Firefox on Android". It gets a token and
   a 5-minute link cookie.
2. It shows a QR code of `https://<app>/link#<token>`. The token sits in the fragment, so it
   never reaches server logs.
3. A signed-in member whose role can `link` scans it with the in-app scanner or the phone's
   camera app.
4. That device claims the request for its group. This is the approval.
5. The new device hears `claimed` over Server-Sent Events, or polling as the fallback.
6. It registers its own passkey.
7. It's signed in with the linked role (your lowest role). An admin can raise the role later.

## 1. Define roles once

Put the matrix in a file that both server and client import.

```js
// roles.js
import { defineRoles } from 'velvet-rope/domain';

export const roles = defineRoles(
  {
    // 'link', 'manageMembers' and 'deleteGroup' are velvet-rope's; the rest are yours.
    admin: ['read', 'write', 'delete', 'link', 'manageMembers', 'deleteGroup'],
    collaborator: ['read', 'write', 'delete', 'link'],
    contributor: ['read', 'write'],
    viewer: ['read'],
  },
  { admin: 'admin', linked: 'viewer' },
);

// A rule that depends on the target stays a pure function, easy to test.
// Contributors edit only the pages they created.
export function canEditPage(session, page) {
  if (roles.can(session.passkey.role, 'delete')) return true;
  return roles.can(session.passkey.role, 'write') && page.created_by === session.passkey.id;
}
```

`roles.can(role, capability)` answers yes or no. `roles.canManageMember(actor, target, change,
adminCount)` is the per-target rule that the member routes enforce. `defineRoles` throws if the
admin role lacks velvet-rope's capabilities.

## 2. Server

```js
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import velvetRope, { migrate, startSweeper } from 'velvet-rope/server';
import { roles } from './roles.js';

const db = new Database('data/app.db');
db.pragma('foreign_keys = ON');
migrate(db); // velvet-rope's tables, tracked in velvet_rope_schema
db.exec(`CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_by TEXT
)`);

const app = Fastify({ trustProxy: 'loopback' });
await app.register(velvetRope, {
  db,
  rp: { id: 'notes.example.com', name: 'Notes', origin: 'https://notes.example.com' },
  roles,
  prefix: '/api', // the default
  cookiePrefix: 'notes', // cookies notes_session / __Host-notes_session, notes_link
  csrfHeader: 'X-Notes', // every mutating request needs JSON and `X-Notes: 1`
  groupCreation: 'open', // 'open' | 'invite' | 'closed'
  // Optional:
  // rateLimit: createRateLimiter(app, DEFAULT_RATE_LIMITS),
  // events: createHub(),             // share the hub to publish your own events
  // hooks: { onAudit(db, entry) {}, onGroupCreated(db, group) {}, onGroupDeleted(db, group) {} },
  // messages: { link_expired: 'That code has gone stale. Ask for a fresh one.' },
});
await app.listen({ port: 3000 });
startSweeper(db); // hourly clean-up of expired sessions, challenges, join requests, invites
```

Routes it adds, under `prefix`:

| Route                                                                            | What it does                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------- |
| `POST /groups/options`, `POST /groups`                                           | Create a group; the first passkey is admin      |
| `POST /auth/options`, `POST /auth`, `POST /auth/sign-out`                        | Discoverable sign-in, sign-out                  |
| `GET /me`                                                                        | `{ passkey, group }`; slides the cookie         |
| `POST /link-requests`, `GET /link-requests/current`, `GET /link-requests/current/events` | The new device asks to join and watches |
| `POST /link-requests/claim`                                                      | A member who can `link` approves by scanning    |
| `POST /link-requests/current/options`, `POST /link-requests/current/complete`    | The new device registers its passkey            |
| `GET /members`, `PATCH /members/:id`, `DELETE /members/:id`, `POST /members/leave` | List, rename, set role, revoke, leave         |
| `DELETE /group`                                                                  | Delete the group (body `{ name }` to confirm)   |
| `GET /events`                                                                    | The group's Server-Sent Events stream           |

Every refusal is `{ error: code, message }`. The codes are in `src/server/messages.js`. Pass
`messages` to reword any of them.

## 3. Check permissions in your routes

```js
import { canEditPage } from './roles.js';

// View: any member whose role has 'read'. Always scope queries by the session's group.
app.get('/api/pages/:id', { onRequest: app.requireCapability('read') }, async (req, reply) => {
  const page = db
    .prepare('SELECT * FROM pages WHERE id = ? AND group_id = ?')
    .get(req.params.id, req.session.group.id);
  return page ?? reply.code(404).send({ error: 'not_found' });
});

// Edit: the role check, then the per-page rule.
app.put('/api/pages/:id', { onRequest: app.requireCapability('write') }, async (req, reply) => {
  const page = db
    .prepare('SELECT * FROM pages WHERE id = ? AND group_id = ?')
    .get(req.params.id, req.session.group.id);
  if (!page) return reply.code(404).send({ error: 'not_found' });
  if (!canEditPage(req.session, page)) return reply.code(403).send({ error: 'forbidden' });
  // ...save
});

// Delete: the role alone decides.
app.delete('/api/pages/:id', { onRequest: app.requireCapability('delete') }, async (req) => {
  db.prepare('DELETE FROM pages WHERE id = ? AND group_id = ?').run(
    req.params.id,
    req.session.group.id,
  );
});
```

The guards and decorators:

- `app.requireSession` answers 401 when there's no live session.
- `app.requireCapability(cap)` answers 401 the same way, and 403 when the role can't do `cap`.
- `req.session` is `{ passkey: { id, label, role }, group: { id, name } }`.
- `req.can(cap)` checks a capability inside a handler.
- `app.velvetRope.events.publish(groupId, event, data)` sends your own events on the group's
  stream.

## 4. Browser: who's signed in, and which controls to show

```js
import { connectSessionEvents, createClient } from 'velvet-rope/client';
import { canEditPage, roles } from './roles.js';

const client = createClient({ csrfHeader: 'X-Notes' }); // or pass your own getJson/postJson/...
const me = await client.getMe(); // null when signed out

editButton.hidden = !canEditPage(me, page);
deleteButton.hidden = !roles.can(me.passkey.role, 'delete');

const events = new EventSource(client.eventsUrl);
connectSessionEvents(events, {
  onRoleChanged: (role) => {
    me.passkey.role = role;
    rerender();
  },
  onRevoked: () => showSignedOut('This device was removed.'),
  onGroupDeleted: ({ name }) => showSignedOut(`${name} was deleted.`),
});
```

Hiding a control only spares people a button that wouldn't work. The server check is what
enforces access.

The client also has `signIn()`, `signOut()`, `createGroup({ groupName, label, invite })`,
`listMembers()`, `updateMember(id, { label, role })`, `removeMember(id)`, `leaveGroup()` and
`deleteGroup(name)`.

## 5. Show the join QR (new device)

```js
import { createClient } from 'velvet-rope/client';
import { mountJoin } from 'velvet-rope/ui';
import 'velvet-rope/ui/style.css';

mountJoin(document.querySelector('#join'), {
  client: createClient({ csrfHeader: 'X-Notes' }),
  onJoined: (me) => showHome(me),
  onCancel: () => showWelcome(),
  text: { title: 'Join the family notes' }, // any string: see JOIN_TEXT
  classes: { root: 'card' }, // any class: see JOIN_CLASSES
});
```

It covers the label form, the QR code, a countdown, a copy-link fallback, the wait, and the
passkey prompt. Firefox may need a fresh tap to create the passkey after the wait. When that
happens, the component shows a **Create passkey** button.

For your own markup, use the same steps headless:

```js
import { createClient, linkUrl, renderQr, watchJoin } from 'velvet-rope/client';

const client = createClient();
const { token } = await client.requestJoin('Firefox on Android');
qrBox.replaceChildren(await renderQr(linkUrl(location.origin, token)));
const stop = watchJoin({
  client,
  onStatus: async ({ status }) => {
    if (status === 'claimed') {
      stop();
      showHome(await client.completeJoin());
    }
    if (status === 'expired') showExpired();
  },
});
```

## 6. Add the scanner (signed-in device)

```js
import { mountScanButton } from 'velvet-rope/ui';

if (roles.can(me.passkey.role, 'link')) {
  mountScanButton(toolbar, {
    client,
    onLinked: ({ label }) => toast(`Linked ${label}. Set its role in Members.`),
    onError: (message) => toast(message),
    text: { button: 'Add a device' },
  });
}
```

The scanner and `jsqr` load only when someone presses the button. To build your own camera view,
call `startScanner({ video, onText })` from `velvet-rope/client`.

**Opened with the phone's camera app.** The QR is an ordinary link to `/link#<token>`. Serve
your app there, and on page load:

```js
import { takeLinkFromLocation } from 'velvet-rope/client';

const token = takeLinkFromLocation(); // reads #token and clears it from the address bar
if (token) me ? await client.claimLink(token) : rememberForAfterSignIn(token);
```

## 7. Testing

```js
import { addMember, createSoftAuthenticator } from 'velvet-rope/testing';

// A real passkey for fastify.inject tests: the server's verification runs unmocked.
const phone = createSoftAuthenticator({ origin: 'http://localhost:5173' });
const options = (await post('/api/groups/options', { groupName: 'Home', label: 'Phone' })).json();
await post('/api/groups', { response: phone.register(options) });

// Or skip the ceremony: a member with a role, signed in.
const { token } = addMember(db, { groupId, role: 'contributor' });
const cookie = `notes_session=${token}`;
```

```js
// Playwright (Chromium)
import { linkDevice, twoDevices } from 'velvet-rope/testing/playwright';

const { phone, desktop, close } = await twoDevices(browser);
// ...the phone creates a group...
await linkDevice({
  joiner: desktop,
  scanner: phone,
  label: 'Desktop',
  openJoin: (page) => page.goto('/join'),
});
```

## Security notes

- Session cookies, challenges, link tokens and invite codes are 256-bit random values, stored
  only as SHA-256 hashes.
- The session cookie is `HttpOnly; Secure; SameSite=Strict`, with a 30-day sliding expiry and the
  `__Host-` prefix on HTTPS.
- On top of SameSite=Strict, mutating requests need JSON and the CSRF header.
- Challenges are single-use and expire after 5 minutes. A join request expires 5 minutes after
  it's created, and claiming doesn't extend it.
- Every query in the plugin is scoped to the session's group. Scope yours the same way.
- Nothing secret is logged. WebAuthn error text, which can echo challenges, is never returned.

Testing on a real phone needs real HTTPS with a valid certificate. WebAuthn accepts
`http://localhost` only on the machine itself.
