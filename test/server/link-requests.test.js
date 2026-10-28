// Linking a new passkey by QR: request → scan (claim) → options → complete.
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp, openDb } from './harness.js';
import { createSession } from '../../src/testing/members.js';
import { sha256Hex } from '../../src/server/tokens.js';
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
}

function cookieFrom(res, name) {
  return [res.headers['set-cookie']]
    .flat()
    .find((c) => c?.startsWith(`${name}=`))
    ?.split(';')[0];
}

/** Creates a group through the API; returns its creator's (an admin's) session cookie and group. */
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
  return { cookie: cookieFrom(res, 'velvet_rope_session'), group: res.json().group };
}

/** Adds a passkey with the given role straight into the group; returns its session cookie. */
function insertMember(groupId, role) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO passkeys (id, group_id, label, role, user_handle, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, groupId, `${role} device`, role, randomUUID(), clock.t);
  return `velvet_rope_session=${createSession(db, id, clock.t)}`;
}

function newRequest(label = 'Firefox on Windows') {
  return app.inject({
    method: 'POST',
    url: '/api/link-requests',
    headers: CSRF,
    payload: { label },
  });
}

/** The new device: its token (as the QR carries it) and its link cookie. */
async function newDevice(label) {
  const res = await newRequest(label);
  return { token: res.json().token, link: cookieFrom(res, 'velvet_rope_link'), res };
}

const claim = (cookie, token) =>
  app.inject({
    method: 'POST',
    url: '/api/link-requests/claim',
    headers: { ...CSRF, cookie },
    payload: { token },
  });

const current = (link) =>
  app.inject({
    method: 'GET',
    url: '/api/link-requests/current',
    headers: link ? { cookie: link } : {},
  });

const options = (link) =>
  app.inject({
    method: 'POST',
    url: '/api/link-requests/current/options',
    headers: { ...CSRF, cookie: link },
    payload: {},
  });

const complete = (link, response) =>
  app.inject({
    method: 'POST',
    url: '/api/link-requests/current/complete',
    headers: { ...CSRF, cookie: link },
    payload: { response },
  });

const me = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

