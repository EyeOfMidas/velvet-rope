// A minimal app around the plugin, the way an app would set it up: a better-sqlite3 database
// with velvet-rope's tables plus one app table (an audit log written through the onAudit hook),
// a role matrix, and optional rate limits.
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { defineRoles } from '../../src/domain/roles.js';
import velvetRope, { createHub, createRateLimiter, migrate } from '../../src/server/index.js';

export const ORIGIN = 'http://localhost:5173';
export const config = { rpId: 'localhost', rpName: 'Test app', origin: ORIGIN };
export const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };

export const roles = defineRoles(
  {
    admin: ['read', 'write', 'link', 'manageMembers', 'deleteGroup'],
    collaborator: ['read', 'write', 'link'],
    contributor: ['read', 'write'],
    viewer: ['read'],
  },
  { admin: 'admin', linked: 'viewer' },
);

export function openDb(path = ':memory:') {
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.exec(`CREATE TABLE audit_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id         TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    actor_passkey_id TEXT REFERENCES passkeys(id) ON DELETE SET NULL,
    action           TEXT NOT NULL,
    target           TEXT,
    detail_json      TEXT NOT NULL DEFAULT '{}',
    at               INTEGER NOT NULL
  )`);
  return db;
}

function writeAudit(db, { groupId, actorId, action, target, detail = {}, at }) {
  db.prepare(
    `INSERT INTO audit_log (group_id, actor_passkey_id, action, target, detail_json, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(groupId, actorId, action, target, JSON.stringify(detail), at);
}

/** Same arguments as an app's buildApp; `hub` is exposed for tests that publish app events. */
export function buildApp({
  db,
  now = Date.now,
  config: rpConfig = config,
  heartbeatMs,
  rateLimits = null,
  groupCreation = 'open',
}) {
  const app = Fastify({ logger: false });
  const hub = createHub();
  app.register(velvetRope, {
    db,
    now,
    rp: { id: rpConfig.rpId, name: rpConfig.rpName, origin: rpConfig.origin },
    roles,
    groupCreation,
    rateLimit: createRateLimiter(app, rateLimits),
    events: hub,
    heartbeatMs,
    hooks: { onAudit: writeAudit },
  });
  app.decorate('hub', hub);
  app.addHook('onClose', async () => db.close());
  return app;
}
