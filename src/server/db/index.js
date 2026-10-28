// Picks the SQLite driver. A database an app already opened is recognised by its shape
// (wrapDatabase); one velvet-rope opens for the app uses whichever driver is installed
// (openDatabase), better-sqlite3 first.
import { SqliteAdapter } from './adapter.js';
import { BetterSqlite3Adapter } from './better-sqlite3.js';
import { NodeSqliteAdapter } from './node-sqlite.js';

export { SqliteAdapter, BetterSqlite3Adapter, NodeSqliteAdapter };

/** In order of preference. */
const ADAPTERS = [BetterSqlite3Adapter, NodeSqliteAdapter];

/** Wraps a better-sqlite3 or node:sqlite database; an adapter is returned as it is. */
export function wrapDatabase(db) {
  if (db instanceof SqliteAdapter) return db;
  const Adapter = ADAPTERS.find((candidate) => candidate.matches(db));
  if (!Adapter) {
    throw new Error('velvet-rope: `db` must be a better-sqlite3 or node:sqlite database');
  }
  return new Adapter(db);
}

/**
 * Opens a database with the first installed driver, or the one named by `driver`
 * ('better-sqlite3' or 'node:sqlite').
 */
export function openDatabase(path = ':memory:', { driver } = {}) {
  const candidates = driver ? ADAPTERS.filter((a) => a.driver === driver) : ADAPTERS;
  if (candidates.length === 0) {
    throw new Error(`velvet-rope: unknown driver "${driver}"; use ${ADAPTERS.map((a) => a.driver).join(' or ')}`);
  }
  const Adapter = candidates.find((candidate) => candidate.load());
  if (!Adapter) {
    throw new Error(
      `velvet-rope: no SQLite driver found. Install better-sqlite3, or run on a Node that has node:sqlite.`,
    );
  }
  return Adapter.open(path);
}
