// Manage passkeys: list, rename, change role, revoke, leave.
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp, openDb } from './harness.js';
import { createSession } from '../../src/testing/members.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const ORIGIN = 'http://localhost:5173';
const config = { rpId: 'localhost', rpName: 'Test app', origin: ORIGIN };
const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };
const NO_PERMISSION = { error: 'manage_forbidden' };
const LAST_ADMIN = { error: 'last_admin' };

let app;
let db;
let clock;
afterEach(() => app?.close());

function setup() {
  clock = { t: 1_700_000_000_000 };
  db = openDb(':memory:');
  app = buildApp({ db, now: () => clock.t, config });
}

function cookieFrom(res, name) {
  return [res.headers['set-cookie']]
    .flat()
    .find((c) => c?.startsWith(`${name}=`))
    ?.split(';')[0];
}

const me = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

/** Creates a group through the API; returns its creator's (first admin's) { id, cookie, groupId }. */
async function createGroup(groupName = 'Plans') {
  const auth = createSoftAuthenticator({ origin: ORIGIN });
  const options = (
    await app.inject({
      method: 'POST',
      url: '/api/groups/options',
      headers: CSRF,
      payload: { groupName, label: 'Phone' },
    })
  ).json();
  const res = await app.inject({
    method: 'POST',
    url: '/api/groups',
    headers: CSRF,
    payload: { response: auth.register(options) },
  });
  const cookie = cookieFrom(res, 'velvet_rope_session');
  const { passkey, group } = (await me(cookie)).json();
  return { id: passkey.id, cookie, groupId: group.id };
}

