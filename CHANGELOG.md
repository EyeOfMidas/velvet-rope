# Changelog

Every notable change to velvet-rope, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0, a minor version (0.x.0)
may break things. Breaking changes are marked **Breaking:**, and the release notes say how to
upgrade.

## [Unreleased]

### Added

- `GET /members` devices carry `created_at`, the time each device was added.

## [0.3.0] - 2026-11-03

### Added

- `eventsRoute: false` option, for apps that bridge velvet-rope's events into their own stream.
- `roles.canManageDevice()` for renaming and revoking a device: a member may always manage their
  own devices, and anyone else's need `manageMembers`.
- The `remove`, `relink` and `rename` member actions. `rename` is allowed for your own member or
  for anyone with `manageMembers`.
- Group creation accepts an optional `name` for the first member, which defaults to the device
  label.
- `testing.addDevice()`.
- A join request renews while its page is open: `POST /link-requests/current/renew` and
  `renewJoin()` extend a pending request without changing its code, up to a cap. The
  `linkRequestTtlMs` (default 5 minutes) and `linkRequestMaxAgeMs` (default 1 hour) options set
  both. The join cookie now lasts for the maximum age.
- `sessionTtlMs` option, for a separate sliding lifetime for passkey and device-key sessions (30
  and 400 days by default). The session cookie's `Max-Age` follows the device kind, capped at 400
  days.
- `Refusal` (from `velvet-rope/server`), for hooks to veto a change:
  `throw new Refusal(status, code, message?)` rolls the change back and replies
  `{ error: code, message }`. Any other error a hook throws also rolls back, and replies with a
  generic 500. Hooks run inside the transaction and must be synchronous.
- The `onGroupDeleting` hook, which runs in the delete transaction before the group's rows go.
- `sessionCookieName` option, which replaces the whole session cookie name, `__Host-` prefix
  included, for apps that must keep an existing cookie.
- Join requests take an optional `name` and `profile` (`requestJoin({ label, name, profile })`).
  The profile is checked against the new `maxProfileBytes` option (default 16 KB), then by the
  new `validateProfile` hook, which returns the value to store or throws a `Refusal`. By default
  any profile is refused.
- `PATCH /devices/:id` and `DELETE /devices/:id` (`updateDevice()`, `removeDevice()`): rename or
  revoke one device without ending its member. A member may always manage their own devices.
  Revoking the last device leaves the member in the group, ready to be linked again.
- The `onMemberEnded(db, { group, member, reason, actorId })` and
  `onDeviceRevoked(db, { group, member, device, reason })` hooks, which run inside the
  transaction and can veto. There's also a `member-ended` group event, `{ id, reason }`.
- When sign-in is refused because the device was removed, the client calls
  `PublicKeyCredential.signalUnknownCredential`, so the browser can forget that passkey. The call
  is skipped where unsupported, and its errors are ignored. `connectSessionEvents` gains
  `onMemberEnded({ id, reason })`.
- **Relink and device transfer.** Completing a join applies the outcome the scanner chose:
  - `own-device` and `member` add the new device to an existing member;
  - `signOut` then signs out the scanning device (`scanner`) or the member's other devices
    (`others`) when the new device finishes, not at the scan, with `onDeviceRevoked` reason
    `replaced`.

  This covers switching phones (the old phone scans the new one) and relinking a lost phone (an
  admin scans for the member).
- **Device keys.** Under `credentials: ['passkey', 'key']` or `['key']`, a device that can't
  make a passkey gets a long-lived HttpOnly cookie instead. The cookie is the device key, hashed
  like any session, and slides for 400 days. It can finish joining with
  `POST /link-requests/current/complete-key` (`completeJoinWithKey()`), with the same outcomes
  and sign-outs as a passkey join. It can create a group with `POST /groups/key`
  (`createGroupWithKey()`), under the same invite, profile and hook rules as `/groups`. Without
  `'key'` in the policy, these routes refuse with `key_not_allowed`. Under `['key']`, passkey
  joins and passkey group creation refuse with `passkey_not_allowed`.
- Upgrade a device-key device to a passkey in place, from the device itself and with no scan:
  `POST /devices/current/passkey/options`, `POST /devices/current/passkey` and
  `upgradeToPasskey()`. The device keeps its id, label and member, and its session stays.
- The join screen (`mountJoin`) now:
  - renews its code while the code is showing;
  - offers "Use this device without a passkey" when the server allows device keys and a
    passkey can't be made, and joins with a key directly under `['key']`;
  - says on success whether the device joined as a new member or was added to someone's
    devices.

  The new `JOIN_TEXT` keys are `useKey`, `welcome` and `addedTo`.
- `docs/importing.md`, which ships in the package: a tested guide to importing members and
  device cookies from an existing app, so its users stay signed in through the switch.
- The `onMemberCreated(db, { group, member, profile, via })` hook, at group creation
  (`via: 'create-group'`) and when a new member joins (`via: 'link'`, with the join request's
  profile). It runs inside the transaction and can veto.
- `POST /link-requests/peek` and `peekLink(token)` preview a join request without claiming it.
  The preview shows the label, name, profile, expiry and the outcomes this scanner may choose.
  `allowedOutcomes(role, roles)` in the domain gives the same list.
- `mountJoin` takes `renderProfileFields(box, savedProfile)`, `askName` and `draftKey`. They add
  a name field, the app's own profile fields, and a draft saved in `localStorage` that comes back
  when the page is reopened. The name and profile are sent with the join request.
- `credentials` option: `['passkey']` (the default), `['passkey', 'key']` or `['key']`. A
  joining device sees the policy in its join status.
- `ids` option, for app-supplied id generators for groups, members and devices (`randomUUID` by
  default).

### Changed

