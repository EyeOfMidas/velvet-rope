import { describe, expect, it } from 'vitest';
import { BetterSqlite3Adapter, NodeSqliteAdapter, openDatabase, wrapDatabase } from '../../src/server/db/index.js';

const drivers = [BetterSqlite3Adapter, NodeSqliteAdapter].filter((Adapter) => Adapter.load());

describe('driver detection', () => {
  it('opens a database with whichever driver is installed', () => {
    const db = openDatabase();
    expect(drivers.some((Adapter) => db instanceof Adapter)).toBe(true);
    db.close();
  });

  it('rejects an unknown driver name and a foreign handle', () => {
    expect(() => openDatabase(':memory:', { driver: 'nope' })).toThrow(/unknown driver/);
    expect(() => wrapDatabase({ prepare() {} })).toThrow(/better-sqlite3 or node:sqlite/);
  });
});

describe.each(drivers.map((Adapter) => [Adapter.driver, Adapter]))('%s adapter', (_name, Adapter) => {
  const open = () => {
    const db = openDatabase(':memory:', { driver: Adapter.driver });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB)');
    return db;
  };

  it('is recognised from its raw handle, and wrapping an adapter is a no-op', () => {
    const db = open();
    expect(wrapDatabase(db.raw)).toBeInstanceOf(Adapter);
    expect(wrapDatabase(db)).toBe(db);
  });

  it('runs, gets, plucks and lists rows as plain objects', () => {
    const db = open();
    const insert = db.prepare('INSERT INTO t (name) VALUES (?)');
    expect(insert.run('a').changes).toBe(1);
    insert.run('b');
    expect(db.prepare('SELECT * FROM t WHERE name = ?').get('a')).toStrictEqual({
      id: 1,
      name: 'a',
      data: null,
    });
    expect(db.prepare('SELECT * FROM t WHERE name = ?').get('zzz')).toBeUndefined();
    expect(db.prepare('SELECT name FROM t ORDER BY id').pluck().all()).toEqual(['a', 'b']);
    expect(db.prepare('SELECT MAX(id) FROM t').pluck().get()).toBe(2);
    expect(db.prepare('DELETE FROM t WHERE id = ? RETURNING name').get(1)).toEqual({ name: 'a' });
  });

  it('returns BLOBs as Buffers', () => {
    const db = open();
    db.prepare('INSERT INTO t (data) VALUES (?)').run(Buffer.from([1, 2, 3]));
    const { data } = db.prepare('SELECT data FROM t').get();
    expect(Buffer.isBuffer(data)).toBe(true);
    expect([...data]).toEqual([1, 2, 3]);
    expect(Buffer.isBuffer(db.prepare('SELECT data FROM t').pluck().get())).toBe(true);
  });

  it('commits a transaction and passes its arguments and result through', () => {
    const db = open();
    const add = db.transaction((name) => db.prepare('INSERT INTO t (name) VALUES (?)').run(name).changes);
    expect(add('a')).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM t').pluck().get()).toBe(1);
  });

  it('rolls back on a throw, and a nested throw only undoes the inner work', () => {
    const db = open();
    const insert = (name) => db.prepare('INSERT INTO t (name) VALUES (?)').run(name);
    const count = () => db.prepare('SELECT COUNT(*) FROM t').pluck().get();

    expect(
      db.transaction(() => {
        insert('lost');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(count()).toBe(0);

    const inner = db.transaction(() => {
      insert('inner');
      throw new Error('inner failed');
    });
    db.transaction(() => {
      insert('outer');
      expect(inner).toThrow('inner failed');
    })();
    expect(db.prepare('SELECT name FROM t').pluck().all()).toEqual(['outer']);
  });

  it('applies pragmas', () => {
    const db = open();
    db.pragma('foreign_keys = ON');
    expect(db.pragma('foreign_keys')).toEqual([{ foreign_keys: 1 }]);
  });
});
