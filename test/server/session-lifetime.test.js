import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, openDb } from './harness.js';
import { addMember, addDevice } from '../../src/testing/members.js';

const DAY = 24 * 60 * 60 * 1000;
const T = 1_700_000_000_000;

let app;
afterEach(() => app?.close());

function setup(sessionTtlMs) {
  const db = openDb(':memory:');
  let t = T;
  app = buildApp({ db, now: () => t, sessionTtlMs });
  const groupId = 'g1';
  db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(groupId, 'Plans', T);
  const { memberId, token: passkeyToken } = addMember(db, { groupId, role: 'admin', now: T });
  const { token: keyToken } = addDevice(db, { memberId, kind: 'key', now: T });
  return { passkeyToken, keyToken, advance: (ms) => (t += ms) };
}

const me = (token) =>
  app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `velvet_rope_session=${token}` } });
const maxAge = (res) => Number(/Max-Age=(\d+)/.exec([res.headers['set-cookie']].flat()[0])[1]);

describe('session lifetime by device kind', () => {
  it('slides a passkey session 30 days and a key session 400 days', async () => {
    const { passkeyToken, keyToken, advance } = setup();
    advance(29 * DAY);
    expect((await me(passkeyToken)).statusCode).toBe(200);
    expect((await me(keyToken)).statusCode).toBe(200);
    advance(31 * DAY);
    expect((await me(passkeyToken)).statusCode).toBe(401);
    expect((await me(keyToken)).statusCode).toBe(200);
    advance(399 * DAY);
    expect((await me(keyToken)).statusCode).toBe(200);
    advance(401 * DAY);
    expect((await me(keyToken)).statusCode).toBe(401);
  });

  it('sets the cookie Max-Age by kind', async () => {
    const { passkeyToken, keyToken } = setup();
    expect(maxAge(await me(passkeyToken))).toBe(30 * 86400);
    expect(maxAge(await me(keyToken))).toBe(400 * 86400);
  });

  it('applies custom lifetimes, and a partial object keeps the other default', async () => {
    const { passkeyToken, keyToken } = setup({ key: 10 * DAY });
    expect(maxAge(await me(passkeyToken))).toBe(30 * 86400);
    expect(maxAge(await me(keyToken))).toBe(10 * 86400);
  });

  it('caps the cookie at 400 days when the key lifetime is longer', async () => {
    const { keyToken, advance } = setup({ key: 800 * DAY });
    expect(maxAge(await me(keyToken))).toBe(400 * 86400);
    advance(500 * DAY);
    expect((await me(keyToken)).statusCode).toBe(200);
  });

  it('refuses a bad sessionTtlMs at setup', async () => {
    for (const bad of [{ key: 0 }, { passkey: -1 }, { key: 'x' }, { passkey: NaN }]) {
      const broken = buildApp({ db: openDb(':memory:'), sessionTtlMs: bad });
      await expect(broken.ready()).rejects.toThrow(/sessionTtlMs/);
    }
  });
});
