// The example's server: velvet-rope plus a notes table and four routes that show view, edit and
// delete permissions. buildApp is separate from server.js so tests can use it.
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import velvetRope, { migrate, openDatabase } from '../src/server/index.js';
import { canEditNote, roles } from './roles.js';

export function openDb(path = ':memory:') {
  const db = openDatabase(path);
  db.pragma('foreign_keys = ON');
  migrate(db);
  db.exec(`CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL
  )`);
  return db;
}

export function buildApp({ db, origin = 'http://localhost:5174', now = Date.now, credentials }) {
  const app = Fastify({ trustProxy: 'loopback' });
  app.register(velvetRope, {
    db,
    now,
    rp: { id: new URL(origin).hostname, name: 'velvet-rope notes', origin },
    roles,
    credentials,
    cookiePrefix: 'notes',
    csrfHeader: 'X-Notes',
  });

  app.register(async (notes) => {
    const find = (req) =>
      db.prepare('SELECT * FROM notes WHERE id = ? AND group_id = ?').get(req.params.id, req.session.group.id);
    const trimNoteText = (value) => (typeof value === 'string' ? value.trim().slice(0, 500) : '');

    // View: anyone whose role can read. Every query is scoped to the session's group.
    notes.get('/api/notes', { onRequest: app.requireCapability('read') }, async (req) =>
      db
        .prepare(
          `SELECT n.id, n.text, n.created_by, m.name AS author FROM notes n
             LEFT JOIN members m ON m.id = n.created_by
            WHERE n.group_id = ? ORDER BY n.created_at`,
        )
        .all(req.session.group.id),
    );

    notes.post('/api/notes', { onRequest: app.requireCapability('write') }, async (req, reply) => {
      const text = trimNoteText(req.body?.text);
      if (!text) return reply.code(400).send({ error: 'text_required', message: 'Write something' });
      const note = { id: randomUUID(), text };
      db.prepare('INSERT INTO notes (id, group_id, text, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(
        note.id,
        req.session.group.id,
        text,
        req.session.member.id,
        now(),
      );
      app.velvetRope.events.publish(req.session.group.id, 'notes-changed', {});
      return reply.code(201).send(note);
    });

    // Edit: the role check, then the per-note rule.
    notes.put('/api/notes/:id', { onRequest: app.requireCapability('write') }, async (req, reply) => {
      const note = find(req);
      if (!note) return reply.code(404).send({ error: 'not_found', message: 'No such note' });
      if (!canEditNote(req.session, note)) {
        return reply.code(403).send({ error: 'forbidden', message: 'You can edit only your notes' });
      }
      const text = trimNoteText(req.body?.text);
      if (!text) return reply.code(400).send({ error: 'text_required', message: 'Write something' });
      db.prepare('UPDATE notes SET text = ? WHERE id = ?').run(text, note.id);
      app.velvetRope.events.publish(req.session.group.id, 'notes-changed', {});
      return { ...note, text };
    });

    // Delete: the role alone decides.
    notes.delete('/api/notes/:id', { onRequest: app.requireCapability('delete') }, async (req, reply) => {
      const gone = db
        .prepare('DELETE FROM notes WHERE id = ? AND group_id = ?')
        .run(req.params.id, req.session.group.id);
      if (!gone.changes) return reply.code(404).send({ error: 'not_found', message: 'No such note' });
      app.velvetRope.events.publish(req.session.group.id, 'notes-changed', {});
      return reply.code(204).send();
    });
  });

  app.addHook('onClose', async () => db.close());
  return app;
}
