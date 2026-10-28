import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, openDb } from './harness.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const ORIGIN = 'http://localhost:5173';
const config = { rpId: 'localhost', rpName: 'Test app', origin: ORIGIN };
const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };
const MINUTE = 60 * 1000;

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

function post(url, payload, headers = CSRF) {
  return app.inject({ method: 'POST', url, headers, payload });
}

function sessionCookie(res) {
  const header = [res.headers['set-cookie']]
    .flat()
    .find((c) => c?.startsWith('velvet_rope_session='));
  return header?.split(';')[0];
}

function me(cookie) {
  return app.inject({ method: 'GET', url: '/api/me', headers: cookie ? { cookie } : {} });
}

async function createGroup(auth, body = { groupName: 'Plans', label: 'Firefox on Windows' }) {
  const options = (await post('/api/groups/options', body)).json();
  return post('/api/groups', { response: auth.register(options) });
}

async function signInOptions() {
  return (await post('/api/auth/options', {})).json();
}

function signIn(response, headers) {
  return post('/api/auth', { response }, headers);
}

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

describe('POST /api/auth/options', () => {
  it('returns discoverable authentication options: no allowCredentials, UV preferred', async () => {
    setup();
    const res = await post('/api/auth/options', {});
    expect(res.statusCode).toBe(200);
    const options = res.json();
    expect(options.rpId).toBe('localhost');
    expect(options.userVerification).toBe('preferred');
    expect(options.allowCredentials ?? []).toEqual([]);
    expect(options.challenge).toEqual(expect.any(String));
  });
});

describe('POST /api/auth', () => {
  it('signs in with an existing passkey and names the passkey and its group', async () => {
    const auth = setup();
    const created = await createGroup(auth);
    const res = await signIn(auth.authenticate(await signInOptions()));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(created.json());
    const cookie = sessionCookie(res);
    expect(cookie).toBeTruthy();
    expect(cookie).not.toBe(sessionCookie(created));
    expect((await me(cookie)).json()).toEqual(created.json());
  });

  it('records the new signature counter and when the passkey was last used', async () => {
    const auth = setup();
    await createGroup(auth);
    clock.t += 60 * MINUTE;
    await signIn(auth.authenticate(await signInOptions()));
    expect(db.prepare('SELECT sign_count FROM credentials').get().sign_count).toBe(1);
    expect(db.prepare('SELECT last_used_at FROM passkeys').get().last_used_at).toBe(clock.t);
  });
});

