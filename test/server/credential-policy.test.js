// The `credentials` option: which kinds of device may join, shown to a joining device in its status.
import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, openDb, config, CSRF } from './harness.js';

let app;
afterEach(() => app?.close());

async function joinStatus(credentials) {
  app = buildApp({ db: openDb(':memory:'), config, credentials });
  const res = await app.inject({
    method: 'POST',
    url: '/api/link-requests',
    headers: CSRF,
    payload: { label: 'Tablet' },
  });
  const link = [res.headers['set-cookie']]
    .flat()
    .find((c) => c.startsWith('velvet_rope_link='))
    .split(';')[0];
  return (await app.inject({ method: 'GET', url: '/api/link-requests/current', headers: { cookie: link } })).json();
}

describe('credentials option', () => {
  it('defaults to passkey only', async () => {
    expect((await joinStatus(undefined)).credentials).toEqual(['passkey']);
  });

  it.each([[['passkey', 'key']], [['key']]])('shows %j in the status', async (credentials) => {
    expect((await joinStatus(credentials)).credentials).toEqual(credentials);
  });

  it.each([[[]], [['pass']], [['passkey', 'passkey']], ['passkey'], [null]])('rejects %j at setup', async (bad) => {
    app = buildApp({ db: openDb(':memory:'), config, credentials: bad });
    await expect(app.ready()).rejects.toThrow(/credentials/);
  });
});
