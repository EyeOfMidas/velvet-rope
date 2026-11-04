// What app code sees: request.session as { token, member, device, group } (plus the deprecated
// passkey alias), and the testing helpers that set up members and devices.
import { afterEach, describe, expect, it } from 'vitest';
import { addDevice, addMember } from '../../src/testing/members.js';
import { buildApp, openDb } from './harness.js';

const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };
const GROUP = 'g1';

let app;
let db;
afterEach(() => app?.close());

function setup() {
  db = openDb(':memory:');
  app = buildApp({ db });
  app.register(async (routes) => {
    routes.get('/api/whoami', { onRequest: app.requireSession }, async (request) => request.session);
    routes.get('/api/needs-manage', { onRequest: app.requireCapability('manageMembers') }, async () => ({ ok: true }));
  });
  db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(GROUP, 'Plans', 1);
}

const cookie = (token) => `velvet_rope_session=${token}`;
const get = (url, token) => app.inject({ method: 'GET', url, headers: { cookie: cookie(token) } });

describe('request.session', () => {
  it('is { token, member, device, group } with the deprecated passkey alias', async () => {
    setup();
    const { memberId, deviceId, token } = addMember(db, { groupId: GROUP, role: 'collaborator', label: 'Tablet' });
    const res = await get('/api/whoami', token);
    expect(res.json()).toEqual({
      token,
      member: { id: memberId, name: 'Tablet', role: 'collaborator' },
      device: { id: deviceId, label: 'Tablet', kind: 'passkey' },
      group: { id: GROUP, name: 'Plans' },
      passkey: { id: deviceId, label: 'Tablet', role: 'collaborator' },
    });
  });

  it('gets its capabilities from the member’s role, whichever device signed in', async () => {
    setup();
    const admin = addMember(db, { groupId: GROUP, role: 'admin' });
    const viewer = addMember(db, { groupId: GROUP, role: 'viewer' });
    const second = addDevice(db, { memberId: admin.memberId, kind: 'key' });
    expect((await get('/api/needs-manage', admin.token)).statusCode).toBe(200);
    expect((await get('/api/needs-manage', second.token)).statusCode).toBe(200);
    expect((await get('/api/needs-manage', viewer.token)).statusCode).toBe(403);
    expect((await get('/api/whoami', second.token)).json().device).toEqual({
      id: second.deviceId,
      label: 'key device',
      kind: 'key',
    });
  });
});

describe('testing helpers', () => {
  it('addDevice adds a device to the member: a passkey has a user handle, a key has none', () => {
    setup();
    const { memberId } = addMember(db, { groupId: GROUP, role: 'viewer' });
    const passkey = addDevice(db, { memberId });
    const key = addDevice(db, { memberId, kind: 'key' });
    const device = db.prepare('SELECT kind, user_handle, group_id, member_id FROM devices WHERE id = ?');
    expect(device.get(passkey.deviceId)).toMatchObject({ kind: 'passkey', group_id: GROUP, member_id: memberId });
    expect(device.get(passkey.deviceId).user_handle).toEqual(expect.any(String));
    expect(device.get(key.deviceId)).toMatchObject({ kind: 'key', user_handle: null });
    expect(db.prepare('SELECT COUNT(*) FROM members').pluck().get()).toBe(1);
  });
});

describe('removing a member with several devices', () => {
  it('signs out all of them', async () => {
    setup();
    const admin = addMember(db, { groupId: GROUP, role: 'admin' });
    const viewer = addMember(db, { groupId: GROUP, role: 'viewer' });
    const second = addDevice(db, { memberId: viewer.memberId });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/members/${viewer.memberId}`,
      headers: { ...CSRF, cookie: cookie(admin.token) },
      payload: {},
    });
    expect(res.statusCode).toBe(204);
    expect((await get('/api/me', viewer.token)).statusCode).toBe(401);
    expect((await get('/api/me', second.token)).statusCode).toBe(401);
    expect(db.prepare('SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL').pluck().get()).toBe(1);
    expect(db.prepare('SELECT ended_reason FROM members WHERE id = ?').pluck().get(viewer.memberId)).toBe('removed');
  });
});
