// Manage members: list (with their devices), rename, change role, remove, leave.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp, openDb } from './harness.js';
import { Refusal, createHub } from '../../src/server/index.js';
import { addDevice, addMember } from '../../src/testing/members.js';
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

function setup({ events, ...hooks } = {}) {
  clock = { t: 1_700_000_000_000 };
  db = openDb(':memory:');
  app = buildApp({ db, now: () => clock.t, config, events, hooks });
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
  const { member, group } = (await me(cookie)).json();
  return { id: member.id, cookie, groupId: group.id };
}

/** Adds a member with the given role straight into the group; returns { id, cookie }. */
function insertMember(groupId, role, label = `${role} device`) {
  clock.t += 1000; // distinct created_at, so ordering is deterministic
  const { memberId, deviceId, token } = addMember(db, { groupId, role, label, now: clock.t });
  return { id: memberId, deviceId, cookie: `velvet_rope_session=${token}` };
}

const list = (cookie) => app.inject({ method: 'GET', url: '/api/members', headers: cookie ? { cookie } : {} });
const patch = (cookie, id, payload) =>
  app.inject({
    method: 'PATCH',
    url: `/api/members/${id}`,
    headers: { ...CSRF, cookie },
    payload,
  });
const remove = (cookie, id) =>
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

  it('lists the group’s live members, oldest first, marking the current one', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer', 'Laptop');
    const admin = insertMember(creator.groupId, 'admin', 'Tablet');
    const gone = insertMember(creator.groupId, 'collaborator', 'Old phone');
    db.prepare('UPDATE members SET ended_at = ?, ended_reason = ? WHERE id = ?').run(clock.t, 'removed', gone.id);
    db.prepare('UPDATE devices SET last_used_at = ? WHERE member_id = ?').run(clock.t, viewer.id);

    const res = await list(admin.cookie);
    expect(res.statusCode).toBe(200);
    const items = res.json();
    expect(items.map((p) => p.name)).toEqual(['Phone', 'Laptop', 'Tablet']);
    expect(items[1]).toEqual({
      id: viewer.id,
      name: 'Laptop',
      role: 'viewer',
      created_at: expect.any(Number),
      current: false,
      devices: [{ id: viewer.deviceId, label: 'Laptop', kind: 'passkey', last_used_at: clock.t, current: false }],
    });
    expect(items.map((p) => p.current)).toEqual([false, false, true]);
    expect(items[0]).toMatchObject({ id: creator.id, role: 'admin' });
  });

  it('nests each member’s live devices and marks the session’s own device', async () => {
    setup();
    const creator = await createGroup();
    const second = addDevice(db, { memberId: creator.id, kind: 'key', label: 'Kitchen tablet', now: clock.t + 1 });
    const revoked = addDevice(db, { memberId: creator.id, label: 'Lost phone', now: clock.t + 2 });
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(clock.t, revoked.deviceId);

    const [self] = (await list(`velvet_rope_session=${second.token}`)).json();
    expect(self.devices.map((d) => [d.label, d.kind, d.current])).toEqual([
      ['Phone', 'passkey', false],
      ['Kitchen tablet', 'key', true],
    ]);
  });

  it('lists a member with no devices, with an empty devices list', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    db.prepare('UPDATE devices SET revoked_at = ? WHERE member_id = ?').run(clock.t, viewer.id);

    const items = (await list(creator.cookie)).json();
    expect(items.find((m) => m.id === viewer.id)).toMatchObject({ role: 'viewer', devices: [] });
  });

  it('never lists another group’s members', async () => {
    setup();
    const alice = await createGroup('Alice');
    const bob = await createGroup('Bob');
    insertMember(bob.groupId, 'viewer', 'Bob laptop');
    expect((await list(alice.cookie)).json().map((p) => p.name)).toEqual(['Phone']);
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
      name: 'Laptop',
      role: 'collaborator',
      created_at: expect.any(Number),
      current: false,
      devices: [expect.objectContaining({ label: 'Laptop' })],
    });
    expect((await me(viewer.cookie)).json().member.role).toBe('collaborator');
  });

  it('renames a member, trimming the name', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const res = await patch(creator.cookie, viewer.id, { name: '  Sam  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Sam');
  });

  it('still accepts the deprecated label field as the name', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const res = await patch(creator.cookie, viewer.id, { label: 'Work laptop' });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Work laptop');
  });

  it('lets anyone rename themselves, but not change their role or rename someone else', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    expect((await patch(viewer.cookie, viewer.id, { name: 'Sam' })).statusCode).toBe(200);
    expect((await patch(viewer.cookie, creator.id, { name: 'Boss' })).statusCode).toBe(403);
    expect((await patch(viewer.cookie, viewer.id, { role: 'admin' })).statusCode).toBe(403);
  });

  it('lets the last admin rename their own member', async () => {
    setup();
    const creator = await createGroup();
    const res = await patch(creator.cookie, creator.id, { name: 'Pixel' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Pixel', role: 'admin', current: true });
  });

  it('rejects a blank or over-long name', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    expect((await patch(creator.cookie, viewer.id, { name: '  ' })).statusCode).toBe(400);
    expect((await patch(creator.cookie, viewer.id, { name: 'x'.repeat(61) })).statusCode).toBe(400);
    expect((await patch(creator.cookie, viewer.id, { name: 7 })).statusCode).toBe(400);
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
    expect((await patch('velvet_rope_session=nope', viewer.id, { name: 'x' })).statusCode).toBe(401);
    const noCsrf = await app.inject({
      method: 'PATCH',
      url: `/api/members/${viewer.id}`,
      headers: { 'content-type': 'application/json', cookie: creator.cookie },
      payload: { name: 'x' },
    });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('404s for an unknown member', async () => {
    setup();
    const creator = await createGroup();
    expect((await patch(creator.cookie, randomUUID(), { name: 'x' })).statusCode).toBe(404);
  });
});

describe('DELETE /api/members/:id', () => {
  it('removes a member: its sessions end at once and it leaves the list', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const res = await remove(creator.cookie, viewer.id);
    expect(res.statusCode).toBe(204);
    expect((await me(viewer.cookie)).statusCode).toBe(401);
    expect(
      db
        .prepare('SELECT COUNT(*) AS n FROM sessions s JOIN devices d ON d.id = s.device_id WHERE d.member_id = ?')
        .get(viewer.id).n,
    ).toBe(0);
    expect(db.prepare('SELECT revoked_at FROM devices WHERE member_id = ?').get(viewer.id).revoked_at).toBe(clock.t);
    expect((await list(creator.cookie)).json().map((p) => p.id)).toEqual([creator.id]);
  });

  it('lets an admin revoke their own member', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    expect((await remove(admin.cookie, admin.id)).statusCode).toBe(204);
    expect((await me(admin.cookie)).statusCode).toBe(401);
  });

  it('404s for an already removed member', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    await remove(creator.cookie, viewer.id);
    expect((await remove(creator.cookie, viewer.id)).statusCode).toBe(404);
    expect((await patch(creator.cookie, viewer.id, { name: 'x' })).statusCode).toBe(404);
  });
});

