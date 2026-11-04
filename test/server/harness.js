// A minimal app around the plugin, the way an app would set it up: a SQLite database
// with velvet-rope's tables plus one app table (an audit log written through the onAudit hook),
// a role matrix, and optional rate limits.
import Fastify from 'fastify';
import { defineRoles } from '../../src/domain/roles.js';
import velvetRope, { createHub, createRateLimiter, migrate, openDatabase } from '../../src/server/index.js';

export const ORIGIN = 'http://localhost:5173';
export const config = { rpId: 'localhost', rpName: 'Test app', origin: ORIGIN };
export const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };

export const roles = defineRoles(
  {
    admin: ['read', 'write', 'link', 'manageMembers', 'deleteGroup', 'linkOwnDevice'],
    collaborator: ['read', 'write', 'link'],
    contributor: ['read', 'write'],
    viewer: ['read'],
  },
  { admin: 'admin', linked: 'viewer' },
);

export function openDb(path = ':memory:') {
  // VELVET_ROPE_DRIVER=node:sqlite runs the whole suite on that driver.
  const db = openDatabase(path, { driver: process.env.VELVET_ROPE_DRIVER || undefined });
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.exec(`CREATE TABLE audit_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id         TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    actor_member_id   TEXT REFERENCES members(id) ON DELETE SET NULL,
    action           TEXT NOT NULL,
    target           TEXT,
    detail_json      TEXT NOT NULL DEFAULT '{}',
    at               INTEGER NOT NULL
  )`);
  return db;
}

function writeAudit(db, { groupId, actorId, action, target, detail = {}, at }) {
  db.prepare(
    `INSERT INTO audit_log (group_id, actor_member_id, action, target, detail_json, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(groupId, actorId, action, target, JSON.stringify(detail), at);
}

/**
 * Same arguments as an app's buildApp; `hub` is exposed for tests that publish app events. Any
 * other plugin option (sessionTtlMs, eventsRoute, …) passes straight through, so a new option
 * needs no change here.
 */
export function buildApp({
  db,
  now = Date.now,
  config: rpConfig = config,
  rateLimits = null,
  groupCreation = 'open',
  events,
  hooks = {},
  ...pluginOptions
}) {
  const app = Fastify({ logger: false });
  const hub = events ?? createHub();
  app.register(velvetRope, {
    ...pluginOptions,
    db,
    now,
    rp: { id: rpConfig.rpId, name: rpConfig.rpName, origin: rpConfig.origin },
    roles,
    groupCreation,
    rateLimit: createRateLimiter(app, rateLimits),
    events: hub,
    hooks: { onAudit: writeAudit, ...hooks },
  });
  app.decorate('hub', hub);
  app.addHook('onClose', async () => db.close());
  return app;
}
