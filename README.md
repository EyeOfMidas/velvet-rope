# Velvet Rope

Passkey sign-in and in-person device linking for small, private web apps. A new device gets in
only when someone already inside scans its QR code: the scan is the approval. There's no
password, no email, no invite code to type and no prompt to accept.

- **Members own devices.** A member is a person, with a name and a role. Each device they sign
  in on has its own label and, normally, its own passkey.
- **Device keys, if you turn them on.** A device that can't make a passkey can sign in with a
  long-lived cookie instead. See [Device keys](#device-keys).
- **Groups and roles.** A group has members. You define the roles; velvet-rope enforces the
  admin rules (all admins are equal, and the last admin can't leave).
- **Fastify + SQLite on the server**, plain ES modules in the browser. There's no framework and
  no build step in the package.

```
npm install velvet-rope
```

Peer dependencies, depending on the parts you use: `fastify`, `@simplewebauthn/server` and
`@fastify/rate-limit` (server); `@simplewebauthn/browser`, `qrcode` and `jsqr` (browser). The
server works with either `better-sqlite3` or Node's built-in `node:sqlite` (Node 22.5+; no
install needed): pass a handle from either, or let `openDatabase` pick whichever is available.

| Import                         | What it is                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `velvet-rope/domain`           | Pure rules, shared by server and client: `defineRoles`, link-request lifecycle, expiry |
| `velvet-rope/server`           | The Fastify plugin, `migrate`, `startSweeper`, `createRateLimiter`, `createInvite`, `Refusal` |
| `velvet-rope/client`           | Headless browser API: `createClient`, `watchJoin`, `startScanner`, `renderQr`, ... |
| `velvet-rope/ui`               | Drop-in components: `mountJoin`, `mountScanButton`, `openClaimDialog`, `openScanner` |
| `velvet-rope/ui/style.css`     | Optional plain styles for the components' `vr-*` classes                           |
| `velvet-rope/testing`          | Soft authenticator for API tests, `addMember`, `addDevice`, `createSession`        |
| `velvet-rope/testing/playwright` | `addVirtualAuthenticator`, `twoDevices`, `linkDevice`                           |

Coming from 0.2? Read [Upgrading from 0.2](#upgrading-from-02). Moving an app that already has
its own users and devices over to velvet-rope? See [docs/importing.md](docs/importing.md).

## How joining works

1. The new device asks to join, under a label such as "Firefox on Android" and, if your app
   wants it, a name and a profile. It gets a token and a link cookie.
2. It shows a QR code of `https://<app>/link#<token>`. The token sits in the fragment, so it
   never reaches server logs. The code lasts 5 minutes, and the page renews it while it's open
   (up to an hour in all).
3. A signed-in member scans it with the in-app scanner or the phone's camera app.
4. Their device previews the request: the label, the name and the profile. The scanner then
   picks what the new device becomes. Only the choices their role allows are offered:

   | Choice | What it does | Needs | Sign-out choices |
   | ------ | ------------ | ----- | ---------------- |
   | `new-member` | A new member with your lowest role (`linked`); an admin raises it later | `link` | none |
   | `own-device` | Another device of the scanner's own member | `linkOwnDevice` | none, sign out the scanning device, or sign out all their other devices |
   | `member` | A device of another member in the group | `manageMembers` | none, or sign out that member's other devices |

5. Confirming is the approval. There's no code to type and nothing to accept on the new device.
6. The new device hears `claimed` over Server-Sent Events, or polling as the fallback. It
   finishes with a passkey or, if you allow them, a device key. The sign-outs the scanner chose
   happen now, not at the scan, so nobody is locked out by a join that never finishes.
7. It's signed in as that member.

This covers two real cases:

- **Switching phones.** The old phone scans the new one, picks "my own device" and signs itself
  out.
- **Relinking a lost phone.** An admin scans the member's new phone, picks "someone's device"
  and signs out that member's other devices. The member keeps their name, role and history.

## 1. Define roles once

Put the matrix in a file that both server and client import.

```js
// roles.js
import { defineRoles } from 'velvet-rope/domain';

export const roles = defineRoles(
  {
    // 'link', 'linkOwnDevice', 'manageMembers' and 'deleteGroup' are velvet-rope's; the rest are yours.
    admin: ['read', 'write', 'delete', 'link', 'linkOwnDevice', 'manageMembers', 'deleteGroup'],
    collaborator: ['read', 'write', 'delete', 'link', 'linkOwnDevice'],
    contributor: ['read', 'write'],
    viewer: ['read'],
  },
  { admin: 'admin', linked: 'viewer' },
);

// A rule that depends on the target stays a pure function, easy to test.
// Contributors edit only the pages they created.
export function canEditPage(session, page) {
  if (roles.can(session.member.role, 'delete')) return true;
  return roles.can(session.member.role, 'write') && page.created_by === session.member.id;
}
```

`roles.can(role, capability)` answers yes or no. The library's capabilities mean:

- `link`: add a new member by scan.
- `linkOwnDevice`: add a device to your own member by scan. Give it to every role that should be
  able to switch phones.
- `manageMembers`: rename, re-role, remove and relink others, and manage their devices.
- `deleteGroup`: delete the group.

`defineRoles` throws if the admin role lacks any of the four.

Two per-target rules are what the routes enforce, and you can call them too:

- `roles.canManageMember(actor, target, change, adminCount)`, where `change.action` is
  `setRole`, `remove`, `relink`, `rename` or `leave`.
- `roles.canManageDevice(actor, { memberId }, action)`, where `action` is `rename` or `revoke`.
  A member may always manage their own devices. Anyone else's need `manageMembers`.

## 2. Server

```js
import Fastify from 'fastify';
import velvetRope, { migrate, openDatabase, startSweeper } from 'velvet-rope/server';
import { roles } from './roles.js';

// better-sqlite3 if installed, otherwise node:sqlite. openDatabase('data/app.db', { driver })
// forces one; `new Database(...)` / `new DatabaseSync(...)` handles work too, wherever velvet-rope
// takes a `db`.
const db = openDatabase('data/app.db');
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
  csrfHeader: 'X-Notes', // every mutating request needs `X-Notes: 1`
  groupCreation: 'open', // 'open' | 'invite' | 'closed'
  // Optional:
  // credentials: ['passkey', 'key'], // turn on device keys; see "Device keys"
  // rateLimit: createRateLimiter(app, DEFAULT_RATE_LIMITS),
  // events: createHub(),             // share the hub to publish your own events
  // hooks: { onAudit(db, entry) {}, onMemberCreated(db, info) {} },
  // messages: { link_expired: 'That code has gone stale. Ask for a fresh one.' },
});
await app.listen({ port: 3000 });
startSweeper(db); // hourly clean-up of expired sessions, challenges, join requests, invites
```

### Options

`db`, `rp` and `roles` are required. The rest have defaults.

| Option | Default | What it does |
| ------ | ------- | ------------ |
| `prefix` | `'/api'` | Where the routes are mounted |
| `cookiePrefix` | `'velvet_rope'` | Cookies are `<prefix>_session` (`__Host-` on HTTPS) and `<prefix>_link` |
| `sessionCookieName` | none | Replaces the whole session cookie name, `__Host-` included, for an app that must keep an existing cookie |
| `csrfHeader` | `'X-Velvet-Rope'` | The header every mutating request must send as `1` |
| `groupCreation` | `'open'` | `'open'`, `'invite'` or `'closed'` |
| `credentials` | `['passkey']` | `['passkey']`, `['passkey', 'key']` or `['key']`. See [Device keys](#device-keys) |
| `sessionTtlMs` | passkey 30 days, key 400 days | `{ passkey?, key? }`: the sliding life of each kind of session. The cookie's `Max-Age` is capped at 400 days |
| `linkRequestTtlMs` | 5 minutes | How long a join code lasts, and how far each renewal pushes it |
| `linkRequestMaxAgeMs` | 1 hour | The longest a join code can be renewed to. The join cookie lasts this long |
| `maxProfileBytes` | 16 KB | The largest join profile accepted (`profile_too_large`) |
| `ids` | `randomUUID` | `{ group, member, device }`: functions that make ids, for apps that need their own |
| `rateLimit` | none | From `createRateLimiter(app, limits)` |
| `events` | `createHub()` | The event hub; see [Events](#events) |
| `eventsRoute` | `true` | `false` leaves out `GET /events`, for apps that bridge the hub into their own stream |
| `hooks` | none | See [Hooks](#hooks) |
| `messages` | none | Reword any refusal by its code |

### Routes

Routes it adds, under `prefix`. "Signed in" means any live session. Every mutating request needs
the CSRF header.

| Route | Who | What it does |
| ----- | --- | ------------ |
| `POST /groups/options`, `POST /groups` | Anyone (with an invite, if `groupCreation` is `'invite'`) | Create a group with a passkey; the first member is admin |
| `POST /groups/key` | Anyone, if the policy has `'key'` | Create a group with a device key |
| `POST /auth/options`, `POST /auth` | Anyone | Discoverable passkey sign-in |
| `POST /auth/sign-out` | Anyone | Sign out. A device-key device is forgotten instead (`{ forgotDevice: true }`) |
| `GET /me` | Signed in | `{ member, device, group }`; slides the cookie |
| `POST /link-requests`, `POST /link-requests/current/renew` | The new device | Ask to join; keep the code alive |
| `GET /link-requests/current`, `GET /link-requests/current/events` | The new device | Its join status, by polling or as a stream |
| `POST /link-requests/peek` | Signed in | Preview a scanned code, with the outcomes this scanner may pick |
| `POST /link-requests/claim` | Signed in, with the capability the outcome needs | Approve by scanning: `{ token, outcome, memberId?, signOut? }` |
| `POST /link-requests/current/options`, `POST /link-requests/current/complete` | The new device | Finish joining with a passkey |
| `POST /link-requests/current/complete-key` | The new device, if the policy has `'key'` | Finish joining with a device key |
| `GET /members` | Signed in | The group's members, each with their live devices |
| `PATCH /members/:id` | Yourself for `name`; `manageMembers` for others and for `role` | Rename or set the role |
| `DELETE /members/:id` | `manageMembers` | Remove a member and revoke all their devices |
| `POST /members/leave` | Signed in | Leave the group (the last admin can't) |
| `PATCH /devices/:id` | Your own devices; `manageMembers` for others | Rename a device (`label`) |
| `DELETE /devices/:id` | Your own devices; `manageMembers` for others | Revoke one device. The member stays |
| `POST /devices/current/passkey/options`, `POST /devices/current/passkey` | A device-key device | Upgrade it to a passkey in place |
| `DELETE /group` | `deleteGroup` | Delete the group (body `{ name }` to confirm) |
| `GET /events` | Signed in | The group's Server-Sent Events stream (unless `eventsRoute` is `false`) |

`GET /members` returns people, each with their live devices:

```json
[{ "id": "…", "name": "Sam", "role": "admin", "created_at": 1730000000000, "current": true,
   "devices": [{ "id": "…", "label": "Sam's phone", "kind": "passkey",
                 "last_used_at": 1730000000000, "current": true }] }]
```

`kind` is `passkey` or `key`. `current` marks the caller's own member and device.

Every refusal is `{ error: code, message }`. The codes are in `src/server/messages.js`. Pass
`messages` to reword any of them.

### Hooks

Hooks let your app keep its own tables in step. Pass them as `hooks: { ... }`. Each one is
called as `hook(db, info)`, except `validateProfile`, which gets just the profile.

| Hook | Runs | `info` |
| ---- | ---- | ------ |
| `onMemberCreated` | When a group is created (`via: 'create-group'`) and when a new member joins (`via: 'link'`) | `{ group, member, profile, via }` |
| `onMemberEnded` | Before a member is removed or leaves | `{ group, member, reason, actorId }`. `reason` is `removed` or `leave` |
| `onDeviceRevoked` | Before a device stops working | `{ group, member, device, reason }`. `reason` is `revoked` (removed on purpose), `replaced` (the scanner chose to sign it out when linking) or `signed-out` (a device key signed out) |
| `onGroupCreated` | When a group is created | `group` |
| `onGroupDeleting` | Before the group's rows are deleted | `group` |
| `onAudit` | On each change worth logging | `{ groupId, actorId, action, target, detail, at }` |
| `validateProfile` | When a join request or a key group creation brings a profile | The profile. Return the value to store, or throw a `Refusal`. May be async. Without this hook, every profile is refused |

The `onAudit` actions are `link`, `role-change`, `rename`, `remove`, `leave`, `rename-device` and
`revoke-device`. `actorId` and `target` are member ids, except for the two device actions, where
`target` is the device id.

The rules for hooks:

- They run **inside the database transaction**, so what they write commits or rolls back with the
  change.
- They must be **synchronous**. A hook that returns a promise is refused, and the change rolls
  back. Do async work outside the hook. `validateProfile` is the one exception.
- They can **veto**: `throw new Refusal(status, code, message?)` (from `velvet-rope/server`)
  rolls everything back and replies `{ error: code, message }`. Without a `message`, your
  `messages` wording for `code` is used. Any other error also rolls back, but the client only
  sees a generic 500 (`server_error`).
- `onGroupDeleted` is deprecated. Use `onGroupDeleting`, which runs before the group's rows go.

```js
import { Refusal } from 'velvet-rope/server';

hooks: {
  onMemberCreated(db, { group, member, via }) {
    if (via === 'link' && isFull(db, group.id)) {
      throw new Refusal(409, 'group_full', 'This group is full.');
    }
    db.prepare('INSERT INTO seats (member_id, group_id) VALUES (?, ?)').run(member.id, group.id);
  },
},
```

### Events

`GET /events` streams these, scoped to the group. `connectSessionEvents` (in section 4) listens
for them.

| Event | Data | Sent to |
| ----- | ---- | ------- |
| `members-changed` | none | The group, after any join, rename, role change, removal or device change |
| `member-ended` | `{ id, reason }` | The group, when a member leaves or is removed |
| `role-changed` | `{ role }` | That member's devices only |
| `session-revoked` | none | The device that was removed or signed out. The stream then ends |
| `group-deleted` | `{ name }` | The group. The stream then ends |

An app with its own stream passes its own hub as `events`, with `eventsRoute: false` to skip the
built-in route. A hub needs four methods, and devices are keyed by `deviceId`:

- `subscribe(groupId, send(event, data), { deviceId, end })` returns an unsubscribe function.
- `publish(groupId, event, data)` goes to every connection in the group.
- `publishTo(deviceId, event, data)` goes to one device's connections.
- `disconnect(deviceId)` ends that device's connections.

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
- `req.session` is `{ member: { id, name, role }, device: { id, label, kind }, group: { id, name } }`.
  `kind` is `passkey` or `key`. The 0.2 shape, `passkey: { id, label, role }`, is still there as
  a deprecated alias and goes in 0.4.
- `req.can(cap)` checks a capability inside a handler.
- `app.velvetRope.events.publish(groupId, event, data)` sends your own events on the group's
  stream. `app.velvetRope.resolveSession(request)` gives the session outside a guard.

## 4. Browser: who's signed in, and which controls to show

```js
import { connectSessionEvents, createClient } from 'velvet-rope/client';
import { canEditPage, roles } from './roles.js';

const client = createClient({ csrfHeader: 'X-Notes' }); // or pass your own getJson/postJson/...
const me = await client.getMe(); // null when signed out

editButton.hidden = !canEditPage(me, page);
deleteButton.hidden = !roles.can(me.member.role, 'delete');

const events = new EventSource(client.eventsUrl);
connectSessionEvents(events, {
  onRoleChanged: (role) => {
    me.member.role = role;
    rerender();
  },
  onMembersChanged: () => reloadMembers(),
  onMemberEnded: ({ id, reason }) => forget(id, reason),
  onRevoked: () => showSignedOut('This device was removed.'),
  onGroupDeleted: ({ name }) => showSignedOut(`${name} was deleted.`),
});
```

Hiding a control only spares people a button that wouldn't work. The server check is what
enforces access.

The rest of the client, one function per thing a person does:

- Signing in: `signIn()`, and `signOut()`, which resolves `{ forgotDevice }`. When sign-in is
  refused because the device was removed, the client asks the browser to forget that passkey
  (`signalUnknownCredential`, where supported).
- Groups: `createGroup({ groupName, label, invite })`, `createGroupWithKey({ groupName, label,
  name, profile, invite })` and `deleteGroup(name)`.
- Members: `listMembers()`, `updateMember(id, { name, role })` (`label` still works for `name`),
  `removeMember(id)` and `leaveGroup()`.
- Devices: `updateDevice(id, { label })`, `removeDevice(id)` and `upgradeToPasskey()`.
- Joining, on the new device: `requestJoin({ label, name?, profile? })` (a plain label works
  too), `joinStatus()`, `renewJoin()`, `completeJoin()` and `completeJoinWithKey()`.
- Joining, on the scanner: `peekLink(token)` and `claimLink(token, { outcome, memberId?,
  signOut? })`.

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

It covers the label form, the QR code, a countdown (the code renews itself while it shows), a
copy-link fallback, the wait, and the passkey prompt. Firefox may need a fresh tap to create the
passkey after the wait. When that happens, the component shows a **Create passkey** button.

When the server allows device keys and the browser can't make a passkey, it offers **Use this
device without a passkey**. Under `['key']` it joins with a key straight away. At the end it says
whether the device joined as a new member or was added to someone's devices.

To collect a name and your own profile fields as well:

```js
mountJoin(el, {
  client,
  askName: true, // a "Your name" field
  renderProfileFields: (box, saved) => {
    const input = Object.assign(document.createElement('input'), { value: saved?.phone ?? '' });
    box.append(input);
    return () => ({ phone: input.value }); // called for the profile to send
  },
  draftKey: 'notes-join', // keep what they typed in localStorage, until the join completes
  onJoined: showHome,
});
```

- `askName` shows the name field. It also shows whenever `renderProfileFields` is given.
- `renderProfileFields(box, savedProfile)` fills `box` with your fields and returns a
  `getProfile()` function.
- `draftKey` saves the name and profile as they type and restores them when the page reopens.
- The profile goes to your `validateProfile` hook, which must accept it. Without that hook,
  every profile is refused.

`JOIN_TEXT` keys: `title`, `intro`, `labelField`, `nameField`, `showCode`, `scanThis`, `qrLabel`,
`expiresIn`, `linkField`, `copy`, `copied`, `waiting`, `expired`, `newCode`, `approved`,
`approvedShort`, `createPasskey`, `back`, `needsTap`, `useKey`, `welcome` (with `{group}`),
`addedTo` (with `{member}`) and `failed`. `JOIN_CLASSES` adds a `profile` class for the box.

For your own markup, use the same steps headless:

```js
import { createClient, linkUrl, renderQr, watchJoin } from 'velvet-rope/client';

const client = createClient();
const { token } = await client.requestJoin({ label: 'Firefox on Android', name: 'Sam' });
qrBox.replaceChildren(await renderQr(linkUrl(location.origin, token)));
const stop = watchJoin({
  client,
  onStatus: async ({ status }) => {
    if (status === 'claimed') {
      stop();
      // or client.completeJoinWithKey(), if you allow device keys
      showHome(await client.completeJoin());
    }
    if (status === 'expired') showExpired();
  },
});
```

Keep the code alive with `client.renewJoin()` while it shows.

## 6. Add the scanner (signed-in device)

```js
import { mountScanButton } from 'velvet-rope/ui';

if (['link', 'linkOwnDevice', 'manageMembers'].some((cap) => roles.can(me.member.role, cap))) {
  mountScanButton(toolbar, {
    client,
    onLinked: ({ label }) => toast(`Added ${label}.`),
    onError: (message) => toast(message),
    text: { button: 'Add a device' },
    claimDialog: { renderProfile: (profile) => document.createTextNode(profile?.phone ?? '') },
  });
}
```

Scanning a code doesn't approve it. The button opens a **claim dialog** that shows the device's
label, its name and, through your `renderProfile`, its profile. `renderProfile` returns a DOM
node, never HTML. The dialog offers only what this role may do: a new member, one of my own
devices, or someone else's device (with a member picker). Each comes with its sign-out choice.
If only one thing is allowed, it's a single confirm button. The member confirms, and that's the
approval.

The scanner and `jsqr` load only when someone presses the button. To build your own camera view,
call `startScanner({ video, onText })` from `velvet-rope/client`.

**Opened with the phone's camera app.** The QR is an ordinary link to `/link#<token>`. Serve
your app there, and on page load:

```js
import { takeLinkFromLocation } from 'velvet-rope/client';
import { openClaimDialog } from 'velvet-rope/ui';

const token = takeLinkFromLocation(); // reads #token and clears it from the address bar
if (token) me ? openClaimDialog(host, { client, token, onClaimed }) : rememberForAfterSignIn(token);
```

`openClaimDialog(container, options)` takes `client`, `token`, `renderProfile`, `onClaimed`,
`onCancel`, `onError` (the preview was refused), `text` and `classes`. For a fully custom
screen, call `client.peekLink(token)` to see `{ label, name, profile, expiresAt, outcomes }`,
then `client.claimLink(token, { outcome, memberId, signOut })` once the member has chosen.

`CLAIM_TEXT` keys: `title`, `deviceLabel`, `nameLabel`, `newMember`, `ownDevice`, `member`,
`signOutHere`, `signOutOthers`, `pickMember`, `confirm`, `cancel`, `none` and `failed`.
`CLAIM_CLASSES` keys: `root`, `profile`, `choice`, `actions`, `error` and `primary`.

## 7. Testing

```js
import { addDevice, addMember, createSoftAuthenticator } from 'velvet-rope/testing';

// A real passkey for fastify.inject tests: the server's verification runs unmocked.
const phone = createSoftAuthenticator({ origin: 'http://localhost:5173' });
const options = (await post('/api/groups/options', { groupName: 'Home', label: 'Phone' })).json();
await post('/api/groups', { response: phone.register(options) });

// Or skip the ceremony: a member with a role and one device, signed in.
const { memberId, deviceId, token } = addMember(db, { groupId, role: 'contributor' });
const cookie = `notes_session=${token}`;

// More devices for the same member. `kind: 'key'` makes a device-key device.
const second = addDevice(db, { memberId, kind: 'key' }); // { deviceId, token }
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

## Device keys

A passkey is the best way to sign in, but not every browser can make one. A **device key** is
for those devices. The session cookie is the key: it's a 256-bit random value, stored only as
its SHA-256 hash, and it slides for 400 days each time the device is used. A key device can't
sign in again, so signing out forgets the device (more below).

**Turning them on.** Set the `credentials` option:

- `['passkey']` is the default. No keys.
- `['passkey', 'key']` allows both. The join screen offers a key only when a passkey can't be
  made.
- `['key']` allows only keys. Passkey joins and passkey group creation are refused with
  `passkey_not_allowed`.

With `'key'` off, the key routes refuse with `key_not_allowed`. The example app turns them on
with `KEYS=1 npm run example`.

**The trade-offs.** Be honest with your users about these:

- **A stolen cookie works as the person.** A passkey's private key can't be copied out of the
  device. A key cookie can be, by anyone who gets hold of the browser's storage. Shorten
  `sessionTtlMs.key` if that worries you.
- **Clearing browser data loses a key for good.** There's nothing to sign in with, so the
  device must be linked again. Relinking is the cure: an admin (or the member, from another
  device) scans it and picks the member it belongs to.
- **Admin control is the same either way.** A key device only exists because someone scanned
  it, and an admin can still revoke it from the members list. Nothing gets in without a scan.

**Signing out forgets a key device.** Ending a key device's session would change nothing, since
the cookie is the key. So `signOut()` removes the device from its member instead
(`onDeviceRevoked` with the reason `signed-out`) and resolves `{ forgotDevice: true }`. Show a
warning first. A passkey device signs out as before, and can sign in again.

**Upgrading to a passkey.** A key device can gain a passkey later, in place and without a scan:
`client.upgradeToPasskey()`. It keeps its id, label, member and session.

## Security notes

- Session cookies, challenges, link tokens and invite codes are 256-bit random values, stored
  only as SHA-256 hashes.
- The session cookie is `HttpOnly; Secure; SameSite=Strict`, with the `__Host-` prefix on HTTPS.
  It slides for 30 days for a passkey device and 400 days for a device key (see `sessionTtlMs`).
- A device key is its session cookie. It can't be re-created by signing in, and a stolen one
  works as the person until the device is revoked. See [Device keys](#device-keys).
- On top of SameSite=Strict, every mutating request (anything but `GET`, `HEAD` and `OPTIONS`)
  needs the CSRF header set to `1`. A request that has a body must also be JSON. A request has a
  body when it sends `Transfer-Encoding`, or a `Content-Length` above 0. A body-less request
  needs only the header.
- Challenges are single-use and expire after 5 minutes. A join request expires 5 minutes after
  it's created (`linkRequestTtlMs`), and claiming doesn't extend it. The page can renew a
  pending code, but never past `linkRequestMaxAgeMs`.
- The scanner chooses what a new device becomes, and only within their role: `new-member` needs
  `link`, `own-device` needs `linkOwnDevice` and `member` needs `manageMembers`. A new member
  never gets more than the `linked` role.
- Every query in the plugin is scoped to the session's group. Scope yours the same way.
- Nothing secret is logged. WebAuthn error text, which can echo challenges, is never returned.

Testing on a real phone needs real HTTPS with a valid certificate. WebAuthn accepts
`http://localhost` only on the machine itself.

## Upgrading from 0.2

Run `migrate(db)` as before. It converts your data and keeps every id. Then work through this
list:

1. **The `passkeys` table is gone.** `migrate()` turns each row into a `devices` row plus a
   `members` row, with the same ids. A revoked 0.2 passkey becomes a member who was removed. Any
   raw SQL that names `passkeys` must change, and so must your triggers and views. Foreign keys
   that pointed at `passkeys(id)` now point at `devices(id)`. For a person's name or role, join
   to `members`.
2. **`request.session.passkey` is now `member` and `device`.** The session is
   `{ member: { id, name, role }, device: { id, label, kind }, group }`, and so are the replies
   of `GET /me`, sign-in, group creation and joining. The old `passkey` field is a deprecated
   alias for now and goes in 0.4. For migrated data, a member's id and their device's id are
   both the old passkey id, so a column like `created_by` still matches `member.id`. Store
   `member.id` for new rows, since it survives a lost phone. The `onAudit` hook's `actorId` is
   now a member id, and so is `target`, except for the device actions (`rename-device`,
   `revoke-device`), whose `target` is the device id.
3. **`onGroupDeleted` is now `onGroupDeleting`.** The old name still works if it's the only one
   you give, and it runs before the rows are deleted, as the new one does.
4. **The claim needs an `outcome`.** `POST /link-requests/claim` and `client.claimLink` must say
   `new-member`, `own-device` or `member`. `mountScanButton` already does this with its dialog.
   If you called `claimLink(token)` yourself, pass `{ outcome: 'new-member' }` for the old
   behaviour.
5. **`GET /members` has a new shape.** It lists people (`id, name, role, created_at, current`)
   with their live devices under `devices`. The member-level `label` and `last_used_at` are
   gone. `PATCH /members/:id` takes `name`; `label` still works.
6. **The `revoke` member action is now `remove`**, in `roles.canManageMember` and in the audit
   log, where the action is `remove`. `revoke` still works in `canManageMember`, as a
   deprecated alias.
7. **`linkOwnDevice` must be in your admin role's grants**, or `defineRoles` throws. Give it to
   other roles that should be able to switch phones.
8. **The event hub uses `deviceId`** where it used `passkeyId`, in `subscribe`, `publishTo` and
   `disconnect`. This only matters if you pass your own hub.
9. **`testing.addMember` returns `{ memberId, deviceId, token }`.** It used to return the
   passkey's id.

New in 0.3, none of it required: device keys, the `credentials`, `sessionTtlMs`, `ids`,
`sessionCookieName`, `eventsRoute`, `linkRequestTtlMs`, `linkRequestMaxAgeMs` and
`maxProfileBytes` options, and the hooks listed above.

To move an app that has its own users and devices over to velvet-rope, see
[docs/importing.md](docs/importing.md).
