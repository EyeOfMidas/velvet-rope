// Signing out: a device key is its session cookie, so signing out forgets the device.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildApp, openDb } from './harness.js';
import { Refusal } from '../../src/server/index.js';
import { addDevice, addMember } from '../../src/testing/members.js';

const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };
let app;
let db;
afterEach(() => app?.close());

function setup(kind, hooks = {}) {
  const t = 1_700_000_000_000;
  db = openDb(':memory:');
  app = buildApp({ db, now: () => t, hooks });
  db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run('g1', 'Plans', t);
  const first = addMember(db, { groupId: 'g1', role: 'viewer', label: 'Phone', now: t });
  const device =
    kind === 'key' ? addDevice(db, { memberId: first.memberId, kind: 'key', label: 'Key', now: t }) : first;
  return { memberId: first.memberId, deviceId: device.deviceId, cookie: `velvet_rope_session=${device.token}` };
}
const signOut = (cookie) =>
  app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { ...CSRF, cookie }, payload: {} });
const me = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
const revokedAt = (id) => db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(id).revoked_at;

describe('POST /api/auth/sign-out', () => {
  it('forgets a key device: revoked, cookie dead, member live, hook told', async () => {
    const onDeviceRevoked = vi.fn();
    const s = setup('key', { onDeviceRevoked });
    const res = await signOut(s.cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ forgotDevice: true });
    expect(revokedAt(s.deviceId)).not.toBeNull();
    expect((await me(s.cookie)).statusCode).toBe(401);
    expect(db.prepare('SELECT ended_at FROM members WHERE id = ?').get(s.memberId).ended_at).toBeNull();
    expect(onDeviceRevoked).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: 'signed-out' }));
  });

  it('a veto keeps the key device signed in', async () => {
    const s = setup('key', {
      onDeviceRevoked: () => {
        throw new Refusal(409, 'last_device', 'Keep it');
      },
    });
    const res = await signOut(s.cookie);
    expect(res.statusCode).toBe(409);
    expect(revokedAt(s.deviceId)).toBeNull();
    expect((await me(s.cookie)).statusCode).toBe(200);
  });

  it('signs a passkey device out with 204 and keeps the device', async () => {
    const s = setup('passkey');
    const res = await signOut(s.cookie);
    expect(res.statusCode).toBe(204);
    expect((await me(s.cookie)).statusCode).toBe(401);
    expect(revokedAt(s.deviceId)).toBeNull();
  });
});