describe('POST /api/members/leave', () => {
  it('lets a viewer leave: member ended, cookie cleared', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const res = await leave(viewer.cookie);
    expect(res.statusCode).toBe(204);
    const cleared = [res.headers['set-cookie']].flat().find((c) => c?.startsWith('velvet_rope_session='));
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
        await patch(actor.cookie, viewer.id, { name: 'Hijacked' }),
        await patch(actor.cookie, viewer.id, { role: 'admin' }),
        await patch(actor.cookie, actor.id, { role: 'admin' }),
        await remove(actor.cookie, viewer.id),
      ]) {
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject(NO_PERMISSION);
      }
      const row = db.prepare('SELECT name, role, ended_at FROM members WHERE id = ?');
      expect(row.get(viewer.id)).toEqual({ name: 'Laptop', role: 'viewer', ended_at: null });
      expect(row.get(actor.id).role).toBe(role);
    });
  }

  it('admins are equal: an admin can rename, demote and revoke the group’s creator', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    expect((await patch(admin.cookie, creator.id, { name: 'Old phone' })).statusCode).toBe(200);
    expect((await patch(admin.cookie, creator.id, { role: 'viewer' })).statusCode).toBe(200);
    expect((await me(creator.cookie)).json().member).toMatchObject({
      name: 'Old phone',
      role: 'viewer',
    });
    expect((await remove(admin.cookie, creator.id)).statusCode).toBe(204);
    expect((await me(creator.cookie)).statusCode).toBe(401);
  });

  it('nobody can make a member owner', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    const viewer = insertMember(creator.groupId, 'viewer');
    expect((await patch(creator.cookie, viewer.id, { role: 'owner' })).statusCode).toBe(400);
    expect((await patch(admin.cookie, admin.id, { role: 'owner' })).statusCode).toBe(400);
    expect((await patch(creator.cookie, viewer.id, { role: 'superuser' })).statusCode).toBe(400);
    expect((await me(viewer.cookie)).json().member.role).toBe('viewer');
  });

  it('the last admin can’t step down or revoke their own member', async () => {
    setup();
    const creator = await createGroup();
    insertMember(creator.groupId, 'collaborator');
    for (const res of [
      await patch(creator.cookie, creator.id, { role: 'collaborator' }),
      await remove(creator.cookie, creator.id),
    ]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject(LAST_ADMIN);
    }
    expect((await me(creator.cookie)).json().member.role).toBe('admin');
  });

  it('two admins can’t demote each other down to none', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    expect((await patch(admin.cookie, creator.id, { role: 'viewer' })).statusCode).toBe(200);
    expect((await patch(admin.cookie, admin.id, { role: 'viewer' })).statusCode).toBe(409);
    expect((await remove(admin.cookie, admin.id)).statusCode).toBe(409);
    expect((await me(admin.cookie)).json().member.role).toBe('admin');
  });

  it('a label and role change together are refused whole', async () => {
    setup();
    const creator = await createGroup();
    const res = await patch(creator.cookie, creator.id, { name: 'Fine', role: 'viewer' });
    expect(res.statusCode).toBe(409);
    expect((await me(creator.cookie)).json().member).toMatchObject({
      name: 'Phone',
      role: 'admin',
    });
  });

  it('another group’s member id is 404, and nothing changes', async () => {
    setup();
    const alice = await createGroup('Alice');
    const bob = await createGroup('Bob');
    const bobViewer = insertMember(bob.groupId, 'viewer', 'Bob laptop');

    expect((await patch(alice.cookie, bobViewer.id, { name: 'Mine' })).statusCode).toBe(404);
    expect((await patch(alice.cookie, bobViewer.id, { role: 'admin' })).statusCode).toBe(404);
    expect((await remove(alice.cookie, bobViewer.id)).statusCode).toBe(404);
    expect((await remove(alice.cookie, bob.id)).statusCode).toBe(404);
    expect((await me(bobViewer.cookie)).json().member).toMatchObject({
      name: 'Bob laptop',
      role: 'viewer',
    });
    expect((await me(bob.cookie)).statusCode).toBe(200);
  });
});

