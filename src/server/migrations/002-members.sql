-- velvet-rope: foreign-keys-off
-- A member is a person; a device is one browser that signs in as them. Each old passkey becomes a
-- device and a member with the same id, so app tables that referenced passkeys(id) now reference
-- devices(id) (SQLite rewrites them on the rename) and the same ids still mean the same thing.
--
-- The rebuild of devices (user_handle becomes nullable, for key devices) needs foreign keys off,
-- which is what the marker on line 1 asks migrate() for. migrate() runs foreign_key_check before
-- it commits.
ALTER TABLE passkeys RENAME TO devices;
ALTER TABLE credentials RENAME COLUMN passkey_id TO device_id;
ALTER TABLE sessions RENAME COLUMN passkey_id TO device_id;
ALTER TABLE link_requests RENAME COLUMN linked_by TO claimed_by;

DROP INDEX credentials_passkey;
CREATE INDEX credentials_device ON credentials(device_id);
DROP INDEX sessions_passkey;
CREATE INDEX sessions_device ON sessions(device_id);

CREATE TABLE members (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  ended_reason TEXT CHECK (ended_reason IN ('leave', 'removed'))
);
CREATE INDEX members_group ON members(group_id);

-- A revoked passkey was a removed person: the old model had no other way to end one.
INSERT INTO members (id, group_id, name, role, created_at, ended_at, ended_reason)
  SELECT id, group_id, label, role, created_at, revoked_at,
         CASE WHEN revoked_at IS NULL THEN NULL ELSE 'removed' END
    FROM devices;

-- SQLite can't drop NOT NULL in place, so devices is rebuilt: the role is the member's now.
CREATE TABLE devices_new (
  id           TEXT PRIMARY KEY,
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'passkey' CHECK (kind IN ('passkey', 'key')),
  user_handle  TEXT UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
INSERT INTO devices_new (id, member_id, group_id, label, kind, user_handle, created_at, last_used_at, revoked_at)
  SELECT id, id, group_id, label, 'passkey', user_handle, created_at, last_used_at, revoked_at
    FROM devices;
DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;
CREATE INDEX devices_group ON devices(group_id);
CREATE INDEX devices_member ON devices(member_id);

ALTER TABLE link_requests ADD COLUMN name TEXT;
ALTER TABLE link_requests ADD COLUMN profile_json TEXT;
ALTER TABLE link_requests ADD COLUMN outcome TEXT CHECK (outcome IN ('new-member', 'own-device', 'member'));
ALTER TABLE link_requests ADD COLUMN member_id TEXT REFERENCES members(id) ON DELETE CASCADE;
ALTER TABLE link_requests ADD COLUMN sign_out TEXT CHECK (sign_out IN ('none', 'scanner', 'others'));
