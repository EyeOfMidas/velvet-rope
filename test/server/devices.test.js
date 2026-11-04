// Manage devices: rename and revoke. A member always manages their own devices; someone else's
// need manageMembers. Revoking a device never ends its member.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp, openDb } from './harness.js';
import { Refusal } from '../../src/server/index.js';
import { addDevice, addMember } from '../../src/testing/members.js';

const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };

let app;
let db;
let clock;
afterEach(() => app?.close());

function setup(hooks = {}) {
  clock = { t: 1_700_000_000_000 };
  db = openDb(':memory:');
  app = buildApp({ db, now: () => clock.t, hooks });
}

let nextGroup = 0;
/** A group with a member of each given role, each signed in on one device. */
function scene(...roles) {
  const groupId = `group-${nextGroup++}`;
  db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(groupId, 'Plans', clock.t);
  return roles.map((role) => {
    clock.t += 1000;
    const { memberId, deviceId, token } = addMember(db, { groupId, role, label: `${role} phone`, now: clock.t });
    return { id: memberId, deviceId, groupId, cookie: `velvet_rope_session=${token}` };
  });
}

const me = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
const list = (cookie) => app.inject({ method: 'GET', url: '/api/members', headers: { cookie } });
const rename = (cookie, id, label) =>
  app.inject({ method: 'PATCH', url: `/api/devices/${id}`, headers: { ...CSRF, cookie }, payload: { label } });
const revoke = (cookie, id) =>
  app.inject({ method: 'DELETE', url: `/api/devices/${id}`, headers: { ...CSRF, cookie }, payload: {} });

const isRevoked = (deviceId) =>
  db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(deviceId).revoked_at !== null;

describe('PATCH /api/devices/:id', () => {
  it('renames your own device, trimming the label', async () => {
    setup();
    const [viewer] = scene('viewer');
    const res = await rename(viewer.cookie, viewer.deviceId, '  Work laptop  ');
    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT label FROM devices WHERE id = ?').get(viewer.deviceId).label).toBe('Work laptop');
    const [self] = (await list(viewer.cookie)).json();
    expect(self.devices[0]).toMatchObject({ id: viewer.deviceId, label: 'Work laptop' });
  });

  it('lets someone with manageMembers rename another member’s device, but not a viewer', async () => {
    setup();
    const [admin, viewer, other] = scene('admin', 'viewer', 'viewer');
    expect((await rename(viewer.cookie, other.deviceId, 'Hijacked')).statusCode).toBe(403);
    expect((await rename(admin.cookie, viewer.deviceId, 'Kids tablet')).statusCode).toBe(200);
    expect(db.prepare('SELECT label FROM devices WHERE id = ?').get(viewer.deviceId).label).toBe('Kids tablet');
    expect(db.prepare('SELECT label FROM devices WHERE id = ?').get(other.deviceId).label).toBe('viewer phone');
  });

  it('rejects a blank label', async () => {
    setup();
    const [viewer] = scene('viewer');
    expect((await rename(viewer.cookie, viewer.deviceId, '  ')).statusCode).toBe(400);
    expect((await rename(viewer.cookie, viewer.deviceId, 7)).statusCode).toBe(400);
  });

  it('404s for an unknown device or another group’s device', async () => {
    setup();
    const [alice] = scene('admin');
    const [bob] = scene('admin');
    expect((await rename(alice.cookie, randomUUID(), 'x')).statusCode).toBe(404);
    const res = await rename(alice.cookie, bob.deviceId, 'x');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'device_not_found' });
    expect(db.prepare('SELECT label FROM devices WHERE id = ?').get(bob.deviceId).label).toBe('admin phone');
  });

  it('needs a session', async () => {
    setup();
    const [viewer] = scene('viewer');
    expect((await rename('velvet_rope_session=nope', viewer.deviceId, 'x')).statusCode).toBe(401);
  });

  it('is audited as rename-device', async () => {
    setup();
    const [viewer] = scene('viewer');
    await rename(viewer.cookie, viewer.deviceId, 'Laptop');
    const entry = db.prepare('SELECT action, target, actor_member_id, detail_json FROM audit_log').get();
    expect(entry).toMatchObject({ action: 'rename-device', target: viewer.deviceId, actor_member_id: viewer.id });
    expect(JSON.parse(entry.detail_json)).toEqual({ from: 'viewer phone', to: 'Laptop' });
  });
});

