// Upgrading a device-key device to a passkey in place: the device keeps its id, label and member,
// gains a credential, and from then on signs in with /auth. The session stays. Everything goes
// through the real routes and the soft authenticator.
import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, openDb } from './harness.js';
import { addDevice } from '../../src/testing/members.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const ORIGIN = 'http://localhost:5173';
const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };
const DAY_S = 24 * 60 * 60;

let app;
let db;
afterEach(() => app?.close());

function setup(credentials) {
  db = openDb(':memory:');
  app = buildApp({ db, credentials });
}

const setCookie = (res, name) => [res.headers['set-cookie']].flat().find((c) => c?.startsWith(`${name}=`));
const post = (url, cookie, payload = {}) =>
  app.inject({ method: 'POST', url: `/api${url}`, headers: { ...CSRF, ...(cookie ? { cookie } : {}) }, payload });
const me = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

async function createGroup() {
  const auth = createSoftAuthenticator({ origin: ORIGIN });
  const body = { groupName: 'Plans', label: 'Old phone' };
  const opts = (await post('/groups/options', null, body)).json();
  const res = await post('/groups', null, { response: auth.register(opts) });
  const cookie = setCookie(res, 'velvet_rope_session').split(';')[0];
  return { cookie, memberId: res.json().member.id };
}

/** A group with a key device (its cookie is the key) next to the first member's passkey device. */
async function withKeyDevice() {
  const group = await createGroup();
  const key = addDevice(db, { memberId: group.memberId, kind: 'key', label: 'Kiosk' });
  return { ...group, key, keyCookie: `velvet_rope_session=${key.token}` };
}

describe('upgrading a key device to a passkey', () => {
  it('registers a passkey on the same device, keeps the session, and signs in to that device after', async () => {
    setup(['passkey', 'key']);
    const { keyCookie, key } = await withKeyDevice();
    const phone = createSoftAuthenticator({ origin: ORIGIN });

    const options = await post('/devices/current/passkey/options', keyCookie);
    expect(options.statusCode).toBe(200);
    expect(options.json().user.name).toBe('Kiosk');

    const done = await post('/devices/current/passkey', keyCookie, { response: phone.register(options.json()) });
    expect(done.statusCode).toBe(200);
    expect(done.json().device).toEqual({ id: key.deviceId, label: 'Kiosk', kind: 'passkey' });
    expect(setCookie(done, 'velvet_rope_session')).toContain(`Max-Age=${30 * DAY_S}`);

    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(key.deviceId);
    expect(device).toMatchObject({ kind: 'passkey', label: 'Kiosk' });
    expect(device.user_handle).toEqual(expect.any(String));
    expect(db.prepare('SELECT COUNT(*) AS n FROM credentials WHERE device_id = ?').get(key.deviceId).n).toBe(1);

    const session = await me(keyCookie);
    expect(session.statusCode).toBe(200);
    expect(session.json().device).toEqual({ id: key.deviceId, label: 'Kiosk', kind: 'passkey' });

    const authOptions = (await post('/auth/options', null)).json();
    const signedIn = await post('/auth', null, { response: phone.authenticate(authOptions) });
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().device.id).toBe(key.deviceId);
  });

  it('refuses a device that is already a passkey', async () => {
    setup(['passkey', 'key']);
    const { cookie } = await createGroup();
    const res = await post('/devices/current/passkey/options', cookie);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_passkey');
  });

  it('refuses under a keys-only policy', async () => {
    setup(['key']);
    const made = await post('/groups/key', null, { groupName: 'Plans', label: 'Kiosk' });
    expect(made.statusCode).toBe(201);
    const cookie = setCookie(made, 'velvet_rope_session').split(';')[0];
    const res = await post('/devices/current/passkey/options', cookie);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('passkey_not_allowed');
  });

  it('refuses a challenge that came from another device', async () => {
    setup(['passkey', 'key']);
    const { keyCookie, key, memberId } = await withKeyDevice();
    const other = addDevice(db, { memberId, kind: 'key', label: 'Tablet' });
    const phone = createSoftAuthenticator({ origin: ORIGIN });

    const options = (await post('/devices/current/passkey/options', `velvet_rope_session=${other.token}`)).json();
    const res = await post('/devices/current/passkey', keyCookie, { response: phone.register(options) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_challenge');
    expect(db.prepare('SELECT kind FROM devices WHERE id = ?').pluck().get(key.deviceId)).toBe('key');
  });

  it('needs a session', async () => {
    setup(['passkey', 'key']);
    expect((await post('/devices/current/passkey/options', null)).statusCode).toBe(401);
    expect((await post('/devices/current/passkey', null, {})).statusCode).toBe(401);
  });
});
