// better-sqlite3 already has the interface SqliteAdapter describes, so this adapter mostly
// delegates.
import { createRequire } from 'node:module';
import { SqliteAdapter } from './adapter.js';

export class BetterSqlite3Adapter extends SqliteAdapter {
  static driver = 'better-sqlite3';

  static load() {
    try {
      return createRequire(import.meta.url)('better-sqlite3');
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') return undefined;
      throw error;
    }
  }

  static matches(raw) {
    return typeof raw?.transaction === 'function' && typeof raw?.pragma === 'function';
  }

  prepare(sql) {
    return this.raw.prepare(sql);
  }

  transaction(fn) {
    return this.raw.transaction(fn);
  }

  pragma(text) {
    return this.raw.pragma(text);
  }
}
