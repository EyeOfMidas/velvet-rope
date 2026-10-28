import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { buildApp, openDb } from './harness.js';
import { createInvite } from '../../src/server/invites.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const ORIGIN = 'http://localhost:5173';
const config = { rpId: 'localhost', rpName: 'Test app', origin: ORIGIN };
const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };
const BODY = { groupName: 'Plans', label: 'Laptop' };

let app;
let db;
let clock;
afterEach(() => app?.close());

function setup(options = {}) {
  clock = { t: 1_700_000_000_000 };
  db = openDb(':memory:');
  app = buildApp({ db, now: () => clock.t, config, ...options });
  return createSoftAuthenticator({ origin: ORIGIN });
}

const post = (url, payload) => app.inject({ method: 'POST', url, headers: CSRF, payload });
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

describe("groupCreation: 'closed'", () => {
  it('refuses both group-creation routes with 403', async () => {
    const auth = setup({ groupCreation: 'closed' });
    const error = { error: 'group_creation_closed' };

    const options = await post('/api/groups/options', BODY);
    expect(options.statusCode).toBe(403);
    expect(options.json()).toMatchObject(error);

    // Even with options made while creation was open.
    const open = buildApp({ db, now: () => clock.t, config });
    const made = await open.inject({
      method: 'POST',
      url: '/api/groups/options',
      headers: CSRF,
      payload: BODY,
    });
    const res = await post('/api/groups', { response: auth.register(made.json()) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject(error);
    expect(count('groups')).toBe(0);
  });
});

describe("groupCreation: 'invite'", () => {
  const NEEDS_INVITE = { error: 'invite_required' };
  const BAD_INVITE = { error: 'invite_invalid' };

  async function createWith(auth, invite) {
    const options = await post('/api/groups/options', { ...BODY, invite });
    if (options.statusCode !== 200) return options;
    return post('/api/groups', { response: auth.register(options.json()) });
  }

  it('refuses to start without an invite code', async () => {
    setup({ groupCreation: 'invite' });
    const res = await post('/api/groups/options', BODY);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject(NEEDS_INVITE);
  });

  it('creates a group with a fresh invite, which then cannot be used again', async () => {
    const auth = setup({ groupCreation: 'invite' });
    const code = createInvite(db, clock.t);

    const res = await createWith(auth, code);
    expect(res.statusCode).toBe(201);
    expect(count('groups')).toBe(1);

    const again = await createWith(createSoftAuthenticator({ origin: ORIGIN }), code);
    expect(again.statusCode).toBe(403);
    expect(again.json()).toMatchObject(BAD_INVITE);
    expect(count('groups')).toBe(1);
  });

  it('stores only the hash of the code', async () => {
    setup({ groupCreation: 'invite' });
    const code = createInvite(db, clock.t);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = db.prepare('SELECT * FROM invites').get();
    expect(Object.values(row)).not.toContain(code);
    expect(row.code_hash).toBe(createHash('sha256').update(code).digest('hex'));
  });

  it('refuses an unknown or expired code', async () => {
    const auth = setup({ groupCreation: 'invite' });
    expect((await createWith(auth, 'not-a-real-code')).json()).toMatchObject(BAD_INVITE);

    const code = createInvite(db, clock.t);
    clock.t += 7 * 24 * 60 * 60 * 1000;
    const res = await createWith(auth, code);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject(BAD_INVITE);
  });

  it('spends the code only when the group is made, not when options are asked for', async () => {
    const auth = setup({ groupCreation: 'invite' });
    const code = createInvite(db, clock.t);
    expect((await post('/api/groups/options', { ...BODY, invite: code })).statusCode).toBe(200);
    expect((await createWith(auth, code)).statusCode).toBe(201);
  });

  it('refuses to finish when the code was spent by another ceremony in the meantime', async () => {
    const auth = setup({ groupCreation: 'invite' });
    const code = createInvite(db, clock.t);
    const first = await post('/api/groups/options', { ...BODY, invite: code });
    const second = await post('/api/groups/options', { ...BODY, invite: code });
    expect((await post('/api/groups', { response: auth.register(first.json()) })).statusCode).toBe(
      201,
    );
    const other = createSoftAuthenticator({ origin: ORIGIN });
    const late = await post('/api/groups', { response: other.register(second.json()) });
    expect(late.statusCode).toBe(403);
    expect(late.json()).toMatchObject(BAD_INVITE);
    expect(count('groups')).toBe(1);
  });

  it('ignores invite codes in open mode', async () => {
    const auth = setup();
    expect((await createWith(auth, 'anything')).statusCode).toBe(201);
  });
});
