// Finishing a join applies what the scanner chose: a new member, another device for the scanner
// (switching phones, signing the old one out) or a device for a member an admin relinks (a lost
// phone). Everything goes through the real routes with the soft authenticator.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { Refusal, createHub } from '../../src/server/index.js';
import { buildApp, openDb } from './harness.js';
import { addDevice, addMember } from '../../src/testing/members.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const ORIGIN = 'http://localhost:5173';
const config = { rpId: 'localhost', rpName: 'Test app', origin: ORIGIN };
const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };

let app;
let db;
let clock;
let sent; // what reached devices: [{ event, deviceId }] and [{ disconnect: deviceId }]
afterEach(() => app?.close());

function setup(hooks = {}) {
  clock = { t: 1_700_000_000_000 };
  sent = [];
  db = openDb(':memory:');
  const events = createHub();
  const publishTo = events.publishTo;
  events.publishTo = (deviceId, event, data) => {
    sent.push({ event, deviceId });
    publishTo(deviceId, event, data);
  };
  const disconnect = events.disconnect;
  events.disconnect = (deviceId) => {
    sent.push({ disconnect: deviceId });
    disconnect(deviceId);
  };
  app = buildApp({ db, now: () => clock.t, config, events, hooks });
}

const cookieFrom = (res, name) =>
  [res.headers['set-cookie']]
    .flat()
    .find((c) => c?.startsWith(`${name}=`))
    ?.split(';')[0];

const post = (url, cookie, payload = {}) =>
  app.inject({ method: 'POST', url: `/api${url}`, headers: { ...CSRF, cookie }, payload });
const me = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

/** Creates a group through the API; returns its creator's session cookie, member id and device id. */
async function createGroup(groupName = 'Plans') {
  const auth = createSoftAuthenticator({ origin: ORIGIN });
  const body = { groupName, label: 'Old phone' };
  const opts = (await app.inject({ method: 'POST', url: '/api/groups/options', headers: CSRF, payload: body })).json();
  const res = await app.inject({
    method: 'POST',
    url: '/api/groups',
    headers: CSRF,
    payload: { response: auth.register(opts) },
  });
  const view = res.json();
  return {
    cookie: cookieFrom(res, 'velvet_rope_session'),
    memberId: view.member.id,
    deviceId: view.device.id,
    group: view.group,
  };
}

/** A new device creates its request; the scanner claims it with `choice`. Returns the link cookie. */
async function scanned(scanner, choice, request = {}) {
  const made = await app.inject({
    method: 'POST',
    url: '/api/link-requests',
    headers: CSRF,
    payload: { label: 'New phone', ...request },
  });
  const link = cookieFrom(made, 'velvet_rope_link');
  const res = await post('/link-requests/claim', scanner, { token: made.json().token, ...choice });
  expect(res.statusCode).toBe(200);
  return link;
}

/** The new device registers a passkey and finishes. */
async function finish(link) {
  const opts = (await post('/link-requests/current/options', link)).json();
  const auth = createSoftAuthenticator({ origin: ORIGIN });
  return post('/link-requests/current/complete', link, { response: auth.register(opts) });
}

const liveDevices = (memberId) =>
  db
    .prepare('SELECT id FROM devices WHERE member_id = ? AND revoked_at IS NULL ORDER BY created_at, id')
    .all(memberId)
    .map((d) => d.id);
const isRevoked = (id) => db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get(id).revoked_at !== null;
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const requestStatus = () => db.prepare('SELECT status FROM link_requests').get().status;

