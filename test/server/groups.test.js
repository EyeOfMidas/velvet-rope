import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp, openDb } from './harness.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const ORIGIN = 'http://localhost:5173';
const config = { rpId: 'localhost', rpName: 'Test app', origin: ORIGIN };
const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

let app;
let db;
let clock;
afterEach(() => app?.close());

function setup() {
  clock = { t: 1_700_000_000_000 };
  db = openDb(':memory:');
  app = buildApp({ db, now: () => clock.t, config });
  return createSoftAuthenticator({ origin: ORIGIN });
}

function requestOptions(body = { groupName: 'Plans', label: 'Firefox on Windows' }) {
  return app.inject({ method: 'POST', url: '/api/groups/options', headers: CSRF, payload: body });
}

function submit(response, headers = CSRF) {
  return app.inject({ method: 'POST', url: '/api/groups', headers, payload: { response } });
}

async function createGroup(auth, body) {
  const options = (await requestOptions(body)).json();
  return submit(auth.register(options));
}

function sessionCookie(res) {
  const header = [res.headers['set-cookie']].flat().find((c) => c.startsWith('velvet_rope_session='));
  return header?.split(';')[0];
}

function me(cookie) {
  return app.inject({ method: 'GET', url: '/api/me', headers: cookie ? { cookie } : {} });
}

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

describe('POST /api/groups/options', () => {
  it('returns discoverable-credential registration options named "<group> · <label>"', async () => {
    setup();
    const res = await requestOptions();
    expect(res.statusCode).toBe(200);
    const options = res.json();
    expect(options.rp).toEqual({ id: 'localhost', name: 'Test app' });
    expect(options.user.name).toBe('Plans · Firefox on Windows');
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'preferred',
    });
    expect(options.attestation).toBe('none');
    expect(options.challenge).toEqual(expect.any(String));
  });

  it('gives every request a fresh user handle', async () => {
    setup();
    const a = (await requestOptions()).json();
    const b = (await requestOptions()).json();
    expect(a.user.id).not.toBe(b.user.id);
  });

  it('rejects a blank group name or label', async () => {
    setup();
    expect((await requestOptions({ groupName: '  ', label: 'x' })).statusCode).toBe(400);
    expect((await requestOptions({ groupName: 'Plans', label: '' })).statusCode).toBe(400);
  });
});

describe('POST /api/groups', () => {
  it('creates the group, an admin passkey, its credential and a session', async () => {
    const auth = setup();
    const res = await createGroup(auth);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      passkey: { id: expect.any(String), label: 'Firefox on Windows', role: 'admin' },
      group: { id: expect.any(String), name: 'Plans' },
    });
    expect([count('groups'), count('passkeys'), count('credentials'), count('sessions')]).toEqual([1, 1, 1, 1]);
    const passkey = db.prepare('SELECT * FROM passkeys').get();
    expect(passkey.user_handle).toBe(auth.credentials[0].userHandle);
    const credential = db.prepare('SELECT * FROM credentials').get();
    expect(credential).toMatchObject({
      credential_id: auth.credentials[0].id,
      passkey_id: passkey.id,
    });
  });

  it('sets an HttpOnly, Secure, SameSite=Strict session cookie for the whole site', async () => {
    const auth = setup();
    const res = await createGroup(auth);
    const header = [res.headers['set-cookie']].flat().find((c) => c.startsWith('velvet_rope_session='));
    expect(header).toMatch(/; HttpOnly/i);
    expect(header).toMatch(/; Secure/i);
    expect(header).toMatch(/; SameSite=Strict/i);
    expect(header).toMatch(/; Path=\//i);
    expect(header).toMatch(/; Max-Age=2592000/i);
    const value = sessionCookie(res).split('=')[1];
    expect(Buffer.from(value, 'base64url')).toHaveLength(32);
  });

  it('stores the session only as a SHA-256 hash of the cookie value', async () => {
    const auth = setup();
    const value = sessionCookie(await createGroup(auth)).split('=')[1];
    const row = db.prepare('SELECT * FROM sessions').get();
    expect(row.id_hash).toBe(createHash('sha256').update(value).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(value);
  });

  it('never reuses a user handle across passkeys', async () => {
    setup();
    await createGroup(createSoftAuthenticator({ origin: ORIGIN }));
    await createGroup(createSoftAuthenticator({ origin: ORIGIN }));
    const handles = db.prepare('SELECT user_handle FROM passkeys').all();
    expect(handles).toHaveLength(2);
    expect(handles[0].user_handle).not.toBe(handles[1].user_handle);
  });
});

describe('POST /api/groups rejects', () => {
  it('a replayed response: the challenge is single-use', async () => {
    const auth = setup();
    const response = auth.register((await requestOptions()).json());
    expect((await submit(response)).statusCode).toBe(201);
    const replay = await submit(response);
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: 'bad_challenge' });
    expect(count('groups')).toBe(1);
  });

  it('a challenge the server never issued', async () => {
    const auth = setup();
    const options = (await requestOptions()).json();
    const res = await submit(auth.register({ ...options, challenge: 'bm90LWlzc3VlZA' }));
    expect(res.statusCode).toBe(400);
    expect(count('groups')).toBe(0);
  });

  it('a challenge older than five minutes', async () => {
    const auth = setup();
    const options = (await requestOptions()).json();
    clock.t += 5 * MINUTE;
    const res = await submit(auth.register(options));
    expect(res.statusCode).toBe(400);
    expect(count('groups')).toBe(0);
  });

  it('a response created on another origin', async () => {
    const auth = setup();
    const options = (await requestOptions()).json();
    const res = await submit(auth.register(options, { origin: 'http://localhost:5174' }));
    expect(res.statusCode).toBe(400);
    expect(count('groups')).toBe(0);
  });

  it('a request without the CSRF header or JSON content type', async () => {
    const auth = setup();
    const response = auth.register((await requestOptions()).json());
    const noHeader = await submit(response, { 'content-type': 'application/json' });
    expect(noHeader.statusCode).toBe(403);
    const plainText = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { 'content-type': 'text/plain', 'x-velvet-rope': '1' },
      payload: JSON.stringify({ response }),
    });
    expect(plainText.statusCode).toBe(403);
    const optionsNoHeader = await app.inject({
      method: 'POST',
      url: '/api/groups/options',
      headers: { 'content-type': 'application/json' },
      payload: { groupName: 'Plans', label: 'x' },
    });
    expect(optionsNoHeader.statusCode).toBe(403);
    expect(count('groups')).toBe(0);
  });
});

describe('GET /api/me', () => {
  it('names the signed-in passkey and its group', async () => {
    const auth = setup();
    const created = await createGroup(auth);
    const res = await me(sessionCookie(created));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created.json());
  });

  it('answers 401 without a session cookie or with an unknown one', async () => {
    setup();
    expect((await me()).statusCode).toBe(401);
    expect((await me('velvet_rope_session=bogus')).statusCode).toBe(401);
  });

  it('expires a session 30 days after its last use, and each use slides the expiry', async () => {
    const auth = setup();
    const cookie = sessionCookie(await createGroup(auth));
    clock.t += 20 * DAY;
    expect((await me(cookie)).statusCode).toBe(200);
    clock.t += 20 * DAY; // 40 days after creation, 20 after last use
    expect((await me(cookie)).statusCode).toBe(200);
    clock.t += 30 * DAY;
    expect((await me(cookie)).statusCode).toBe(401);
  });
});
