// Live effects of passkey management: a revoked passkey's open streams get
// session-revoked and end; everyone else in the group gets members-changed. Real listener,
// streams read with fetch (SSE is awkward through fastify.inject).
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp, openDb } from './harness.js';
import { createSession } from '../../src/testing/members.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const ORIGIN = 'http://localhost:5173';
const config = { rpId: 'localhost', rpName: 'Test app', origin: ORIGIN };
const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };

let app;
let db;
let base;
const streams = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.abort();
  await app?.close();
});

async function setup() {
  db = openDb(':memory:');
  app = buildApp({ db, config });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
}

const me = (cookie) => app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

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
  const cookie = [res.headers['set-cookie']]
    .flat()
    .find((c) => c?.startsWith('velvet_rope_session='))
    .split(';')[0];
  const { passkey, group } = (await me(cookie)).json();
  return { id: passkey.id, cookie, groupId: group.id };
}

function insertMember(groupId, role) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO passkeys (id, group_id, label, role, user_handle, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, groupId, `${role} device`, role, randomUUID(), Date.now());
  return { id, cookie: `velvet_rope_session=${createSession(db, id, Date.now())}` };
}

const send = (method, url, cookie, payload = {}) => app.inject({ method, url, headers: { ...CSRF, cookie }, payload });

async function openStream(cookie) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: controller.signal });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  let done = false;
  const read = async (deadline) => {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timed out; stream so far: ${text}`)), deadline - Date.now()),
    );
    const chunk = await Promise.race([reader.read(), timeout]);
    if (chunk.done) done = true;
    else text += chunk.value;
  };
  const stream = {
    abort: () => controller.abort(),
    get text() {
      return text;
    },
    async waitFor(predicate, ms = 2000) {
      const deadline = Date.now() + ms;
      while (!predicate(text)) {
        if (done) throw new Error(`stream ended; got: ${text}`);
        await read(deadline);
      }
    },
    async waitForEnd(ms = 2000) {
      const deadline = Date.now() + ms;
      while (!done) await read(deadline);
    },
    events() {
      return text
        .split('\n\n')
        .map((block) => {
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          return event ? { event, data: JSON.parse(data) } : null;
        })
        .filter(Boolean);
    },
  };
  streams.push(stream);
  await stream.waitFor((t) => t.includes(': connected'));
  return stream;
}

describe('passkey events', () => {
  it('a revoked passkey’s stream gets session-revoked and ends; others only see members-changed', async () => {
    await setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const creatorStream = await openStream(creator.cookie);
    const viewerStream = await openStream(viewer.cookie);

    expect((await send('DELETE', `/api/members/${viewer.id}`, creator.cookie)).statusCode).toBe(204);

    await viewerStream.waitFor((t) => t.includes('event: session-revoked'));
    await viewerStream.waitForEnd();
    expect(viewerStream.events()).toContainEqual({ event: 'session-revoked', data: {} });

    await creatorStream.waitFor((t) => t.includes('event: members-changed'));
    expect(creatorStream.events()).toEqual([{ event: 'members-changed', data: {} }]);
    expect(app.hub.subscriberCount(creator.groupId)).toBe(1);
  });

  it('leaving ends the leaver’s own streams and tells the rest of the group', async () => {
    await setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const creatorStream = await openStream(creator.cookie);
    const viewerStream = await openStream(viewer.cookie);

    expect((await send('POST', '/api/members/leave', viewer.cookie)).statusCode).toBe(204);

    await viewerStream.waitFor((t) => t.includes('event: session-revoked'));
    await viewerStream.waitForEnd();
    await creatorStream.waitFor((t) => t.includes('event: members-changed'));
    expect(creatorStream.events().map((e) => e.event)).toEqual(['members-changed']);
  });

  it('a role change tells only that passkey its new role, and the group that passkeys changed', async () => {
    await setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const other = insertMember(creator.groupId, 'viewer');
    const viewerStream = await openStream(viewer.cookie);
    const otherStream = await openStream(other.cookie);

    await send('PATCH', `/api/members/${viewer.id}`, creator.cookie, { role: 'contributor' });

    await viewerStream.waitFor((t) => t.includes('event: role-changed'));
    await viewerStream.waitFor((t) => t.includes('event: members-changed'));
    expect(viewerStream.events()).toContainEqual({
      event: 'role-changed',
      data: { role: 'contributor' },
    });
    await otherStream.waitFor((t) => t.includes('event: members-changed'));
    expect(otherStream.events()).toEqual([{ event: 'members-changed', data: {} }]);
  });

  it('a rename tells the group that passkeys changed', async () => {
    await setup();
    const creator = await createGroup();
    const viewer = insertMember(creator.groupId, 'viewer');
    const viewerStream = await openStream(viewer.cookie);

    await send('PATCH', `/api/members/${viewer.id}`, creator.cookie, { label: 'Laptop' });

    await viewerStream.waitFor((t) => t.includes('event: members-changed'));
    expect(viewerStream.events()).toEqual([{ event: 'members-changed', data: {} }]);
  });
});
