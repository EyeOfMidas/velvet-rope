import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, openDb } from './harness.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };

let app;
afterEach(() => app?.close());

function setup(origin, extra = {}) {
  app = buildApp({
    db: openDb(':memory:'),
    now: () => 1_700_000_000_000,
    config: { rpId: 'localhost', rpName: 'Test app', origin },
    ...extra,
  });
  return createSoftAuthenticator({ origin });
}

const post = (url, payload, headers = {}) =>
  app.inject({ method: 'POST', url, headers: { ...CSRF, ...headers }, payload });
const me = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

async function createGroup(auth) {
  const options = await post('/api/groups/options', { groupName: 'Plans', label: 'Laptop' });
  const res = await post('/api/groups', { response: auth.register(options.json()) });
  return [res.headers['set-cookie']].flat()[0];
}

describe('session cookie name', () => {
  it('is __Host-velvet_rope_session behind an https origin: Secure, Path=/, no Domain', async () => {
    const auth = setup('https://localhost');
    const header = await createGroup(auth);
    expect(header).toMatch(/^__Host-velvet_rope_session=[A-Za-z0-9_-]{43};/);
    expect(header).toContain('; Path=/;');
    expect(header).toContain('; Secure');
    expect(header).not.toMatch(/domain=/i);

    const value = header.split(';')[0].split('=')[1];
    expect((await me(`__Host-velvet_rope_session=${value}`)).statusCode).toBe(200);
    // The dev name isn't read in prod.
    expect((await me(`velvet_rope_session=${value}`)).statusCode).toBe(401);

    const out = await post('/api/auth/sign-out', {}, { cookie: `__Host-velvet_rope_session=${value}` });
    expect([out.headers['set-cookie']].flat()[0]).toMatch(/^__Host-velvet_rope_session=; Path=\/;/);
    expect((await me(`__Host-velvet_rope_session=${value}`)).statusCode).toBe(401);
  });

  it('stays velvet_rope_session on plain-http localhost', async () => {
    const auth = setup('http://localhost:5173');
    expect(await createGroup(auth)).toMatch(/^velvet_rope_session=/);
  });

  it('uses sessionCookieName exactly, with no __Host- prefix, even behind https', async () => {
    const auth = setup('https://localhost', { sessionCookieName: 'its_cookie' });
    const header = await createGroup(auth);
    expect(header).toMatch(/^its_cookie=[A-Za-z0-9_-]{43}; Path=\/;/);
    expect(header).toContain('; HttpOnly');
    expect(header).toContain('; Secure');
    expect(header).toContain('SameSite=Strict');
    const value = header.split(';')[0].split('=')[1];
    expect((await me(`its_cookie=${value}`)).statusCode).toBe(200);
    expect((await me(`__Host-velvet_rope_session=${value}`)).statusCode).toBe(401);
  });

  it.each(['', 'has space', 'a;b', 42])('throws at setup for invalid sessionCookieName %j', async (name) => {
    setup('http://localhost:5173', { sessionCookieName: name });
    await expect(app.ready()).rejects.toThrow(/sessionCookieName/);
  });
});