describe('POST /api/auth/sign-out', () => {
  function signOut(cookie, headers = CSRF) {
    return app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: cookie ? { ...headers, cookie } : headers,
      payload: {},
    });
  }

  it('ends this session on the server and clears the cookie', async () => {
    const auth = setup();
    const cookie = sessionCookie(await createGroup(auth));
    const res = await signOut(cookie);
    expect(res.statusCode).toBe(204);
    const header = [res.headers['set-cookie']]
      .flat()
      .find((c) => c?.startsWith('velvet_rope_session='));
    expect(header).toMatch(/^velvet_rope_session=;/);
    expect(header).toMatch(/; Max-Age=0/);
    expect(header).toMatch(/; Path=\//);
    expect(header).toMatch(/; HttpOnly/);
    expect(header).toMatch(/; Secure/);
    expect(header).toMatch(/; SameSite=Strict/);
    expect(count('sessions')).toBe(0);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('leaves the passkey’s other sessions alone', async () => {
    const auth = setup();
    const first = sessionCookie(await createGroup(auth));
    const second = sessionCookie(await signIn(auth.authenticate(await signInOptions())));
    await signOut(first);
    expect((await me(second)).statusCode).toBe(200);
  });

  it('answers 204 without a session', async () => {
    setup();
    expect((await signOut()).statusCode).toBe(204);
    expect((await signOut('velvet_rope_session=bogus')).statusCode).toBe(204);
  });

  it('rejects a request without the CSRF header and keeps the session', async () => {
    const auth = setup();
    const cookie = sessionCookie(await createGroup(auth));
    const res = await signOut(cookie, { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(403);
    expect((await me(cookie)).statusCode).toBe(200);
  });
});

describe('POST /api/auth rejects', () => {
  it('an assertion signed by a different key', async () => {
    const auth = setup();
    await createGroup(auth);
    const impostor = createSoftAuthenticator({ origin: ORIGIN });
    impostor.register((await post('/api/groups/options', { groupName: 'X', label: 'Y' })).json());
    const forged = impostor.authenticate(await signInOptions());
    forged.id = forged.rawId = auth.credentials[0].id;
    const res = await signIn(forged);
    expect(res.statusCode).toBe(400);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('an assertion made on another origin', async () => {
    const auth = setup();
    await createGroup(auth);
    const options = await signInOptions();
    const res = await signIn(auth.authenticate(options, { origin: 'http://localhost:5174' }));
    expect(res.statusCode).toBe(400);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('a replayed assertion: the challenge is single-use', async () => {
    const auth = setup();
    await createGroup(auth);
    const response = auth.authenticate(await signInOptions());
    expect((await signIn(response)).statusCode).toBe(200);
    const replay = await signIn(response);
    expect(replay.statusCode).toBe(400);
    expect(sessionCookie(replay)).toBeUndefined();
  });

  it('a replayed assertion from a passkey whose counter stays at 0 (synced passkeys)', async () => {
    // The signature counter can't catch this replay, so only the single-use challenge does.
    const auth = setup();
    await createGroup(auth);
    auth.credentials[0].counter = -1; // authenticate() adds 1: the assertion says 0
    const response = auth.authenticate(await signInOptions());
    expect((await signIn(response)).statusCode).toBe(200);
    const replay = await signIn(response);
    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: 'bad_challenge' });
    expect(sessionCookie(replay)).toBeUndefined();
  });

  it('a challenge the server never issued', async () => {
    const auth = setup();
    await createGroup(auth);
    const res = await signIn(auth.authenticate({ rpId: 'localhost', challenge: 'bm90LWlzc3VlZA' }));
    expect(res.statusCode).toBe(400);
  });

  it('a challenge older than five minutes', async () => {
    const auth = setup();
    await createGroup(auth);
    const options = await signInOptions();
    clock.t += 5 * MINUTE;
    const res = await signIn(auth.authenticate(options));
    expect(res.statusCode).toBe(400);
  });

  it('a challenge issued for creating a group', async () => {
    const auth = setup();
    await createGroup(auth);
    const createOptions = (
      await post('/api/groups/options', { groupName: 'Plans', label: 'Other' })
    ).json();
    const res = await signIn(
      auth.authenticate({ rpId: 'localhost', challenge: createOptions.challenge }),
    );
    expect(res.statusCode).toBe(400);
  });

  it('a revoked passkey, saying it was removed from its group', async () => {
    const auth = setup();
    await createGroup(auth);
    db.prepare('UPDATE passkeys SET revoked_at = ?').run(clock.t);
    const res = await signIn(auth.authenticate(await signInOptions()));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'removed' });
    expect(sessionCookie(res)).toBeUndefined();
    expect(count('sessions')).toBe(1); // only the one from creating the group
  });

  it('a passkey whose group was deleted, saying it was removed from its group', async () => {
    const auth = setup();
    const created = await createGroup(auth);
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/group',
      headers: { ...CSRF, cookie: sessionCookie(created) },
      payload: { name: 'Plans' },
    });
    expect(del.statusCode).toBe(204);
    const res = await signIn(auth.authenticate(await signInOptions()));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'removed' });
    expect(sessionCookie(res)).toBeUndefined();
    expect(count('sessions')).toBe(0);
  });

  it('an assertion whose user handle is not the passkey’s', async () => {
    const auth = setup();
    await createGroup(auth);
    const response = auth.authenticate(await signInOptions());
    response.response.userHandle = Buffer.from('someone-else').toString('base64url');
    const res = await signIn(response);
    expect(res.statusCode).toBe(400);
    expect(sessionCookie(res)).toBeUndefined();
  });

  it('a request without the CSRF header', async () => {
    const auth = setup();
    await createGroup(auth);
    const response = auth.authenticate(await signInOptions());
    const res = await signIn(response, { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(403);
    const options = await post('/api/auth/options', {}, { 'content-type': 'application/json' });
    expect(options.statusCode).toBe(403);
  });

  it('a credential the server does not know, while other passkeys exist', async () => {
    await createGroup(setup());
    const stranger = createSoftAuthenticator({ origin: ORIGIN });
    stranger.register({ rp: { id: 'localhost' }, user: { id: 'dXNlcg' }, challenge: 'Yw' });
    const res = await signIn(stranger.authenticate(await signInOptions()));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'removed' });
    expect(sessionCookie(res)).toBeUndefined();
  });
});
