// eventsRoute: false leaves GET /events to the app, while group events still reach the hub the
// app passed as `events`.
import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, openDb } from './harness.js';
import { createHub } from '../../src/server/hub.js';
import { addMember } from '../../src/testing/members.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const ORIGIN = 'http://localhost:5173';
const config = { rpId: 'localhost', rpName: 'Test app', origin: ORIGIN };
const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };

let app;
afterEach(() => app?.close());

describe('eventsRoute: false', () => {
  it('does not register GET /events and still publishes to the app hub', async () => {
    const db = openDb(':memory:');
    const events = createHub();
    app = buildApp({ db, config, events, eventsRoute: false });

    const auth = createSoftAuthenticator({ origin: ORIGIN });
    const options = (
      await app.inject({
        method: 'POST',
        url: '/api/groups/options',
        headers: CSRF,
        payload: { groupName: 'Plans', label: 'Phone' },
      })
    ).json();
    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: CSRF,
      payload: { response: auth.register(options) },
    });
    const cookie = [created.headers['set-cookie']]
      .flat()
      .find((c) => c?.startsWith('velvet_rope_session='))
      .split(';')[0];
    const { group } = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();

    expect((await app.inject({ method: 'GET', url: '/api/events', headers: { cookie } })).statusCode).toBe(404);

    const got = [];
    events.subscribe(group.id, (event) => got.push(event));
    const member = addMember(db, { groupId: group.id, role: 'viewer' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/members/${member.memberId}`,
      headers: { ...CSRF, cookie },
      payload: { label: 'Laptop' },
    });
    expect(res.statusCode).toBe(200);
    expect(got).toContain('members-changed');
  });
});