describe('POST /api/link-requests', () => {
  it('creates a pending request without a session and sets the link cookie', async () => {
    setup();
    const { res, token, link } = await newDevice();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({
      id: expect.any(String),
      token: expect.any(String),
      expiresAt: clock.t + 5 * MINUTE,
    });
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const header = [res.headers['set-cookie']].flat().find((c) => c.startsWith('velvet_rope_link='));
    expect(header).toBe(
      `velvet_rope_link=${token}; Path=/api/link-requests; Max-Age=300; HttpOnly; Secure; SameSite=Strict`,
    );
    expect(link).toBe(`velvet_rope_link=${token}`);
  });

  it('stores the token only as its SHA-256 hash', async () => {
    setup();
    const { token } = await newDevice();
    const row = db.prepare('SELECT * FROM link_requests').get();
    expect(row.token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('prunes expired requests when a new one is made', async () => {
    setup();
    await newDevice('Old');
    clock.t += 5 * MINUTE;
    await newDevice('New');
    expect(db.prepare('SELECT label FROM link_requests').all()).toEqual([{ label: 'New' }]);
  });

  it('rejects a blank or over-long label', async () => {
    setup();
    expect((await newRequest('   ')).statusCode).toBe(400);
    expect((await newRequest('x'.repeat(61))).statusCode).toBe(400);
    expect((await newRequest(42)).statusCode).toBe(400);
  });

  it('needs the CSRF headers', async () => {
    setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/link-requests',
      headers: { 'content-type': 'application/json' },
      payload: { label: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/link-requests/current', () => {
  it('reports a pending request', async () => {
    setup();
    const { link } = await newDevice();
    const res = await current(link);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'pending', expiresAt: clock.t + 5 * MINUTE });
  });

  it('404s without a link cookie or with an unknown one', async () => {
    setup();
    expect((await current(undefined)).statusCode).toBe(404);
    expect((await current('velvet_rope_link=nope')).statusCode).toBe(404);
  });
});

describe('the linking ceremony', () => {
  it('links a new viewer passkey: request → admin scans → options → complete', async () => {
    setup();
    const creator = await createGroup('Plans');
    const { token, link } = await newDevice('Firefox on Windows');

    const claimed = await claim(creator.cookie, token);
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json()).toEqual({ label: 'Firefox on Windows' });
    expect((await current(link)).json()).toEqual({
      status: 'claimed',
      expiresAt: clock.t + 5 * MINUTE,
      groupName: 'Plans',
    });

    const opts = await options(link);
    expect(opts.statusCode).toBe(200);
    const desktop = createSoftAuthenticator({ origin: ORIGIN });
    const done = await complete(link, desktop.register(opts.json()));
    expect(done.statusCode).toBe(201);
    expect(done.json()).toEqual({
      passkey: { id: expect.any(String), label: 'Firefox on Windows', role: 'viewer' },
      group: creator.group,
    });

    const session = cookieFrom(done, 'velvet_rope_session');
    expect(session).toBeDefined();
    const cleared = [done.headers['set-cookie']].flat().find((c) => c.startsWith('velvet_rope_link='));
    expect(cleared).toBe('velvet_rope_link=; Path=/api/link-requests; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    expect((await me(session)).json()).toEqual(done.json());
    expect((await current(link)).json()).toMatchObject({ status: 'completed', groupName: 'Plans' });

    const row = db.prepare('SELECT * FROM link_requests').get();
    const scanner = (await me(creator.cookie)).json().passkey;
    expect(row).toMatchObject({ status: 'completed', role: 'viewer', linked_by: scanner.id });
  });

  it('lets the linked passkey sign in afterwards', async () => {
    setup();
    const creator = await createGroup();
    const { token, link } = await newDevice();
    await claim(creator.cookie, token);
    const desktop = createSoftAuthenticator({ origin: ORIGIN });
    await complete(link, desktop.register((await options(link)).json()));

    const authOptions = (
      await app.inject({ method: 'POST', url: '/api/auth/options', headers: CSRF, payload: {} })
    ).json();
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/auth',
      headers: CSRF,
      payload: { response: desktop.authenticate(authOptions) },
    });
    expect(signIn.statusCode).toBe(200);
    expect(signIn.json().passkey.role).toBe('viewer');
  });
});

describe('POST /api/link-requests/current/options', () => {
  it('asks for a fresh, discoverable, local passkey named "<group> · <label>"', async () => {
    setup();
    const creator = await createGroup('Plans');
    const { token, link } = await newDevice('Firefox on Windows');
    await claim(creator.cookie, token);

    const opts = (await options(link)).json();
    expect(opts.rp).toEqual({ id: 'localhost', name: 'Test app' });
    expect(opts.user.name).toBe('Plans · Firefox on Windows');
    expect(opts.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'preferred',
      authenticatorAttachment: 'platform',
    });
    expect(opts.hints).toEqual(['client-device']);
    expect(opts.attestation).toBe('none');
  });

  it('excludes the group’s existing credentials', async () => {
    setup();
    const creator = await createGroup('Plans');
    await createGroup('Other group');
    const ownCredentials = db
      .prepare(
        `SELECT c.credential_id FROM credentials c JOIN passkeys p ON p.id = c.passkey_id
          WHERE p.group_id = ?`,
      )
      .all(creator.group.id)
      .map((r) => r.credential_id);
    const { token, link } = await newDevice();
    await claim(creator.cookie, token);

    const opts = (await options(link)).json();
    expect(opts.excludeCredentials.map((c) => c.id)).toEqual(ownCredentials);
  });

  it('gives the new passkey a user handle no other passkey has', async () => {
    setup();
    const creator = await createGroup();
    const { token, link } = await newDevice();
    await claim(creator.cookie, token);
    const desktop = createSoftAuthenticator({ origin: ORIGIN });
    const done = await complete(link, desktop.register((await options(link)).json()));

    const handles = db.prepare('SELECT id, user_handle FROM passkeys').all();
    const mine = handles.find((h) => h.id === done.json().passkey.id).user_handle;
    expect(handles.filter((h) => h.user_handle === mine)).toHaveLength(1);
    expect(mine).toBe(desktop.credentials[0].userHandle);
  });
});

describe('POST /api/link-requests/claim', () => {
  it('needs a session', async () => {
    setup();
    const { token } = await newDevice();
    const res = await app.inject({
      method: 'POST',
      url: '/api/link-requests/claim',
      headers: CSRF,
      payload: { token },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets a collaborator claim', async () => {
    setup();
    const creator = await createGroup();
    const collaborator = insertMember(creator.group.id, 'collaborator');
    const { token, link } = await newDevice();
    expect((await claim(collaborator, token)).statusCode).toBe(200);
    expect((await current(link)).json().status).toBe('claimed');
  });

  it.each(['contributor', 'viewer'])('rejects a %s and leaves the request pending', async (role) => {
    setup();
    const creator = await createGroup();
    const member = insertMember(creator.group.id, role);
    const { token, link } = await newDevice();

    const res = await claim(member, token);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'link_forbidden' });
    expect((await current(link)).json().status).toBe('pending');
    expect((await claim(creator.cookie, token)).statusCode).toBe(200);
  });

  it('rejects an unknown token with 410', async () => {
    setup();
    const creator = await createGroup();
    const res = await claim(creator.cookie, 'not-a-real-token');
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: 'link_expired' });
  });

  it('rejects an expired request with 410', async () => {
    setup();
    const creator = await createGroup();
    const { token, link } = await newDevice();
    clock.t += 5 * MINUTE;

    const res = await claim(creator.cookie, token);
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: 'link_expired' });
    expect((await current(link)).json().status).toBe('expired');
  });

  it('won’t let another group claim a request that is already claimed', async () => {
    setup();
    const alice = await createGroup('Alice');
    const mallory = await createGroup('Mallory');
    const { token, link } = await newDevice();
    await claim(alice.cookie, token);

    expect((await claim(mallory.cookie, token)).statusCode).toBe(409);
    expect((await current(link)).json()).toMatchObject({ status: 'claimed', groupName: 'Alice' });
    expect(db.prepare('SELECT group_id FROM link_requests').get().group_id).toBe(alice.group.id);
  });

  it('rejects a second claim by the same group', async () => {
    setup();
    const creator = await createGroup();
    const { token } = await newDevice();
    await claim(creator.cookie, token);
    expect((await claim(creator.cookie, token)).statusCode).toBe(409);
  });

  it('can’t reuse a token after the passkey is linked', async () => {
    setup();
    const creator = await createGroup();
    const { token, link } = await newDevice();
    await claim(creator.cookie, token);
    const desktop = createSoftAuthenticator({ origin: ORIGIN });
    await complete(link, desktop.register((await options(link)).json()));

    expect((await claim(creator.cookie, token)).statusCode).toBe(409);
    expect((await options(link)).statusCode).toBe(409);
  });
});

