// Creating a group from a device with a device key: one step, no WebAuthn, same rules as /groups.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildApp, openDb, config, CSRF } from './harness.js';
import { createInvite } from '../../src/server/invites.js';
import { Refusal } from '../../src/server/index.js';

let app;
let db;
afterEach(() => app?.close());

function setup(options = {}) {
  db = openDb(':memory:');
  app = buildApp({ db, config, credentials: ['passkey', 'key'], ...options });
}
const post = (url, payload) => app.inject({ method: 'POST', url, headers: CSRF, payload });
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const BODY = { groupName: 'Plans', label: 'Kiosk' };

describe('POST /groups/key', () => {
  it('creates the group, an admin and a key device, and signs in with the device key', async () => {
    setup();
    const res = await post('/api/groups/key', BODY);
    expect(res.statusCode).toBe(201);
    expect(res.json().device.kind).toBe('key');
    expect(res.json().member.role).toBe('admin');
    expect(res.json().member.name).toBe('Kiosk');
    expect(count('groups')).toBe(1);
    const cookie = res.headers['set-cookie'].split(';')[0];
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().group.name).toBe('Plans');
  });

  it('uses the given name over the label', async () => {
    setup();
    const res = await post('/api/groups/key', { ...BODY, name: 'Ada' });
    expect(res.json().member.name).toBe('Ada');
  });

  it('needs a group name and a label', async () => {
    setup();
    const res = await post('/api/groups/key', { groupName: 'Plans' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('names_required');
  });

  it('refuses when group creation is closed', async () => {
    setup({ groupCreation: 'closed' });
    const res = await post('/api/groups/key', BODY);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('group_creation_closed');
  });

  it('is refused under the default policy', async () => {
    setup({ credentials: undefined });
    const res = await post('/api/groups/key', BODY);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('key_not_allowed');
    expect(count('groups')).toBe(0);
  });

  describe('invite mode', () => {
    it('works with a valid invite, then refuses the spent one', async () => {
      setup({ groupCreation: 'invite' });
      const code = createInvite(db, Date.now());
      expect((await post('/api/groups/key', { ...BODY, invite: code })).statusCode).toBe(201);
      const again = await post('/api/groups/key', { ...BODY, invite: code });
      expect(again.statusCode).toBe(403);
      expect(again.json().error).toBe('invite_invalid');
      expect(count('groups')).toBe(1);
    });

    it('refuses without an invite', async () => {
      setup({ groupCreation: 'invite' });
      const res = await post('/api/groups/key', BODY);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('invite_required');
    });
  });

  describe('profile', () => {
    it('is vetted, then passed to onMemberCreated', async () => {
      const onMemberCreated = vi.fn();
      setup({ hooks: { onMemberCreated, validateProfile: (p) => ({ colour: p.colour }) } });
      const res = await post('/api/groups/key', { ...BODY, profile: { colour: 'red', junk: 1 } });
      expect(res.statusCode).toBe(201);
      expect(onMemberCreated.mock.calls[0][1]).toMatchObject({ profile: { colour: 'red' }, via: 'create-group' });
    });

    it('is refused before anything is created when the app rejects it', async () => {
      setup(); // the default validateProfile refuses everything
      const res = await post('/api/groups/key', { ...BODY, profile: { a: 1 } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('profile_invalid');
      expect(count('groups')).toBe(0);
    });

    it('is refused when too large', async () => {
      setup({ maxProfileBytes: 10 });
      const res = await post('/api/groups/key', { ...BODY, profile: { a: 'x'.repeat(50) } });
      expect(res.statusCode).toBe(413);
      expect(count('groups')).toBe(0);
    });
  });

  it('leaves no group when onMemberCreated vetoes', async () => {
    setup({
      hooks: {
        onMemberCreated: () => {
          throw new Refusal(409, 'too_many_groups');
        },
      },
    });
    const res = await post('/api/groups/key', BODY);
    expect(res.statusCode).toBe(409);
    expect(count('groups')).toBe(0);
    expect(count('devices')).toBe(0);
  });
});

describe("credentials: ['key']", () => {
  it('refuses passkey group creation', async () => {
    setup({ credentials: ['key'] });
    for (const url of ['/api/groups/options', '/api/groups']) {
      const res = await post(url, BODY);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('passkey_not_allowed');
    }
  });

  it('still allows creating with a key', async () => {
    setup({ credentials: ['key'] });
    expect((await post('/api/groups/key', BODY)).statusCode).toBe(201);
  });
});
