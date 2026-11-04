// Hooks run inside velvet-rope's transaction. A Refusal vetoes the change and is the reply; any
// other error rolls back too, but the client only gets a generic 500.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildApp, openDb } from './harness.js';
import { Refusal } from '../../src/server/index.js';
import { createInvite } from '../../src/server/invites.js';
import { addMember } from '../../src/testing/members.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const ORIGIN = 'http://localhost:5173';
const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };
const BODY = { groupName: 'Plans', label: 'Laptop' };

let app;
let db;
let clock;
afterEach(() => app?.close());

function setup(options = {}) {
  clock = { t: 1_700_000_000_000 };
  db = openDb(':memory:');
  app = buildApp({ db, now: () => clock.t, ...options });
}

const post = (url, payload, cookie = '') => app.inject({ method: 'POST', url, headers: { ...CSRF, cookie }, payload });
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

async function createGroup(invite) {
  const auth = createSoftAuthenticator({ origin: ORIGIN });
  const options = await post('/api/groups/options', { ...BODY, invite });
  return post('/api/groups', { response: auth.register(options.json()) });
}

describe('Refusal', () => {
  it('is exported from the server entry point with its status and code', () => {
    const refusal = new Refusal(409, 'name_taken', 'Taken');
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({ status: 409, code: 'name_taken', message: 'Taken' });
  });
});

describe('onGroupCreated', () => {
  it('is called inside the transaction with the new group', async () => {
    const onGroupCreated = vi.fn((db, group) => {
      expect(db.prepare('SELECT COUNT(*) AS n FROM groups WHERE id = ?').get(group.id).n).toBe(1);
    });
    setup({ hooks: { onGroupCreated } });
    expect((await createGroup()).statusCode).toBe(201);
    expect(onGroupCreated).toHaveBeenCalledOnce();
    expect(onGroupCreated.mock.calls[0][1]).toMatchObject({ name: 'Plans' });
  });

  it('vetoes: nothing is created, no cookie is set and the invite is not spent', async () => {
    const hooks = {
      onGroupCreated: () => {
        throw new Refusal(409, 'too_many_groups', 'You already have a group');
      },
    };
    setup({ groupCreation: 'invite', hooks });
    const code = createInvite(db, clock.t);

    const res = await createGroup(code);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'too_many_groups', message: 'You already have a group' });
    expect(res.headers['set-cookie']).toBeUndefined();
    for (const table of ['groups', 'members', 'devices', 'credentials', 'sessions', 'audit_log']) {
      expect(count(table), table).toBe(0);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM invites WHERE used_at IS NOT NULL').get().n).toBe(0);
  });

  it('uses the code as the message when the Refusal has none and the app has no wording for it', async () => {
    setup({
      hooks: {
        onGroupCreated: () => {
          throw new Refusal(403, 'too_many_groups');
        },
      },
    });
    const res = await createGroup();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'too_many_groups', message: 'too_many_groups' });
  });

  it('uses the library’s wording for a code it knows when the Refusal has no message', async () => {
    setup({
      hooks: {
        onGroupCreated: () => {
          throw new Refusal(403, 'forbidden');
        },
      },
    });
    expect((await createGroup()).json().message).toBe("You don't have permission to do that");
  });

  it('rolls back on a plain error and replies 500 without its text', async () => {
    const hooks = {
      onGroupCreated: () => {
        throw new Error('secret internal detail');
      },
    };
    setup({ groupCreation: 'invite', hooks });
    const code = createInvite(db, clock.t);

    const res = await createGroup(code);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'server_error', message: 'Something went wrong on our side' });
    expect(res.body).not.toContain('secret');
    expect(count('groups')).toBe(0);
    expect(count('members')).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM invites WHERE used_at IS NOT NULL').get().n).toBe(0);
  });

  it('refuses a hook that returns a promise, and rolls back', async () => {
    setup({ hooks: { onGroupCreated: async () => {} } });
    const res = await createGroup();
    expect(res.statusCode).toBe(500);
    expect(count('groups')).toBe(0);
  });
});

describe('onGroupDeleting', () => {
  async function groupWithAdmin(hooks) {
    setup({ hooks });
    const created = await createGroup();
    const cookie = created.headers['set-cookie'].split(';')[0];
    const { group } = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    return { cookie, groupId: group.id };
  }
  const del = (cookie) =>
    app.inject({ method: 'DELETE', url: '/api/group', headers: { ...CSRF, cookie }, payload: { name: 'Plans' } });

  it('runs before the cascade, with the group still in the database', async () => {
    const seen = [];
    const { cookie, groupId } = await groupWithAdmin({
      onGroupDeleting: (db, group) => {
        seen.push(group.id, db.prepare('SELECT COUNT(*) AS n FROM members WHERE group_id = ?').get(group.id).n);
      },
    });
    expect((await del(cookie)).statusCode).toBe(204);
    expect(seen).toEqual([groupId, 1]);
  });

  it('vetoes: the group and its members stay, and the reply is the Refusal', async () => {
    const { cookie, groupId } = await groupWithAdmin({
      onGroupDeleting: () => {
        throw new Refusal(409, 'group_in_use', 'Finish your open orders first');
      },
    });
    addMember(db, { groupId, role: 'viewer' });

    const res = await del(cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'group_in_use', message: 'Finish your open orders first' });
    expect(count('groups')).toBe(1);
    expect(count('members')).toBe(2);
    expect(res.headers['set-cookie']).toBeUndefined();
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
  });

  it('rolls back on a plain error and replies 500 without its text', async () => {
    const { cookie } = await groupWithAdmin({
      onGroupDeleting: () => {
        throw new Error('secret internal detail');
      },
    });
    const res = await del(cookie);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret');
    expect(count('groups')).toBe(1);
  });

  it('still runs onGroupDeleted when it is the only one given (deprecated alias)', async () => {
    const onGroupDeleted = vi.fn();
    const { cookie } = await groupWithAdmin({ onGroupDeleted });
    expect((await del(cookie)).statusCode).toBe(204);
    expect(onGroupDeleted).toHaveBeenCalledOnce();
  });

  it('prefers onGroupDeleting when both are given', async () => {
    const onGroupDeleted = vi.fn();
    const onGroupDeleting = vi.fn();
    const { cookie } = await groupWithAdmin({ onGroupDeleted, onGroupDeleting });
    expect((await del(cookie)).statusCode).toBe(204);
    expect(onGroupDeleting).toHaveBeenCalledOnce();
    expect(onGroupDeleted).not.toHaveBeenCalled();
  });
});
