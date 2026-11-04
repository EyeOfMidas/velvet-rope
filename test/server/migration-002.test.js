// Migration 002 on a populated 0.2 database: each passkey becomes a device and a member with the
// same id, roles move to the member, and app tables that referenced passkeys(id) follow the rename.
import { copyFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db/index.js';
import { applyMigrations, migrate } from '../../src/server/migrate.js';

const migrations = join(dirname(fileURLToPath(import.meta.url)), '../../src/server/migrations');

/** A 0.2 database: only 001 applied, then data a real group would have. */
function openVersion02() {
  const db = openDatabase(':memory:', { driver: process.env.VELVET_ROPE_DRIVER || undefined });
  db.pragma('foreign_keys = ON');
  const only001 = mkdtempSync(join(tmpdir(), 'vr-001-'));
  mkdirSync(only001, { recursive: true });
  copyFileSync(join(migrations, '001-init.sql'), join(only001, '001-init.sql'));
  applyMigrations(db, only001);

  db.exec(`
    INSERT INTO groups VALUES ('g1', 'Family', 100);
    INSERT INTO passkeys VALUES ('p-admin', 'g1', 'Mum phone', 'admin', 'uh-admin', 101, 150, NULL);
    INSERT INTO passkeys VALUES ('p-kid', 'g1', 'Kid tablet', 'viewer', 'uh-kid', 102, NULL, NULL);
    INSERT INTO passkeys VALUES ('p-gone', 'g1', 'Old laptop', 'contributor', 'uh-gone', 103, 120, 200);
    INSERT INTO credentials VALUES ('cred-admin', 'p-admin', x'0102', 7, '["internal"]', 1);
    INSERT INTO credentials VALUES ('cred-kid', 'p-kid', x'0304', 0, NULL, 0);
    INSERT INTO sessions VALUES ('hash-admin', 'p-admin', 101, 999);
    INSERT INTO sessions VALUES ('hash-kid', 'p-kid', 102, 999);
    INSERT INTO link_requests (id, group_id, token_hash, label, status, role, linked_by, created_at, expires_at)
      VALUES ('lr1', 'g1', 'tok', 'New phone', 'claimed', 'viewer', 'p-admin', 300, 600);
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      created_by TEXT REFERENCES passkeys(id) ON DELETE SET NULL,
      text TEXT NOT NULL
    );
    INSERT INTO notes VALUES ('n1', 'p-kid', 'hello'), ('n2', 'p-gone', 'bye');
  `);
  return db;
}

describe('migration 002', () => {
  let db;
  beforeEach(() => {
    db = openVersion02();
    migrate(db);
  });

  it('turns every passkey into a device and a member with the same id', () => {
    expect(
      db
        .prepare(
          'SELECT id, member_id, group_id, label, kind, user_handle, created_at, last_used_at, revoked_at FROM devices ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        id: 'p-admin',
        member_id: 'p-admin',
        group_id: 'g1',
        label: 'Mum phone',
        kind: 'passkey',
        user_handle: 'uh-admin',
        created_at: 101,
        last_used_at: 150,
        revoked_at: null,
      },
      {
        id: 'p-gone',
        member_id: 'p-gone',
        group_id: 'g1',
        label: 'Old laptop',
        kind: 'passkey',
        user_handle: 'uh-gone',
        created_at: 103,
        last_used_at: 120,
        revoked_at: 200,
      },
      {
        id: 'p-kid',
        member_id: 'p-kid',
        group_id: 'g1',
        label: 'Kid tablet',
        kind: 'passkey',
        user_handle: 'uh-kid',
        created_at: 102,
        last_used_at: null,
        revoked_at: null,
      },
    ]);
    expect(db.prepare('SELECT * FROM members ORDER BY id').all()).toEqual([
      {
        id: 'p-admin',
        group_id: 'g1',
        name: 'Mum phone',
        role: 'admin',
        created_at: 101,
        ended_at: null,
        ended_reason: null,
      },
      {
        id: 'p-gone',
        group_id: 'g1',
        name: 'Old laptop',
        role: 'contributor',
        created_at: 103,
        ended_at: 200,
        ended_reason: 'removed',
      },
      {
        id: 'p-kid',
        group_id: 'g1',
        name: 'Kid tablet',
        role: 'viewer',
        created_at: 102,
        ended_at: null,
        ended_reason: null,
      },
    ]);
  });

  it('moves the role to the member and drops the passkeys table', () => {
    const columns = db
      .prepare('PRAGMA table_info(devices)')
      .all()
      .map((c) => c.name);
    expect(columns).not.toContain('role');
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'passkeys'`).all()).toEqual([]);
  });

  it('lets a device have no user handle', () => {
    db.prepare(
      `INSERT INTO devices (id, member_id, group_id, label, kind, created_at) VALUES ('d', 'p-kid', 'g1', 'k', 'key', 1)`,
    ).run();
    expect(db.prepare(`SELECT user_handle FROM devices WHERE id = 'd'`).pluck().get()).toBeNull();
  });

  it('keeps credentials, sessions and link requests, pointing at devices', () => {
    expect(
      db
        .prepare(
          'SELECT credential_id, device_id, public_key, sign_count, transports, backed_up FROM credentials ORDER BY credential_id',
        )
        .all(),
    ).toEqual([
      {
        credential_id: 'cred-admin',
        device_id: 'p-admin',
        public_key: Buffer.from([1, 2]),
        sign_count: 7,
        transports: '["internal"]',
        backed_up: 1,
      },
      {
        credential_id: 'cred-kid',
        device_id: 'p-kid',
        public_key: Buffer.from([3, 4]),
        sign_count: 0,
        transports: null,
        backed_up: 0,
      },
    ]);
    expect(db.prepare('SELECT id_hash, device_id FROM sessions ORDER BY id_hash').all()).toEqual([
      { id_hash: 'hash-admin', device_id: 'p-admin' },
      { id_hash: 'hash-kid', device_id: 'p-kid' },
    ]);
    expect(db.prepare('SELECT id, role, claimed_by, outcome, member_id FROM link_requests').all()).toEqual([
      { id: 'lr1', role: 'viewer', claimed_by: 'p-admin', outcome: null, member_id: null },
    ]);
  });

  it('makes an app table that referenced passkeys(id) reference devices(id)', () => {
    expect(db.prepare('SELECT id, created_by FROM notes ORDER BY id').all()).toEqual([
      { id: 'n1', created_by: 'p-kid' },
      { id: 'n2', created_by: 'p-gone' },
    ]);
    expect(
      db
        .prepare('PRAGMA foreign_key_list(notes)')
        .all()
        .map((f) => f.table),
    ).toEqual(['devices']);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys')[0].foreign_keys).toBe(1);
  });

  it('still cascades from the group to members, devices and sessions', () => {
    db.prepare(`DELETE FROM groups WHERE id = 'g1'`).run();
    for (const table of ['members', 'devices', 'credentials', 'sessions', 'link_requests']) {
      expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), table).toBe(0);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
