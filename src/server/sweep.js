// Periodic clean-up of rows that can no longer be used: sessions, challenges, join requests and
// invites past their expiry. Expiry is checked wherever these are read, so the sweep only
// keeps the tables small. The app starts it next to app.listen(); the plugin doesn't, so tests
// stay deterministic.
import { wrapDatabase } from './db/index.js';

const TABLES = {
  sessions: 'sessions',
  challenges: 'challenges',
  linkRequests: 'link_requests',
  invites: 'invites',
};

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Deletes every expired row as of `now`; returns how many went from each table. */
export function sweepExpired(database, now) {
  const db = wrapDatabase(database);
  return db.transaction(() =>
    Object.fromEntries(
      Object.entries(TABLES).map(([key, table]) => [
        key,
        db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(now).changes,
      ]),
    ),
  )();
}

/** Sweeps now and then every `intervalMs`; returns a function that stops it. */
export function startSweeper(db, { now = Date.now, intervalMs = SWEEP_INTERVAL_MS } = {}) {
  const sweep = () => sweepExpired(db, now());
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
