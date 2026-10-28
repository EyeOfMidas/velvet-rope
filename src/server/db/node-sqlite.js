// node:sqlite (built into Node 22.5+) differs from better-sqlite3 in four ways this adapter hides:
// no transaction() or pragma() helpers, no pluck(), rows with a null prototype, and BLOBs that
// come back as Uint8Array instead of Buffer.
import { SqliteAdapter } from './adapter.js';

const toBuffer = (value) =>
  value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value;

function toRow(row) {
  if (!row) return undefined;
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, toBuffer(value)]));
}

class NodeSqliteStatement {
  #statement;
  #pluck = false;

  constructor(statement) {
    this.#statement = statement;
  }

  pluck(on = true) {
    this.#pluck = on;
    return this;
  }

  run(...params) {
    const { changes, lastInsertRowid } = this.#statement.run(...params);
    return { changes: Number(changes), lastInsertRowid };
  }

  get(...params) {
    return this.#shape(this.#statement.get(...params));
  }

  all(...params) {
    return this.#statement.all(...params).map((row) => this.#shape(row));
  }

  #shape(row) {
    if (!row) return undefined;
    return this.#pluck ? toBuffer(Object.values(row)[0]) : toRow(row);
  }
}

export class NodeSqliteAdapter extends SqliteAdapter {
  static driver = 'node:sqlite';

  static load() {
    try {
      return process.getBuiltinModule?.('node:sqlite')?.DatabaseSync;
    } catch {
      return undefined; // Node 22.5-22.12 only has it behind --experimental-sqlite
    }
  }

  static matches(raw) {
    return raw?.constructor?.name === 'DatabaseSync';
  }

  #depth = 0;

  prepare(sql) {
    return new NodeSqliteStatement(this.raw.prepare(sql));
  }

  /** BEGIN/COMMIT at the top level, SAVEPOINTs inside it, like better-sqlite3. */
  transaction(fn) {
    return (...args) => {
      const savepoint = `velvet_rope_${this.#depth}`;
      const nested = this.#depth > 0;
      this.raw.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      this.#depth++;
      let result;
      try {
        result = fn(...args);
      } catch (error) {
        this.#depth--;
        try {
          this.raw.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        } catch {
          // SQLite already rolled back; the error that matters is the original one.
        }
        throw error;
      }
      this.#depth--;
      this.raw.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    };
  }

  pragma(text) {
    return this.raw.prepare(`PRAGMA ${text}`).all().map(toRow);
  }
}
