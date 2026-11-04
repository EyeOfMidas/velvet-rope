// Finishing a join with a device key instead of a passkey: allowed by the `credentials` policy,
// the cookie is the key (400-day sliding life), and the scanner's chosen outcome applies as with
// a passkey. Under a keys-only policy the passkey path is closed. Everything goes through the real routes.
import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, openDb } from './harness.js';
import { addMember } from '../../src/testing/members.js';
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

const cookieFrom = (res, name) =>
  [res.headers['set-cookie']]
    .flat()
    .find((c) => c?.startsWith(`${name}=`))
    ?.split(';')[0];

const post = (url, cookie, payload = {}) =>
  app.inject({ method: 'POST', url: `/api${url}`, headers: { ...CSRF, cookie }, payload });
const me = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

async function createGroup() {
  const auth = createSoftAuthenticator({ origin: ORIGIN });
  const body = { groupName: 'Plans', label: 'Old phone' };
  const opts = (await app.inject({ method: 'POST', url: '/api/groups/options', headers: CSRF, payload: body })).json();
  const res = await app.inject({
    method: 'POST',
    url: '/api/groups',
    headers: CSRF,
    payload: { response: auth.register(opts) },
  });
  return { cookie: cookieFrom(res, 'velvet_rope_session'), memberId: res.json().member.id };
}

async function scanned(scanner, choice) {
  const made = await app.inject({
    method: 'POST',
    url: '/api/link-requests',
    headers: CSRF,
    payload: { label: 'Kiosk' },
  });
  const link = cookieFrom(made, 'velvet_rope_link');
  const res = await post('/link-requests/claim', scanner, { token: made.json().token, ...choice });
  expect(res.statusCode).toBe(200);
  return link;
}

describe('POST /link-requests/current/complete-key', () => {
  it('joins a new member with a key device whose cookie works for 400 days', async () => {
    setup(['passkey', 'key']);
    const admin = await createGroup();
    const link = await scanned(admin.cookie, { outcome: 'new-member' });

    const res = await post('/link-requests/current/complete-key', link);
    expect(res.statusCode).toBe(201);
    const session = cookieFrom(res, 'velvet_rope_session');
    expect(res.headers['set-cookie'].find((c) => c.startsWith('velvet_rope_session=')).split('; ')).toContain(
      `Max-Age=${400 * DAY_S}`,
    );

    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(res.json().device.id);
    expect(device).toMatchObject({ kind: 'key', user_handle: null, label: 'Kiosk' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM credentials WHERE device_id = ?').get(device.id).n).toBe(0);
    expect(count('members')).toBe(2);

    const signedIn = await me(session);
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().device.kind).toBe('key');
    expect(db.prepare('SELECT status FROM link_requests').get().status).toBe('completed');
  });

  it('signs out the scanner on a key transfer, as with a passkey', async () => {
    setup(['passkey', 'key']);
    const old = await createGroup();
    const link = await scanned(old.cookie, { outcome: 'own-device', signOut: 'scanner' });
    expect((await me(old.cookie)).statusCode).toBe(200);

    const res = await post('/link-requests/current/complete-key', link);
    expect(res.statusCode).toBe(201);
    expect(res.json().member.id).toBe(old.memberId);
    expect((await me(old.cookie)).statusCode).toBe(401);
    expect((await me(cookieFrom(res, 'velvet_rope_session'))).statusCode).toBe(200);
  });

  it('is refused under the default policy, creating nothing', async () => {
    setup(undefined);
    const admin = await createGroup();
    const link = await scanned(admin.cookie, { outcome: 'new-member' });

    const res = await post('/link-requests/current/complete-key', link);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('key_not_allowed');
    expect(res.json().message).toBeTruthy();
    expect(count('devices')).toBe(1);
    expect(count('members')).toBe(1);
    expect(db.prepare('SELECT status FROM link_requests').get().status).toBe('claimed');
  });

  it('is refused before the request is claimed', async () => {
    setup(['passkey', 'key']);
    const made = await app.inject({
      method: 'POST',
      url: '/api/link-requests',
      headers: CSRF,
      payload: { label: 'Kiosk' },
    });
    const res = await post('/link-requests/current/complete-key', cookieFrom(made, 'velvet_rope_link'));
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('link_incomplete');
    expect(count('devices')).toBe(0);
  });

  it('is refused with no request', async () => {
    setup(['key']);
    const res = await post('/link-requests/current/complete-key', 'x=1');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('link_not_found');
  });
});

describe('a keys-only policy', () => {
  it('refuses the passkey options and complete routes, but lets a key join', async () => {
    setup(['key']);
    db.prepare("INSERT INTO groups (id, name, created_at) VALUES ('g1', 'Plans', 0)").run();
    const admin = addMember(db, { groupId: 'g1', role: 'admin', now: Date.now() });
    const link = await scanned(`velvet_rope_session=${admin.token}`, { outcome: 'new-member' });

    for (const url of ['/link-requests/current/options', '/link-requests/current/complete']) {
      const res = await post(url, link);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('passkey_not_allowed');
      expect(res.json().message).toBeTruthy();
    }
    expect(count('devices')).toBe(1);

    expect((await post('/link-requests/current/complete-key', link)).statusCode).toBe(201);
    expect(count('devices')).toBe(2);
  });
});
