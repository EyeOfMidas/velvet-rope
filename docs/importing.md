# Importing from an existing app

You already have an app with its own users and devices, and you want to move it onto
velvet-rope without anyone signing in again. This is a one-off SQL copy. The next request from
each phone carries the cookie it already has, and velvet-rope recognises it.

The worked example is a book club app with three tables:

- `clubs`: the groups.
- `readers`: people, with a `status` of `member`, `former` or `pending`, and a `role`.
- `reader_devices`: one row per browser, with a `name` and a `cookie_hash`.

## When this works

The old device cookie has to be:

- a 256-bit random value, and
- stored as its SHA-256 hash in lowercase hex, which is what velvet-rope stores too.

Then each hash copies straight into `sessions.id_hash`. The cookie also has to reach
velvet-rope's routes as it is today, so it needs these attributes:

```
HttpOnly; Secure; SameSite=Strict; Path=/
```

If the hash is a different algorithm, or the cookie is scoped to another path, this recipe
doesn't apply: those phones will have to sign in again.

## Options to set

```js
app.register(velvetRope, {
  // ...your usual options
  sessionCookieName: 'club_device', // the old cookie's name, exactly
  credentials: ['passkey', 'key'], // imported devices are device keys
  ids: { group: newClubId }, // only if new rows should keep the old id shape
});
```

`sessionCookieName` replaces the whole name, including the `__Host-` prefix logic. `ids` takes
`group`, `member` and `device`, each a `() => string`. Old ids are copied as they are, so
`ids` only matters for rows created after the switch.

## Order

1. Back up the database.
2. Run `migrate(db)`. This creates velvet-rope's tables next to yours.
3. Run the copy below, once, in one transaction. It either all happens or none of it does.
4. Deploy the app with the options above.

## What maps to what

| Book club app                          | Velvet-rope                                                      |
| -------------------------------------- | ---------------------------------------------------------------- |
| `clubs`                                | `groups` (same ids)                                              |
| `readers` with status `member`         | `members` (same ids, `name` and `role` as they are)              |
| `readers` with status `former`         | `members` with `ended_at` set, so the ids stay taken             |
| `reader_devices`                       | `devices`, kind `key`, `label` from the device's name            |
| `reader_devices.cookie_hash`           | `sessions.id_hash`, `expires_at` = now + the key lifetime        |

Your role names must be the ones you pass to `defineRoles`. Timestamps are milliseconds since
the epoch; convert them in the `SELECT` if yours are seconds.

## The SQL

The key lifetime below is 400 days, velvet-rope's default for device keys. If you set
`sessionTtlMs.key`, use the same number here.

```sql
BEGIN;

INSERT INTO groups (id, name, created_at)
  SELECT id, name, created_at FROM clubs;

INSERT INTO members (id, group_id, name, role, created_at, ended_at, ended_reason)
  SELECT id, club_id, name, role, created_at,
         CASE WHEN status = 'former' THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000 END,
         CASE WHEN status = 'former' THEN 'removed' END
    FROM readers
   WHERE status IN ('member', 'former');

-- Devices of former readers come across revoked, with no session, so they can't sign in.
INSERT INTO devices (id, member_id, group_id, label, kind, created_at, revoked_at)
  SELECT d.id, d.reader_id, r.club_id, d.name, 'key', d.created_at, m.ended_at
    FROM reader_devices d
    JOIN readers r ON r.id = d.reader_id
    JOIN members m ON m.id = r.id;

INSERT INTO sessions (id_hash, device_id, created_at, expires_at)
  SELECT d.cookie_hash, d.id, CAST(strftime('%s', 'now') AS INTEGER) * 1000,
         CAST(strftime('%s', 'now') AS INTEGER) * 1000 + 34560000000
    FROM reader_devices d
    JOIN members m ON m.id = d.reader_id AND m.ended_at IS NULL;

COMMIT;
```

When you're happy, drop the old tables. Keep them until then; the copy doesn't change them.

## Former and pending readers

Former readers are imported as ended members. Their ids stay taken, so anything in your own
tables that points at them (a review, a vote) still has a person to point at, and the ids can't
be handed out again. They have no live device and can't sign in.

Pending or unapproved readers aren't imported. They join again with the new flow: they show a
QR code and a member scans it.

## Passkeys later

Imported devices are device keys: the cookie is the only credential, so clearing the browser's
data signs that phone out for good. Each person can upgrade a device to a passkey whenever they
like, from the device itself, with the client's `upgradeToPasskey()`. Nothing else changes: the
device keeps its id and label.