describe('audit log', () => {
  const entries = () =>
    db
      .prepare('SELECT group_id, actor_member_id, action, target, detail_json, at FROM audit_log ORDER BY id')
      .all()
      .map(({ detail_json, ...rest }) => ({ ...rest, detail: JSON.parse(detail_json) }));

  it('records role changes, renames, removals and leaving', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    const viewer = insertMember(creator.groupId, 'viewer', 'Laptop');
    const other = insertMember(creator.groupId, 'viewer', 'Tablet');
    const at = clock.t;

    await patch(admin.cookie, viewer.id, { role: 'collaborator' });
    await patch(admin.cookie, viewer.id, { name: 'Work laptop' });
    await remove(creator.cookie, other.id);
    await leave(viewer.cookie);

    const entry = (actor, action, target, detail) => ({
      group_id: creator.groupId,
      at,
      actor_member_id: actor,
      action,
      target,
      detail,
    });
    expect(entries()).toEqual([
      entry(admin.id, 'role-change', viewer.id, { from: 'viewer', to: 'collaborator' }),
      entry(admin.id, 'rename', viewer.id, { from: 'Laptop', to: 'Work laptop' }),
      entry(creator.id, 'remove', other.id, { label: 'Tablet' }),
      entry(viewer.id, 'leave', viewer.id, { label: 'Work laptop' }),
    ]);
  });

  it('writes nothing for a refused change or a no-op', async () => {
    setup();
    const creator = await createGroup();
    const admin = insertMember(creator.groupId, 'admin');
    const viewer = insertMember(creator.groupId, 'viewer', 'Laptop');
    await patch(creator.cookie, viewer.id, { role: 'owner' });
    await patch(viewer.cookie, admin.id, { name: 'x' });
    db.prepare(`UPDATE members SET role = 'viewer' WHERE id = ?`).run(admin.id);
    await leave(creator.cookie); // the last admin
    await patch(creator.cookie, viewer.id, { name: 'Laptop', role: 'viewer' });
    expect(entries()).toEqual([]);
  });
});

