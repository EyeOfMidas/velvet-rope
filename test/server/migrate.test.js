import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db/index.js';
import { applyMigrations } from '../../src/server/migrate.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const open = () => openDatabase(':memory:', { driver: process.env.VELVET_ROPE_DRIVER || undefined });
const version = (db) => db.prepare('SELECT MAX(version) FROM velvet_rope_schema').pluck().get();
const foreignKeys = (db) => Object.values(db.pragma('foreign_keys')[0])[0];

describe('a migration marked foreign-keys-off', () => {
  it('can rebuild a referenced table and leaves the referencing rows intact', () => {
    const db = open();
    applyMigrations(db, join(fixtures, 'migrations-ok'));
    expect(version(db)).toBe(2);
    expect(db.prepare('SELECT id, owner_id FROM notes ORDER BY id').all()).toEqual([
      { id: 'n1', owner_id: 'o1' },
      { id: 'n2', owner_id: 'o2' },
    ]);
    expect(db.prepare('SELECT id, name FROM owners ORDER BY id').all()).toEqual([
      { id: 'o1', name: 'Ada' },
      { id: 'o2', name: 'Bo' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(foreignKeys(db)).toBe(1);
  });

  it('rolls back and throws when it leaves a dangling reference', () => {
    const db = open();
    expect(() => applyMigrations(db, join(fixtures, 'migrations-dangling'))).toThrow(/left dangling foreign keys/);
    expect(version(db)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM owners').pluck().get()).toBe(2);
    expect(foreignKeys(db)).toBe(1);
  });

  it('puts foreign keys back to off when they were off before', () => {
    const db = open();
    db.pragma('foreign_keys = OFF');
    applyMigrations(db, join(fixtures, 'migrations-ok'));
    expect(foreignKeys(db)).toBe(0);
  });
});
