// Linking a new passkey by QR: request → scan (claim) → options → complete.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Refusal } from '../../src/server/hooks.js';
import { buildApp, openDb } from './harness.js';
import { addMember } from '../../src/testing/members.js';
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

function setup(extra = {}) {
  clock = { t: 1_700_000_000_000 };
  db = openDb(':memory:');
  app = buildApp({ db, now: () => clock.t, config, ...extra });
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

/** Adds a member with the given role straight into the group; returns its session cookie. */
function insertMember(groupId, role) {
  return `velvet_rope_session=${addMember(db, { groupId, role, now: clock.t }).token}`;
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

const claim = (cookie, token, choice = { outcome: 'new-member' }) =>
  app.inject({
    method: 'POST',
    url: '/api/link-requests/claim',
    headers: { ...CSRF, cookie },
    payload: { token, ...choice },
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
      `velvet_rope_link=${token}; Path=/api/link-requests; Max-Age=3600; HttpOnly; Secure; SameSite=Strict`,
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

  describe('name and profile', () => {
    const send = (payload) =>
      app.inject({ method: 'POST', url: '/api/link-requests', headers: CSRF, payload: { label: 'Phone', ...payload } });
    const stored = () => db.prepare('SELECT name, profile_json FROM link_requests').get();

    it('stores the name and the profile the hook returns', async () => {
      const validateProfile = async (p) => ({ colour: String(p.colour).trim() });
      setup({ hooks: { validateProfile } });
      const res = await send({ name: '  Sam  ', profile: { colour: ' red ' } });
      expect(res.statusCode).toBe(201);
      expect(stored()).toEqual({ name: 'Sam', profile_json: '{"colour":"red"}' });
    });

    it('refuses any profile by default, but a request without one works', async () => {
      setup();
      const res = await send({ profile: { a: 1 } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('profile_invalid');
      expect(res.json().message).toBeTruthy();
      expect((await send({})).statusCode).toBe(201);
      expect(stored()).toEqual({ name: null, profile_json: null });
    });

    it('refuses an oversized profile without calling the hook', async () => {
      const validateProfile = vi.fn(async (p) => p);
      setup({ hooks: { validateProfile }, maxProfileBytes: 20 });
      const res = await send({ profile: { text: 'x'.repeat(50) } });
      expect(res.statusCode).toBe(413);
      expect(res.json().error).toBe('profile_too_large');
      expect(validateProfile).not.toHaveBeenCalled();
    });

    it('replies with a Refusal the hook throws', async () => {
      const validateProfile = () => {
        throw new Refusal(422, 'profile_invalid', 'Pick a colour');
      };
      setup({ hooks: { validateProfile } });
      const res = await send({ profile: {} });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({ error: 'profile_invalid', message: 'Pick a colour' });
    });

    it('hides the text of any other hook error', async () => {
      const validateProfile = () => {
        throw new Error('secret internals');
      };
      setup({ hooks: { validateProfile } });
      const res = await send({ profile: {} });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('secret');
    });
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
    expect(res.json()).toEqual({
      status: 'pending',
      expiresAt: clock.t + 5 * MINUTE,
      credentials: ['passkey'],
    });
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
      outcome: 'new-member',
      credentials: ['passkey'],
    });

    const opts = await options(link);
    expect(opts.statusCode).toBe(200);
    const desktop = createSoftAuthenticator({ origin: ORIGIN });
    const done = await complete(link, desktop.register(opts.json()));
    expect(done.statusCode).toBe(201);
    expect(done.json()).toEqual({
      member: { id: expect.any(String), name: 'Firefox on Windows', role: 'viewer' },
      device: { id: expect.any(String), label: 'Firefox on Windows', kind: 'passkey' },
      group: creator.group,
      passkey: { id: done.json().device.id, label: 'Firefox on Windows', role: 'viewer' },
    });

    const session = cookieFrom(done, 'velvet_rope_session');
    expect(session).toBeDefined();
    const cleared = [done.headers['set-cookie']].flat().find((c) => c.startsWith('velvet_rope_link='));
    expect(cleared).toBe('velvet_rope_link=; Path=/api/link-requests; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    expect((await me(session)).json()).toEqual(done.json());
    expect((await current(link)).json()).toMatchObject({
      status: 'completed',
      groupName: 'Plans',
      outcome: 'new-member',
    });

    const row = db.prepare('SELECT * FROM link_requests').get();
    const scanner = (await me(creator.cookie)).json().device;
    expect(row).toMatchObject({
      status: 'completed',
      role: 'viewer',
      claimed_by: scanner.id,
      outcome: 'new-member',
      member_id: null,
      sign_out: 'none',
    });
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
    expect(signIn.json().member.role).toBe('viewer');
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
        `SELECT c.credential_id FROM credentials c JOIN devices p ON p.id = c.device_id
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

    const handles = db.prepare('SELECT id, user_handle FROM devices').all();
    const mine = handles.find((h) => h.id === done.json().device.id).user_handle;
    expect(handles.filter((h) => h.user_handle === mine)).toHaveLength(1);
    expect(mine).toBe(desktop.credentials[0].userHandle);
  });
});

describe('POST /api/link-requests/claim', () => {
  it('refuses a body-less claim with a 4xx, not a server error', async () => {
    setup();
    const creator = await createGroup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/link-requests/claim',
      headers: { 'x-velvet-rope': '1', cookie: creator.cookie },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

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

describe('claiming with an outcome', () => {
  const stored = () => db.prepare('SELECT outcome, member_id, sign_out, role FROM link_requests').get();

  /** A group with its admin, a viewer to relink, and a claimable request. */
  async function scene() {
    setup();
    const creator = await createGroup('Plans');
    const adminId = (await me(creator.cookie)).json().member.id;
    const target = addMember(db, { groupId: creator.group.id, role: 'viewer', now: clock.t });
    return { creator, adminId, target, ...(await newDevice('Phone')) };
  }

  it('stores a new member', async () => {
    const { creator, token, link } = await scene();
    expect((await claim(creator.cookie, token, { outcome: 'new-member' })).statusCode).toBe(200);
    expect(stored()).toEqual({ outcome: 'new-member', member_id: null, sign_out: 'none', role: 'viewer' });
    expect((await current(link)).json().outcome).toBe('new-member');
  });

  it('stores one of the scanner’s own devices, with the sign-out choice', async () => {
    const { creator, adminId, token, link } = await scene();
    const res = await claim(creator.cookie, token, { outcome: 'own-device', signOut: 'scanner' });
    expect(res.statusCode).toBe(200);
    expect(stored()).toEqual({ outcome: 'own-device', member_id: adminId, sign_out: 'scanner', role: null });
    expect((await current(link)).json()).toMatchObject({ status: 'claimed', outcome: 'own-device' });
  });

  it('stores a relink to another live member of the group', async () => {
    const { creator, target, token, link } = await scene();
    const choice = { outcome: 'member', memberId: target.memberId, signOut: 'others' };
    expect((await claim(creator.cookie, token, choice)).statusCode).toBe(200);
    expect(stored()).toEqual({ outcome: 'member', member_id: target.memberId, sign_out: 'others', role: null });
    expect((await current(link)).json().outcome).toBe('member');
  });

  it('hides the outcome until the request is claimed', async () => {
    const { link } = await scene();
    expect((await current(link)).json()).not.toHaveProperty('outcome');
  });

  it('refuses to relink a member of another group with 404, leaving the request pending', async () => {
    const { creator, token, link } = await scene();
    const other = await createGroup('Other');
    const stranger = addMember(db, { groupId: other.group.id, role: 'viewer', now: clock.t });
    const res = await claim(creator.cookie, token, { outcome: 'member', memberId: stranger.memberId });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'member_not_found' });
    expect((await current(link)).json().status).toBe('pending');
  });

  it('refuses to relink an ended member, or one that doesn’t exist, with 404', async () => {
    const { creator, target, token, link } = await scene();
    db.prepare('UPDATE members SET ended_at = ?, ended_reason = ? WHERE id = ?').run(
      clock.t,
      'removed',
      target.memberId,
    );
    const ended = await claim(creator.cookie, token, { outcome: 'member', memberId: target.memberId });
    expect(ended.statusCode).toBe(404);
    expect(ended.json().error).toBe('member_not_found');
    expect((await claim(creator.cookie, token, { outcome: 'member', memberId: 'nope' })).statusCode).toBe(404);
    expect((await current(link)).json().status).toBe('pending');
  });

  it.each([
    ['a missing outcome', {}],
    ['an unknown outcome', { outcome: 'admin' }],
    ['a relink without a member', { outcome: 'member' }],
    ['a member id that isn’t text', { outcome: 'member', memberId: 42 }],
    ['an unknown signOut', { outcome: 'own-device', signOut: 'all' }],
    ['a signOut a new member can’t have', { outcome: 'new-member', signOut: 'others' }],
  ])('refuses %s with 400', async (_name, choice) => {
    const { creator, token, link } = await scene();
    const res = await claim(creator.cookie, token, choice);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'bad_outcome', message: expect.any(String) });
    expect((await current(link)).json().status).toBe('pending');
  });

  it('refuses an outcome the scanner’s role can’t choose', async () => {
    const { creator, target, token } = await scene();
    const collaborator = insertMember(creator.group.id, 'collaborator');
    for (const choice of [{ outcome: 'own-device' }, { outcome: 'member', memberId: target.memberId }]) {
      expect((await claim(collaborator, token, choice)).statusCode).toBe(403);
    }
    expect(stored().outcome).toBeNull();
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
    expect(db.prepare('SELECT COUNT(*) AS n FROM members').get().n).toBe(1);
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
    expect(db.prepare('SELECT COUNT(*) AS n FROM members').get().n).toBe(2);
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
    expect(db.prepare('SELECT COUNT(*) AS n FROM members').get().n).toBe(1);
  });

  it('404s without a link cookie', async () => {
    setup();
    expect((await options('velvet_rope_link=nope')).statusCode).toBe(404);
    expect((await complete('velvet_rope_link=nope', {})).statusCode).toBe(404);
  });

  it('writes a link entry to the audit log', async () => {
    setup();
    const creator = await createGroup();
    const scanner = (await me(creator.cookie)).json().member;
    const { token, link } = await newDevice('Firefox on Windows');
    await claim(creator.cookie, token);
    const desktop = createSoftAuthenticator({ origin: ORIGIN });
    const done = await complete(link, desktop.register((await options(link)).json()));

    expect(db.prepare('SELECT * FROM audit_log').all()).toEqual([
      {
        id: expect.any(Number),
        group_id: creator.group.id,
        actor_member_id: scanner.id,
        action: 'link',
        target: done.json().member.id,
        detail_json: JSON.stringify({ label: 'Firefox on Windows', role: 'viewer' }),
        at: clock.t,
      },
    ]);
  });
});

describe('renewing a join request', () => {
  const renew = (link) =>
    app.inject({
      method: 'POST',
      url: '/api/link-requests/current/renew',
      headers: { ...CSRF, cookie: link },
      payload: {},
    });

  it('extends the expiry and keeps the token', async () => {
    setup();
    const { link, res } = await newDevice();
    const first = res.json().expiresAt;
    clock.t += 4 * MINUTE;
    const renewed = await renew(link);
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().expiresAt).toBe(first + 4 * MINUTE);
    clock.t += 4 * MINUTE;
    const status = await current(link);
    expect(status.json()).toEqual({ status: 'pending', expiresAt: first + 4 * MINUTE, credentials: ['passkey'] });
  });

  it('is refused with 409 once claimed', async () => {
    setup();
    const { group } = await createGroup();
    const admin = insertMember(group.id, 'admin');
    const { token, link } = await newDevice();
    await claim(admin, token);
    const res = await renew(link);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('link_not_pending');
  });

  it('is refused as expired after the expiry', async () => {
    setup();
    const { link } = await newDevice();
    clock.t += 6 * MINUTE;
    expect((await renew(link)).statusCode).toBe(410);
  });

  it('follows the options and stops at the max age', async () => {
    setup({ linkRequestTtlMs: MINUTE, linkRequestMaxAgeMs: 90_000 });
    const { link, res } = await newDevice();
    const created = res.json().expiresAt - MINUTE;
    expect(res.json().expiresAt).toBe(created + MINUTE);
    clock.t += 50_000;
    expect((await renew(link)).json().expiresAt).toBe(created + 90_000);
  });
});

describe('ids option', () => {
  it('gives a member and device that join by QR the app�s ids', async () => {
    let n = 0;
    setup({ ids: { member: () => `m-${++n}`, device: () => `d-${n}` } });
    const creator = await createGroup('Plans');
    const { token, link } = await newDevice('Firefox on Windows');
    await claim(creator.cookie, token);
    const opts = await options(link);
    const done = await complete(link, createSoftAuthenticator({ origin: ORIGIN }).register(opts.json()));
    expect(done.statusCode).toBe(201);
    expect(done.json()).toMatchObject({ member: { id: 'm-2' }, device: { id: 'd-2' } });
  });
});

describe('peeking at a join request', () => {
  const peek = (cookie, token) =>
    app.inject({
      method: 'POST',
      url: '/api/link-requests/peek',
      headers: cookie ? { ...CSRF, cookie } : CSRF,
      payload: { token },
    });

  async function request(payload) {
    const res = await app.inject({ method: 'POST', url: '/api/link-requests', headers: CSRF, payload });
    return res.json().token;
  }

  it('previews the request without claiming it', async () => {
    setup({ hooks: { validateProfile: async (p) => ({ colour: p.colour }) } });
    const creator = await createGroup();
    const token = await request({ label: 'Firefox', name: 'Sam', profile: { colour: 'red' } });
    const res = await peek(creator.cookie, token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      label: 'Firefox',
      name: 'Sam',
      profile: { colour: 'red' },
      expiresAt: clock.t + 5 * MINUTE,
      outcomes: ['new-member', 'own-device', 'member'],
    });
    expect(db.prepare('SELECT status FROM link_requests').pluck().get()).toBe('pending');
    expect((await claim(creator.cookie, token)).statusCode).toBe(200);
  });

  it('shows a viewer the preview with no outcomes', async () => {
    setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.group.id, 'viewer');
    const token = await request({ label: 'Firefox' });
    const res = await peek(viewer, token);
    expect(res.json()).toMatchObject({ name: null, profile: null, outcomes: [] });
  });

  it('needs a session', async () => {
    setup();
    const token = await request({ label: 'Firefox' });
    expect((await peek(null, token)).statusCode).toBe(401);
  });

  it('refuses expired, unknown and claimed requests', async () => {
    setup();
    const creator = await createGroup();
    const token = await request({ label: 'Firefox' });
    expect((await peek(creator.cookie, 'nope')).statusCode).toBe(410);
    await claim(creator.cookie, token);
    const taken = await peek(creator.cookie, token);
    expect([taken.statusCode, taken.json().error]).toEqual([409, 'link_taken']);
    const fresh = await request({ label: 'Edge' });
    clock.t += 6 * MINUTE;
    const res = await peek(creator.cookie, fresh);
    expect([res.statusCode, res.json().error]).toEqual([410, 'link_expired']);
  });
});