- **Breaking:** members own devices. The `passkeys` table is now `devices`, and a new `members`
  table holds each person's name and role. `migrate()` converts existing data and keeps ids, so
  app tables that referenced `passkeys(id)` now reference `devices(id)`. Apps that query
  `passkeys` in raw SQL must switch to `devices` or `members`. A revoked 0.2 passkey becomes a
  member who was removed.
- **Breaking:** `request.session`, `GET /me` and the sign-in, group-creation and join responses
  are now `{ member: { id, name, role }, device: { id, label, kind }, group }`, plus the
  deprecated `passkey` alias. The `onAudit` hook's `actorId` is a member id, and so is `target`,
  except for the device actions (`rename-device`, `revoke-device`), whose `target` is the device
  id.
- **Breaking:** the event hub's `passkeyId` is now `deviceId`, in `subscribe()`, `publishTo()`
  and `disconnect()`.
- **Breaking:** `GET /members` lists people (`id, name, role, created_at, current`), with their
  live devices under `devices` (`id, label, kind, last_used_at, current`). The member-level
  `label` and `last_used_at` fields are gone.
- `PATCH /members/:id` takes `name`, with `label` kept as a deprecated alias.
  `DELETE /members/:id` removes the person and revokes all their devices.
- **Breaking:** `POST /link-requests/claim` needs an `outcome`: `new-member`, `own-device` (one of
  the scanner's devices) or `member` (a device of the live member `memberId`). It also takes an
  optional `signOut` (`none`, `scanner` or `others`). On the client it's
  `claimLink(token, { outcome, memberId, signOut })`. The join status shows the outcome once the
  request is claimed.
- Scanning a join code with the drop-in scan button now opens a confirm dialog
  (`openClaimDialog`, `CLAIM_TEXT`, `CLAIM_CLASSES`). It shows the device's label, name and the
  app's `renderProfile(profile)`, and the ways this member may add it: as a new member, as one of
  their own devices, or as another member's device. Each comes with its sign-out choice. With
  only one way, it's a single confirm button. `createScanButton` takes `claimDialog` options.
- Signing out on a device-key device removes that device from its member, because the cookie
  is the device key (`onDeviceRevoked` with reason `signed-out`). The reply is
  `{ forgotDevice: true }`, and `signOut()` resolves `{ forgotDevice }`. A passkey device signs
  out as before.
- **Breaking:** the audit action for removing a member is now `remove` (it was `revoke`). The new
  audit actions are `revoke-device` and `rename-device`.
- **Breaking:** `testing.addMember()` returns `{ memberId, deviceId, token }`.
- The default refusal messages say "device" where they used to assume a passkey
  (`names_required`, `label_required`, `removed`). The codes are unchanged.
- **Breaking:** `linkOwnDevice` is now a library capability, so the app's admin role must grant
  it or `defineRoles` throws.
- The CSRF guard requires a JSON content type only on requests that have a body; the CSRF header
  is still always required.

### Fixed

- The join screen shows an app's refusal at completion, such as a hook's veto, with a retry,
  instead of saying the code expired.
- The claim dialog works as a modal for keyboard and screen-reader users. Escape cancels, focus
  stays inside it, it's labelled by its title, and its member picker has an accessible name.

### Deprecated

- The `revoke` member action; use `remove`.
- The `onGroupDeleted` hook; use `onGroupDeleting`. It still works when it's the only one given.
- `request.session.passkey` (and the `passkey` field in responses), the 0.2 shape
  `{ id: device.id, label, role }`. It will be removed in 0.4.

## [0.2.0] - 2026-11-01

### Added

- Support for Node's built-in `node:sqlite` (Node 22.5+) alongside `better-sqlite3`. Pass a
  handle from either driver wherever velvet-rope takes a `db`.
- `openDatabase(path, { driver })` opens a database with whichever driver is installed,
  `better-sqlite3` first. `wrapDatabase(db)` adapts a handle the app already opened.
- npm package metadata: repository, homepage and issue tracker.

### Changed

- `better-sqlite3` is now an optional peer dependency.
- The licence is now MPL-2.0.

## [0.1.0] - 2026-10-28

The first version.

### Added

- **Passkey sign-in:** discoverable sign-in, where the passkey picked decides the group.
  Sessions use a hashed 256-bit cookie (`HttpOnly`, `SameSite=Strict`, `__Host-` on HTTPS) with
  a 30-day sliding expiry.
- **Joining by QR:**
  - a new device shows a QR code;
  - a signed-in member who can `link` scans it, and the scan is the approval;
  - the new device then registers its own passkey with the linked role.
- **Groups:** creation, controlled by `groupCreation` (`open`, `invite` or `closed`). Invites
  are single-use, and an admin can delete the group.
- **Roles:** defined by the app with `defineRoles`. Members can be listed, renamed, given a new
  role, revoked, or can leave, and the last admin can't be removed.
- **Server-Sent Events:** a stream per group (`members-changed`, `role-changed`,
  `session-revoked`, `group-deleted`) that the app can share for its own events.
- **Protections:**
  - a CSRF guard (JSON and a custom header);
  - rate limits through `@fastify/rate-limit`;
  - `{ error, message }` refusals that apps can reword;
  - `startSweeper` for expired rows.
- **Entry points:**
  - `velvet-rope/domain`, `/server`, `/client` and `/ui` (with `ui/style.css`);
  - `/testing`, with a soft authenticator and member helpers;
  - `/testing/playwright`.
- An example notes app.

[Unreleased]: https://github.com/EyeOfMidas/velvet-rope/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/EyeOfMidas/velvet-rope/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/EyeOfMidas/velvet-rope/compare/caf6bbb...v0.2.0
[0.1.0]: https://github.com/EyeOfMidas/velvet-rope/commit/caf6bbb