describe('switching phones (own-device, signOut scanner)', () => {
  it('keeps the old phone signed in at the scan and signs it out when the new phone finishes', async () => {
    setup();
    const old = await createGroup();
    const link = await scanned(old.cookie, { outcome: 'own-device', signOut: 'scanner' });
    expect((await me(old.cookie)).statusCode).toBe(200);

    const done = await finish(link);
    expect(done.statusCode).toBe(201);
    expect((await me(old.cookie)).statusCode).toBe(401);
    expect(done.json().member.id).toBe(old.memberId);
    expect((await me(cookieFrom(done, 'velvet_rope_session'))).statusCode).toBe(200);
    expect(liveDevices(old.memberId)).toEqual([done.json().device.id]);
    expect(isRevoked(old.deviceId)).toBe(true);
    expect(count('members')).toBe(1);
  });

  it('tells the old phone its session is revoked and ends its streams, after the commit', async () => {
    setup();
    const old = await createGroup();
    const link = await scanned(old.cookie, { outcome: 'own-device', signOut: 'scanner' });
    expect(sent).toEqual([]);
    await finish(link);
    expect(sent).toEqual([{ event: 'session-revoked', deviceId: old.deviceId }, { disconnect: old.deviceId }]);
  });

  it('leaves the scanner live and adds no device when onDeviceRevoked vetoes', async () => {
    const onDeviceRevoked = vi.fn(() => {
      throw new Refusal(409, 'not_now', 'Not now');
    });
    setup({ onDeviceRevoked });
    const old = await createGroup();
    const link = await scanned(old.cookie, { outcome: 'own-device', signOut: 'scanner' });

    const res = await finish(link);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'not_now', message: 'Not now' });
    expect(onDeviceRevoked).toHaveBeenCalledOnce();
    expect((await me(old.cookie)).statusCode).toBe(200);
    expect(count('devices')).toBe(1);
    expect(requestStatus()).toBe('claimed');
    expect(sent).toEqual([]);
  });

  it('calls onDeviceRevoked with reason replaced', async () => {
    const onDeviceRevoked = vi.fn();
    setup({ onDeviceRevoked });
    const old = await createGroup('Plans');
    await finish(await scanned(old.cookie, { outcome: 'own-device', signOut: 'scanner' }));
    expect(onDeviceRevoked).toHaveBeenCalledOnce();
    expect(onDeviceRevoked.mock.calls[0][1]).toEqual({
      group: { id: old.group.id, name: 'Plans' },
      member: { id: old.memberId, name: 'Old phone', role: 'admin' },
      device: { id: old.deviceId, label: 'Old phone', kind: 'passkey' },
      reason: 'replaced',
    });
  });
});

describe('relinking a member (member, signOut others)', () => {
  it('signs out every old device of the member and gives them the new one', async () => {
    setup();
    const admin = await createGroup();
    const lost = addMember(db, { groupId: admin.group.id, role: 'viewer', now: clock.t });
    const second = addDevice(db, { memberId: lost.memberId, now: clock.t });
    const link = await scanned(admin.cookie, { outcome: 'member', memberId: lost.memberId, signOut: 'others' });

    const done = await finish(link);
    expect(done.statusCode).toBe(201);
    expect(done.json().member.id).toBe(lost.memberId);
    expect(liveDevices(lost.memberId)).toEqual([done.json().device.id]);
    expect(isRevoked(lost.deviceId)).toBe(true);
    expect(isRevoked(second.deviceId)).toBe(true);
    expect((await me(`velvet_rope_session=${lost.token}`)).statusCode).toBe(401);
    expect((await me(`velvet_rope_session=${second.token}`)).statusCode).toBe(401);
    expect((await me(cookieFrom(done, 'velvet_rope_session'))).json().member.id).toBe(lost.memberId);
    expect(
      sent
        .filter((s) => s.event)
        .map((s) => s.deviceId)
        .sort(),
    ).toEqual([lost.deviceId, second.deviceId].sort());
  });

  it('leaves the admin who scanned untouched', async () => {
    setup();
    const admin = await createGroup();
    const lost = addMember(db, { groupId: admin.group.id, role: 'viewer', now: clock.t });
    await finish(await scanned(admin.cookie, { outcome: 'member', memberId: lost.memberId, signOut: 'others' }));
    expect((await me(admin.cookie)).statusCode).toBe(200);
    expect(isRevoked(admin.deviceId)).toBe(false);
    expect(sent.some((s) => s.deviceId === admin.deviceId || s.disconnect === admin.deviceId)).toBe(false);
  });

  it('refuses when the member ended between the scan and the finish', async () => {
    setup();
    const admin = await createGroup();
    const lost = addMember(db, { groupId: admin.group.id, role: 'viewer', now: clock.t });
    const link = await scanned(admin.cookie, { outcome: 'member', memberId: lost.memberId, signOut: 'others' });
    db.prepare('UPDATE members SET ended_at = ?, ended_reason = ? WHERE id = ?').run(clock.t, 'removed', lost.memberId);

    const res = await finish(link);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('link_incomplete');
    expect(count('devices')).toBe(2);
    expect(requestStatus()).toBe('claimed');
  });
});