describe('DELETE /api/devices/:id', () => {
  it('revokes one of your own devices and ends its sessions; the member and other devices stay', async () => {
    setup();
    const [viewer] = scene('viewer');
    const second = addDevice(db, { memberId: viewer.id, kind: 'key', label: 'Tablet', now: clock.t });

    const res = await revoke(viewer.cookie, second.deviceId);
    expect(res.statusCode).toBe(204);
    expect(isRevoked(second.deviceId)).toBe(true);
    expect((await me(`velvet_rope_session=${second.token}`)).statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await me(viewer.cookie)).statusCode).toBe(200);
    expect((await list(viewer.cookie)).json()[0].devices.map((d) => d.id)).toEqual([viewer.deviceId]);
  });

  it('revoking the device you are on clears your cookie; the member still exists with no devices', async () => {
    setup();
    const [admin, viewer] = scene('admin', 'viewer');

    const res = await revoke(viewer.cookie, viewer.deviceId);
    expect(res.statusCode).toBe(204);
    expect([res.headers['set-cookie']].flat().find((c) => c?.startsWith('velvet_rope_session='))).toMatch(
      /^velvet_rope_session=; .*Max-Age=0/,
    );
    expect((await me(viewer.cookie)).statusCode).toBe(401);
    const listed = (await list(admin.cookie)).json().find((m) => m.id === viewer.id);
    expect(listed).toMatchObject({ name: 'viewer phone', role: 'viewer', devices: [] });
  });

  it('lets an admin revoke someone else’s device, but not a viewer', async () => {
    setup();
    const [admin, viewer, other] = scene('admin', 'viewer', 'viewer');
    expect((await revoke(viewer.cookie, other.deviceId)).statusCode).toBe(403);
    expect(isRevoked(other.deviceId)).toBe(false);
    expect((await revoke(admin.cookie, other.deviceId)).statusCode).toBe(204);
    expect(isRevoked(other.deviceId)).toBe(true);
    expect((await me(other.cookie)).statusCode).toBe(401);
    expect((await me(admin.cookie)).statusCode).toBe(200);
  });

  it('404s for another group’s device, and for one already revoked', async () => {
    setup();
    const [alice] = scene('admin');
    const [bob] = scene('admin');
    expect((await revoke(alice.cookie, bob.deviceId)).statusCode).toBe(404);
    expect((await me(bob.cookie)).statusCode).toBe(200);
    const second = addDevice(db, { memberId: alice.id, now: clock.t });
    await revoke(alice.cookie, second.deviceId);
    expect((await revoke(alice.cookie, second.deviceId)).statusCode).toBe(404);
  });

  it('counts the last admin by member: an admin who revokes one of two devices is still the admin', async () => {
    setup();
    const [admin, viewer] = scene('admin', 'viewer');
    const second = addDevice(db, { memberId: admin.id, now: clock.t });

    expect((await revoke(admin.cookie, second.deviceId)).statusCode).toBe(204);
    expect((await me(admin.cookie)).json().member).toMatchObject({ id: admin.id, role: 'admin' });
    // Even the admin's last device can go: the member stays, so the group still has its admin.
    expect((await revoke(admin.cookie, admin.deviceId)).statusCode).toBe(204);
    expect((await list(viewer.cookie)).json().map((m) => [m.id, m.role])).toEqual([
      [admin.id, 'admin'],
      [viewer.id, 'viewer'],
    ]);
  });

  it('is audited as revoke-device', async () => {
    setup();
    const [viewer] = scene('viewer');
    const second = addDevice(db, { memberId: viewer.id, label: 'Tablet', now: clock.t });
    await revoke(viewer.cookie, second.deviceId);
    const entry = db.prepare('SELECT action, target, actor_member_id, detail_json FROM audit_log').get();
    expect(entry).toMatchObject({ action: 'revoke-device', target: second.deviceId, actor_member_id: viewer.id });
    expect(JSON.parse(entry.detail_json)).toEqual({ label: 'Tablet', memberId: viewer.id });
  });
});

describe('onDeviceRevoked hook', () => {
  it('hears about the revoked device and its member, with reason revoked', async () => {
    const onDeviceRevoked = vi.fn();
    setup({ onDeviceRevoked });
    const [viewer] = scene('viewer');
    const second = addDevice(db, { memberId: viewer.id, kind: 'key', label: 'Tablet', now: clock.t });

    await revoke(viewer.cookie, second.deviceId);
    expect(onDeviceRevoked).toHaveBeenCalledTimes(1);
    expect(onDeviceRevoked).toHaveBeenCalledWith(expect.anything(), {
      group: { id: viewer.groupId, name: 'Plans' },
      member: { id: viewer.id, name: 'viewer phone', role: 'viewer' },
      device: { id: second.deviceId, label: 'Tablet', kind: 'key' },
      reason: 'revoked',
    });
  });

  it('a veto leaves the device live, its session working and the reply the Refusal', async () => {
    setup({
      onDeviceRevoked: () => {
        throw new Refusal(409, 'last_device', 'Keep at least one device');
      },
    });
    const [viewer] = scene('viewer');
    const res = await revoke(viewer.cookie, viewer.deviceId);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'last_device', message: 'Keep at least one device' });
    expect(isRevoked(viewer.deviceId)).toBe(false);
    expect((await me(viewer.cookie)).statusCode).toBe(200);
    expect(db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(0);
  });

  it('is not called for each device when a whole member is removed', async () => {
    const onDeviceRevoked = vi.fn();
    setup({ onDeviceRevoked });
    const [admin, viewer] = scene('admin', 'viewer');
    addDevice(db, { memberId: viewer.id, now: clock.t });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/members/${viewer.id}`,
      headers: { ...CSRF, cookie: admin.cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(204);
    expect(onDeviceRevoked).not.toHaveBeenCalled();
  });
});