describe('registering against a request', () => {
  it('refuses options before the request is claimed', async () => {
    setup();
    const { link } = await newDevice();
    expect((await options(link)).statusCode).toBe(409);
  });

  it('refuses options and completion once the request has expired', async () => {
    setup();
    const creator = await createGroup();
    const { token, link } = await newDevice();
    await claim(creator.cookie, token);
    const opts = (await options(link)).json();
    clock.t += 5 * MINUTE;

    expect((await options(link)).statusCode).toBe(409);
    const desktop = createSoftAuthenticator({ origin: ORIGIN });
    expect((await complete(link, desktop.register(opts))).statusCode).not.toBe(201);
    expect(db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n).toBe(1);
  });

  it('refuses a second completion with the same request', async () => {
    setup();
    const creator = await createGroup();
    const { token, link } = await newDevice();
    await claim(creator.cookie, token);
    const first = (await options(link)).json();
    const second = (await options(link)).json();
    const desktop = createSoftAuthenticator({ origin: ORIGIN });
    expect((await complete(link, desktop.register(first))).statusCode).toBe(201);

    expect((await complete(link, desktop.register(second))).statusCode).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n).toBe(2);
  });

  it('won’t complete with a challenge issued for another request', async () => {
    setup();
    const creator = await createGroup();
    const a = await newDevice('A');
    const b = await newDevice('B');
    await claim(creator.cookie, a.token);
    await claim(creator.cookie, b.token);
    const optsForA = (await options(a.link)).json();
    const desktop = createSoftAuthenticator({ origin: ORIGIN });
    expect((await complete(b.link, desktop.register(optsForA))).statusCode).toBe(400);
  });

  it('won’t complete with a passkey created on another origin', async () => {
    setup();
    const creator = await createGroup();
    const { token, link } = await newDevice();
    await claim(creator.cookie, token);
    const desktop = createSoftAuthenticator({ origin: ORIGIN });
    const response = desktop.register((await options(link)).json(), {
      origin: 'http://localhost:5174',
    });
    expect((await complete(link, response)).statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n).toBe(1);
  });

  it('404s without a link cookie', async () => {
    setup();
    expect((await options('velvet_rope_link=nope')).statusCode).toBe(404);
    expect((await complete('velvet_rope_link=nope', {})).statusCode).toBe(404);
  });

  it('writes a link entry to the audit log', async () => {
    setup();
    const creator = await createGroup();
    const scanner = (await me(creator.cookie)).json().passkey;
    const { token, link } = await newDevice('Firefox on Windows');
    await claim(creator.cookie, token);
    const desktop = createSoftAuthenticator({ origin: ORIGIN });
    const done = await complete(link, desktop.register((await options(link)).json()));

    expect(db.prepare('SELECT * FROM audit_log').all()).toEqual([
      {
        id: expect.any(Number),
        group_id: creator.group.id,
        actor_passkey_id: scanner.id,
        action: 'link',
        target: done.json().passkey.id,
        detail_json: JSON.stringify({ label: 'Firefox on Windows', role: 'viewer' }),
        at: clock.t,
      },
    ]);
  });
});