const liveDevices = (memberId) =>
  db.prepare('SELECT COUNT(*) FROM devices WHERE member_id = ? AND revoked_at IS NULL').pluck().get(memberId);

describe('members with several devices', () => {
  it('removing a member revokes every device and ends every session', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const second = addDevice(db, { memberId: viewer.id, kind: 'key', now: clock.t });

    expect((await remove(creator.cookie, viewer.id)).statusCode).toBe(204);
    expect(liveDevices(viewer.id)).toBe(0);
    expect((await me(viewer.cookie)).statusCode).toBe(401);
    expect((await me(`velvet_rope_session=${second.token}`)).statusCode).toBe(401);
    expect(db.prepare('SELECT ended_reason FROM members WHERE id = ?').get(viewer.id).ended_reason).toBe('removed');
  });

  it('counts the last admin by member: an admin with two devices still can’t leave', async () => {
    setup();
    const creator = await createGroup();
    addDevice(db, { memberId: creator.id, kind: 'key', now: clock.t });
    insertMember(creator.groupId, 'viewer');

    const res = await leave(creator.cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject(LAST_ADMIN);
  });
});

describe('onMemberEnded hook', () => {
  it('hears about a removal, before the devices are revoked', async () => {
    const calls = [];
    setup({
      onMemberEnded: (_db, info) => calls.push({ ...info, liveDevices: liveDevices(info.member.id) }),
    });
    const creator = await createGroup('Plans');
    const viewer = insertMember(creator.groupId, 'viewer', 'Laptop');

    await remove(creator.cookie, viewer.id);
    expect(calls).toEqual([
      {
        group: { id: creator.groupId, name: 'Plans' },
        member: { id: viewer.id, name: 'Laptop', role: 'viewer' },
        reason: 'removed',
        actorId: creator.id,
        liveDevices: 1,
      },
    ]);
  });

  it('hears about leaving, with the leaver as the actor', async () => {
    const onMemberEnded = vi.fn();
    setup({ onMemberEnded });
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');

    await leave(viewer.cookie);
    expect(onMemberEnded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reason: 'leave',
        actorId: viewer.id,
        member: expect.objectContaining({ id: viewer.id }),
      }),
    );
  });

  it('a veto leaves the member and all their devices live, and sends no events', async () => {
    const events = createHub();
    const published = [];
    const publish = events.publish;
    events.publish = (...args) => (published.push(args[1]), publish(...args));
    setup({
      events,
      onMemberEnded: () => {
        throw new Refusal(409, 'has_open_orders', 'Finish their open orders first');
      },
    });
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    addDevice(db, { memberId: viewer.id, kind: 'key', now: clock.t });

    for (const res of [await remove(creator.cookie, viewer.id), await leave(viewer.cookie)]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'has_open_orders', message: 'Finish their open orders first' });
    }
    expect((await me(viewer.cookie)).statusCode).toBe(200);
    expect(liveDevices(viewer.id)).toBe(2);
    expect(db.prepare('SELECT ended_at FROM members WHERE id = ?').get(viewer.id).ended_at).toBeNull();
    expect(db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(0);
    expect(published).toEqual([]);
  });
});
