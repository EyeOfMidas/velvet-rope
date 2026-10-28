CREATE TABLE groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE passkeys (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  role         TEXT NOT NULL,
  user_handle  TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX passkeys_group ON passkeys(group_id);

CREATE TABLE credentials (
  credential_id TEXT PRIMARY KEY,
  passkey_id    TEXT NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
  public_key    BLOB NOT NULL,
  sign_count    INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,
  backed_up     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX credentials_passkey ON credentials(passkey_id);

CREATE TABLE sessions (
  id_hash    TEXT PRIMARY KEY,
  passkey_id TEXT NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_passkey ON sessions(passkey_id);

CREATE TABLE challenges (
  challenge_hash TEXT PRIMARY KEY,
  purpose        TEXT NOT NULL,
  data_json      TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

CREATE TABLE link_requests (
  id         TEXT PRIMARY KEY,
  group_id   TEXT REFERENCES groups(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed')),
  role       TEXT,
  linked_by  TEXT REFERENCES passkeys(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX link_requests_expiry ON link_requests(expires_at);

CREATE TABLE invites (
  code_hash  TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
