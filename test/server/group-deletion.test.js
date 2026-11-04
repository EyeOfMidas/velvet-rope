// Deleting a whole group (DELETE /group). Admins only. Every row of the group goes through
// ON DELETE CASCADE, app tables included. Open streams of the group hear group-deleted and end.
import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, openDb } from './harness.js';
import { addMember } from '../../src/testing/members.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const ORIGIN = 'http://localhost:5173';
const config = { rpId: 'localhost', rpName: 'Test app', origin: ORIGIN };
const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };

let app;
let db;
let base;
const streams = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.abort();
  await app?.close();
});

function setup() {
  db = openDb(':memory:');
  app = buildApp({ db, config });
}

const me = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
const send = (method, url, cookie, payload = {}) => app.inject({ method, url, headers: { ...CSRF, cookie }, payload });
const deleteGroup = (cookie, name) => send('DELETE', '/api/group', cookie, { name });

async function createGroup(groupName = 'Plans') {
  const auth = createSoftAuthenticator({ origin: ORIGIN });
  const options = (await send('POST', '/api/groups/options', '', { groupName, label: 'Phone' })).json();
  const res = await send('POST', '/api/groups', '', { response: auth.register(options) });
  const cookie = [res.headers['set-cookie']]
    .flat()
    .find((c) => c?.startsWith('velvet_rope_session='))
    .split(';')[0];
  const { member, group } = (await me(cookie)).json();
  return { id: member.id, cookie, groupId: group.id };
}

function insertMember(groupId, role) {
  const { memberId, token } = addMember(db, { groupId, role });
  return { id: memberId, cookie: `velvet_rope_session=${token}` };
}

const count = (table, groupId) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE group_id = ?`).get(groupId).n;

describe('DELETE /api/group', () => {
  it('lets an admin delete the group and everything in it', async () => {
    setup();
    const creator = await createGroup('Plans');
    const viewer = insertMember(creator.groupId, 'viewer');
    const other = await createGroup('Other');
    const { token } = (await send('POST', '/api/link-requests', '', { label: 'Laptop' })).json();
    await send('POST', '/api/link-requests/claim', creator.cookie, { token, outcome: 'new-member' });
    expect(count('link_requests', creator.groupId)).toBe(1);

    const res = await deleteGroup(creator.cookie, 'Plans');
    expect(res.statusCode).toBe(204);
    expect([res.headers['set-cookie']].flat().some((c) => /^velvet_rope_session=;/.test(c ?? ''))).toBe(true);

    expect(db.prepare('SELECT COUNT(*) AS n FROM groups WHERE id = ?').get(creator.groupId).n).toBe(0);
    for (const table of ['members', 'devices', 'link_requests', 'audit_log']) {
      expect(count(table, creator.groupId)).toBe(0);
    }
    const leftovers = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions s JOIN devices d ON d.id = s.device_id) AS sessions,
           (SELECT COUNT(*) FROM credentials) AS credentials`,
      )
      .get();
    // Only the other group's admin is left.
    expect(leftovers).toEqual({ sessions: 1, credentials: 1 });
    expect((await me(creator.cookie)).statusCode).toBe(401);
    expect((await me(viewer.cookie)).statusCode).toBe(401);

    // The other group is untouched.
    expect((await me(other.cookie)).statusCode).toBe(200);
  });

  it('refuses everyone but an admin', async () => {
    setup();
    const creator = await createGroup();
    for (const role of ['collaborator', 'contributor', 'viewer']) {
      const member = insertMember(creator.groupId, role);
      const res = await deleteGroup(member.cookie, 'Plans');
      expect(res.statusCode, role).toBe(403);
      expect(res.json()).toMatchObject({ error: 'delete_forbidden' });
    }
    expect((await me(creator.cookie)).statusCode).toBe(200);
  });

  it('lets any admin delete it, not only the one who created it', async () => {
    setup();
    const creator = await createGroup('Plans');
    const admin = insertMember(creator.groupId, 'admin');
    expect((await deleteGroup(admin.cookie, 'Plans')).statusCode).toBe(204);
    expect((await me(creator.cookie)).statusCode).toBe(401);
  });

  it('needs the group’s name, typed exactly', async () => {
    setup();
    const creator = await createGroup('Plans');
    const res = await deleteGroup(creator.cookie, 'plans');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'confirm_name' });
    expect((await me(creator.cookie)).statusCode).toBe(200);
  });

  it('needs a session and the CSRF header', async () => {
    setup();
    const creator = await createGroup('Plans');
    expect((await deleteGroup('', 'Plans')).statusCode).toBe(401);
    const noHeader = await app.inject({
      method: 'DELETE',
      url: '/api/group',
      headers: { 'content-type': 'application/json', cookie: creator.cookie },
      payload: { name: 'Plans' },
    });
    expect(noHeader.statusCode).toBe(403);
    expect((await me(creator.cookie)).statusCode).toBe(200);
  });
});

async function listen() {
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
}

async function openStream(cookie) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: controller.signal });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const stream = { text: '', done: false, abort: () => controller.abort() };
  stream.readToEnd = async (ms = 2000) => {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out; got: ${stream.text}`)), ms),
    );
    while (!stream.done) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) stream.done = true;
      else stream.text += chunk.value;
    }
  };
  streams.push(stream);
  return stream;
}

describe('group deletion events', () => {
  it('tells every open stream of the group and ends them; other groups hear nothing', async () => {
    setup();
    await listen();
    const creator = await createGroup('Plans');
    const viewer = insertMember(creator.groupId, 'viewer');
    const other = await createGroup('Other');
    const creatorStream = await openStream(creator.cookie);
    const viewerStream = await openStream(viewer.cookie);
    const otherStream = await openStream(other.cookie);
    await expect.poll(() => app.hub.subscriberCount(creator.groupId)).toBe(2);

    expect((await deleteGroup(creator.cookie, 'Plans')).statusCode).toBe(204);

    await creatorStream.readToEnd();
    await viewerStream.readToEnd();
    for (const stream of [creatorStream, viewerStream]) {
      expect(stream.text).toContain('event: group-deleted\ndata: {"name":"Plans"}');
    }
    expect(app.hub.subscriberCount(creator.groupId)).toBe(0);
    expect(app.hub.subscriberCount(other.groupId)).toBe(1);
    expect(otherStream.text).not.toContain('group-deleted');
  });
});