describe('adding a device (signOut none)', () => {
  it.each([
    ['own-device', () => ({ outcome: 'own-device', signOut: 'none' })],
    ['member', (admin, other) => ({ outcome: 'member', memberId: other.memberId, signOut: 'none' })],
  ])('keeps every device live for %s', async (_outcome, choose) => {
    setup();
    const admin = await createGroup();
    const other = addMember(db, { groupId: admin.group.id, role: 'viewer', now: clock.t });
    const choice = choose(admin, other);
    const owner = choice.outcome === 'member' ? other.memberId : admin.memberId;

    const done = await finish(await scanned(admin.cookie, choice));
    expect(done.statusCode).toBe(201);
    expect(liveDevices(owner)).toHaveLength(2);
    expect(done.json().member.id).toBe(owner);
    expect((await me(admin.cookie)).statusCode).toBe(200);
    expect((await me(`velvet_rope_session=${other.token}`)).statusCode).toBe(200);
    expect(sent).toEqual([]);
    expect(requestStatus()).toBe('completed');
  });
});

describe('onMemberCreated', () => {
  it('gets the group, the member and the parsed profile for a new member', async () => {
    const onMemberCreated = vi.fn();
    setup({ onMemberCreated, validateProfile: (p) => ({ colour: p.colour }) });
    const admin = await createGroup('Plans');
    onMemberCreated.mockClear();

    const link = await scanned(admin.cookie, { outcome: 'new-member' }, { name: 'Sam', profile: { colour: 'red' } });
    const done = await finish(link);
    expect(done.json().member.name).toBe('Sam');
    expect(onMemberCreated).toHaveBeenCalledOnce();
    expect(onMemberCreated.mock.calls[0][1]).toEqual({
      group: { id: admin.group.id, name: 'Plans' },
      member: { id: done.json().member.id, name: 'Sam', role: 'viewer' },
      profile: { colour: 'red' },
      via: 'link',
    });
  });

  it('names the member after the device when no name was given, with a null profile', async () => {
    const onMemberCreated = vi.fn();
    setup({ onMemberCreated });
    const admin = await createGroup();
    onMemberCreated.mockClear();
    const done = await finish(await scanned(admin.cookie, { outcome: 'new-member' }));
    expect(done.json().member.name).toBe('New phone');
    expect(onMemberCreated.mock.calls[0][1]).toMatchObject({ profile: null, via: 'link' });
  });

  it('runs at group creation with via create-group', async () => {
    const onMemberCreated = vi.fn();
    setup({ onMemberCreated });
    const admin = await createGroup('Plans');
    expect(onMemberCreated).toHaveBeenCalledOnce();
    expect(onMemberCreated.mock.calls[0][1]).toEqual({
      group: { id: admin.group.id, name: 'Plans' },
      member: { id: admin.memberId, name: 'Old phone', role: 'admin' },
      profile: null,
      via: 'create-group',
    });
  });

  it('is not called when a device is added to an existing member', async () => {
    const onMemberCreated = vi.fn();
    setup({ onMemberCreated });
    const admin = await createGroup();
    onMemberCreated.mockClear();
    await finish(await scanned(admin.cookie, { outcome: 'own-device', signOut: 'none' }));
    expect(onMemberCreated).not.toHaveBeenCalled();
  });

  it('leaves no member and no device when it vetoes, and the request stays claimed', async () => {
    let veto = false;
    setup({
      onMemberCreated: () => {
        if (veto) throw new Refusal(403, 'group_full', 'The group is full');
      },
    });
    const admin = await createGroup();
    veto = true;
    const link = await scanned(admin.cookie, { outcome: 'new-member' });

    const res = await finish(link);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'group_full', message: 'The group is full' });
    expect(count('members')).toBe(1);
    expect(count('devices')).toBe(1);
    expect(requestStatus()).toBe('claimed');
    expect(sent).toEqual([]);
  });
});

describe('onAudit at the finish', () => {
  it('rolls the join back when the audit hook vetoes', async () => {
    let veto = false;
    setup({
      onAudit: () => {
        if (veto) throw new Refusal(500, 'audit_down', 'Audit is down');
      },
    });
    const admin = await createGroup();
    veto = true;
    const res = await finish(await scanned(admin.cookie, { outcome: 'own-device', signOut: 'scanner' }));
    expect(res.statusCode).toBe(500);
    expect(count('devices')).toBe(1);
    expect((await me(admin.cookie)).statusCode).toBe(200);
    expect(requestStatus()).toBe('claimed');
  });
});