/** Adds a passkey with the given role straight into the group; returns { id, cookie }. */
function insertMember(groupId, role, label = `${role} device`) {
  const id = randomUUID();
  clock.t += 1000; // distinct created_at, so ordering is deterministic
  db.prepare(
    `INSERT INTO passkeys (id, group_id, label, role, user_handle, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, groupId, label, role, randomUUID(), clock.t);
  return { id, cookie: `velvet_rope_session=${createSession(db, id, clock.t)}` };
}

const list = (cookie) =>
  app.inject({ method: 'GET', url: '/api/members', headers: cookie ? { cookie } : {} });
const patch = (cookie, id, payload) =>
  app.inject({
    method: 'PATCH',
    url: `/api/members/${id}`,
    headers: { ...CSRF, cookie },
    payload,
  });
const revoke = (cookie, id) =>
  app.inject({
    method: 'DELETE',
    url: `/api/members/${id}`,
    headers: { ...CSRF, cookie },
    payload: {},
  });
const leave = (cookie) =>
  app.inject({
    method: 'POST',
    url: '/api/members/leave',
    headers: { ...CSRF, cookie },
    payload: {},
  });

describe('GET /api/members', () => {
  it('needs a session', async () => {
    setup();
    const res = await list();
    expect(res.statusCode).toBe(401);
  });

  it('lists the group’s live passkeys, oldest first, marking the current one', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer', 'Laptop');
    const admin = insertMember(creator.groupId, 'admin', 'Tablet');
    const gone = insertMember(creator.groupId, 'collaborator', 'Old phone');
    db.prepare('UPDATE passkeys SET revoked_at = ? WHERE id = ?').run(clock.t, gone.id);
    db.prepare('UPDATE passkeys SET last_used_at = ? WHERE id = ?').run(clock.t, viewer.id);

    const res = await list(admin.cookie);
    expect(res.statusCode).toBe(200);
    const items = res.json();
    expect(items.map((p) => p.label)).toEqual(['Phone', 'Laptop', 'Tablet']);
    expect(items[1]).toEqual({
      id: viewer.id,
      label: 'Laptop',
      role: 'viewer',
      created_at: expect.any(Number),
      last_used_at: clock.t,
      current: false,
    });
    expect(items.map((p) => p.current)).toEqual([false, false, true]);
    expect(items[0]).toMatchObject({ id: creator.id, role: 'admin' });
  });

  it('never lists another group’s passkeys', async () => {
    setup();
    const alice = await createGroup('Alice');
    const bob = await createGroup('Bob');
    insertMember(bob.groupId, 'viewer', 'Bob laptop');
    expect((await list(alice.cookie)).json().map((p) => p.label)).toEqual(['Phone']);
  });
});

describe('PATCH /api/members/:id', () => {
  it('lets an admin raise a viewer to collaborator, effective immediately', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    const viewer = insertMember(creator.groupId, 'viewer', 'Laptop');

    const res = await patch(admin.cookie, viewer.id, { role: 'collaborator' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: viewer.id,
      label: 'Laptop',
      role: 'collaborator',
      created_at: expect.any(Number),
      last_used_at: null,
      current: false,
    });
    expect((await me(viewer.cookie)).json().passkey.role).toBe('collaborator');
  });

  it('renames a passkey, trimming the label', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const res = await patch(creator.cookie, viewer.id, { label: '  Work laptop  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().label).toBe('Work laptop');
  });

  it('lets the last admin rename their own passkey', async () => {
    setup();
    const creator = await createGroup();
    const res = await patch(creator.cookie, creator.id, { label: 'Pixel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ label: 'Pixel', role: 'admin', current: true });
  });

  it('rejects a blank or over-long label', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    expect((await patch(creator.cookie, viewer.id, { label: '  ' })).statusCode).toBe(400);
    expect((await patch(creator.cookie, viewer.id, { label: 'x'.repeat(61) })).statusCode).toBe(
      400,
    );
    expect((await patch(creator.cookie, viewer.id, { label: 7 })).statusCode).toBe(400);
  });

  it('rejects a body with nothing to change', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    expect((await patch(creator.cookie, viewer.id, {})).statusCode).toBe(400);
  });

  it('needs a session and the CSRF headers', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    expect((await patch('velvet_rope_session=nope', viewer.id, { label: 'x' })).statusCode).toBe(
      401,
    );
    const noCsrf = await app.inject({
      method: 'PATCH',
      url: `/api/members/${viewer.id}`,
      headers: { 'content-type': 'application/json', cookie: creator.cookie },
      payload: { label: 'x' },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('404s for an unknown passkey', async () => {
    setup();
    const creator = await createGroup();
    expect((await patch(creator.cookie, randomUUID(), { label: 'x' })).statusCode).toBe(404);
  });
});

describe('DELETE /api/members/:id', () => {
  it('revokes a passkey: its sessions end at once and it leaves the list', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const res = await revoke(creator.cookie, viewer.id);
    expect(res.statusCode).toBe(204);
    expect((await me(viewer.cookie)).statusCode).toBe(401);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE passkey_id = ?').get(viewer.id).n,
    ).toBe(0);
    expect(
      db.prepare('SELECT revoked_at FROM passkeys WHERE id = ?').get(viewer.id).revoked_at,
    ).toBe(clock.t);
    expect((await list(creator.cookie)).json().map((p) => p.id)).toEqual([creator.id]);
  });

  it('lets an admin revoke their own passkey', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    expect((await revoke(admin.cookie, admin.id)).statusCode).toBe(204);
    expect((await me(admin.cookie)).statusCode).toBe(401);
  });

  it('404s for an already revoked passkey', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    await revoke(creator.cookie, viewer.id);
    expect((await revoke(creator.cookie, viewer.id)).statusCode).toBe(404);
    expect((await patch(creator.cookie, viewer.id, { label: 'x' })).statusCode).toBe(404);
  });
});

describe('POST /api/members/leave', () => {
  it('lets a viewer leave: passkey revoked, cookie cleared', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const res = await leave(viewer.cookie);
    expect(res.statusCode).toBe(204);
    const cleared = [res.headers['set-cookie']]
      .flat()
      .find((c) => c?.startsWith('velvet_rope_session='));
    expect(cleared).toMatch(/^velvet_rope_session=; .*Max-Age=0/);
    expect((await me(viewer.cookie)).statusCode).toBe(401);
    expect((await list(creator.cookie)).json().map((p) => p.id)).toEqual([creator.id]);
  });

  it('needs a session', async () => {
    setup();
    expect((await leave('velvet_rope_session=nope')).statusCode).toBe(401);
  });

  it('refuses the last admin', async () => {
    setup();
    const creator = await createGroup();
    insertMember(creator.groupId, 'collaborator');
    const res = await leave(creator.cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject(LAST_ADMIN);
    expect((await me(creator.cookie)).statusCode).toBe(200);
  });

  it('lets the group’s creator leave once there’s another admin', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    expect((await leave(creator.cookie)).statusCode).toBe(204);
    expect((await me(creator.cookie)).statusCode).toBe(401);
    expect((await list(admin.cookie)).json().map((p) => p.id)).toEqual([admin.id]);
  });
});

describe('permissions are enforced by the API', () => {
  for (const role of ['collaborator', 'contributor', 'viewer']) {
    it(`a ${role} can’t rename, change roles or revoke`, async () => {
      setup();
      const creator = await createGroup();
      const actor = insertMember(creator.groupId, role);
      const viewer = insertMember(creator.groupId, 'viewer', 'Laptop');

      for (const res of [
        await patch(actor.cookie, viewer.id, { label: 'Hijacked' }),
        await patch(actor.cookie, viewer.id, { role: 'admin' }),
        await patch(actor.cookie, actor.id, { role: 'admin' }),
        await revoke(actor.cookie, viewer.id),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject(NO_PERMISSION);
      }
      const row = db.prepare('SELECT label, role, revoked_at FROM passkeys WHERE id = ?');
      expect(row.get(viewer.id)).toEqual({ label: 'Laptop', role: 'viewer', revoked_at: null });
      expect(row.get(actor.id).role).toBe(role);
    });
  }

  it('admins are equal: an admin can rename, demote and revoke the group’s creator', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    expect((await patch(admin.cookie, creator.id, { label: 'Old phone' })).statusCode).toBe(200);
    expect((await patch(admin.cookie, creator.id, { role: 'viewer' })).statusCode).toBe(200);
    expect((await me(creator.cookie)).json().passkey).toMatchObject({
      label: 'Old phone',
      role: 'viewer',
    });
    expect((await revoke(admin.cookie, creator.id)).statusCode).toBe(204);
    expect((await me(creator.cookie)).statusCode).toBe(401);
  });

  it('nobody can make a passkey owner', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    const viewer = insertMember(creator.groupId, 'viewer');
    expect((await patch(creator.cookie, viewer.id, { role: 'owner' })).statusCode).toBe(400);
    expect((await patch(admin.cookie, admin.id, { role: 'owner' })).statusCode).toBe(400);
    expect((await patch(creator.cookie, viewer.id, { role: 'superuser' })).statusCode).toBe(400);
    expect((await me(viewer.cookie)).json().passkey.role).toBe('viewer');
  });

  it('the last admin can’t step down or revoke their own passkey', async () => {
    setup();
    const creator = await createGroup();
    insertMember(creator.groupId, 'collaborator');
    for (const res of [
      await patch(creator.cookie, creator.id, { role: 'collaborator' }),
      await revoke(creator.cookie, creator.id),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject(LAST_ADMIN);
    }
    expect((await me(creator.cookie)).json().passkey.role).toBe('admin');
  });

  it('two admins can’t demote each other down to none', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    expect((await patch(admin.cookie, creator.id, { role: 'viewer' })).statusCode).toBe(200);
    expect((await patch(admin.cookie, admin.id, { role: 'viewer' })).statusCode).toBe(409);
    expect((await revoke(admin.cookie, admin.id)).statusCode).toBe(409);
    expect((await me(admin.cookie)).json().passkey.role).toBe('admin');
  });

  it('a label and role change together are refused whole', async () => {
    setup();
    const creator = await createGroup();
    const res = await patch(creator.cookie, creator.id, { label: 'Fine', role: 'viewer' });
    expect(res.statusCode).toBe(409);
    expect((await me(creator.cookie)).json().passkey).toMatchObject({
      label: 'Phone',
      role: 'admin',
    });
  });

  it('another group’s passkey id is 404, and nothing changes', async () => {
    setup();
    const alice = await createGroup('Alice');
    const bob = await createGroup('Bob');
    const bobViewer = insertMember(bob.groupId, 'viewer', 'Bob laptop');

    expect((await patch(alice.cookie, bobViewer.id, { label: 'Mine' })).statusCode).toBe(404);
    expect((await patch(alice.cookie, bobViewer.id, { role: 'admin' })).statusCode).toBe(404);
    expect((await revoke(alice.cookie, bobViewer.id)).statusCode).toBe(404);
    expect((await revoke(alice.cookie, bob.id)).statusCode).toBe(404);
    expect((await me(bobViewer.cookie)).json().passkey).toMatchObject({
      label: 'Bob laptop',
      role: 'viewer',
    });
    expect((await me(bob.cookie)).statusCode).toBe(200);
  });
});

describe('audit log', () => {
  const entries = () =>
    db
      .prepare(
        'SELECT group_id, actor_passkey_id, action, target, detail_json, at FROM audit_log ORDER BY id',
      )
      .all()
      .map(({ detail_json, ...rest }) => ({ ...rest, detail: JSON.parse(detail_json) }));

  it('records role changes, renames, revocations and leaving', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    const viewer = insertMember(creator.groupId, 'viewer', 'Laptop');
    const other = insertMember(creator.groupId, 'viewer', 'Tablet');
    const at = clock.t;

    await patch(admin.cookie, viewer.id, { role: 'collaborator' });
    await patch(admin.cookie, viewer.id, { label: 'Work laptop' });
    await revoke(creator.cookie, other.id);
    await leave(viewer.cookie);

    const entry = (actor, action, target, detail) => ({
      group_id: creator.groupId,
      at,
      actor_passkey_id: actor,
      action,
      target,
      detail,
    });
    expect(entries()).toEqual([
      entry(admin.id, 'role-change', viewer.id, { from: 'viewer', to: 'collaborator' }),
      entry(admin.id, 'rename', viewer.id, { from: 'Laptop', to: 'Work laptop' }),
      entry(creator.id, 'revoke', other.id, { label: 'Tablet' }),
      entry(viewer.id, 'leave', viewer.id, { label: 'Work laptop' }),
    ]);
  });

  it('writes nothing for a refused change or a no-op', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    const viewer = insertMember(creator.groupId, 'viewer', 'Laptop');
    await patch(creator.cookie, viewer.id, { role: 'owner' });
    await patch(viewer.cookie, admin.id, { label: 'x' });
    db.prepare(`UPDATE passkeys SET role = 'viewer' WHERE id = ?`).run(admin.id);
    await leave(creator.cookie); // the last admin
    await patch(creator.cookie, viewer.id, { label: 'Laptop', role: 'viewer' });
    expect(entries()).toEqual([]);
  });
});
