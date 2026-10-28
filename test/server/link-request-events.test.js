// GET /api/link-requests/current/events: the new device's status stream. Like the
// /api/events tests, these start a real listener and read the stream with fetch.
import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, openDb } from './harness.js';
import { createSoftAuthenticator } from '../../src/testing/soft-authenticator.js';

const ORIGIN = 'http://localhost:5173';
const config = { rpId: 'localhost', rpName: 'Test app', origin: ORIGIN };
const CSRF = { 'content-type': 'application/json', 'x-velvet-rope': '1' };
const MINUTE = 60 * 1000;

let app;
let base;
let clock;
const streams = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.abort();
  await app?.close();
});

async function setup({ heartbeatMs } = {}) {
  clock = { t: 1_700_000_000_000 };
  app = buildApp({ db: openDb(':memory:'), now: () => clock.t, config, heartbeatMs });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
}

function cookieFrom(res, name) {
  return [res.headers['set-cookie']]
    .flat()
    .find((c) => c?.startsWith(`${name}=`))
    ?.split(';')[0];
}

async function createGroup(groupName) {
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
  return cookieFrom(res, 'velvet_rope_session');
}

async function newDevice(label = 'Desktop') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/link-requests',
    headers: CSRF,
    payload: { label },
  });
  return { token: res.json().token, link: cookieFrom(res, 'velvet_rope_link') };
}

const claim = (cookie, token) =>
  app.inject({
    method: 'POST',
    url: '/api/link-requests/claim',
    headers: { ...CSRF, cookie },
    payload: { token },
  });

async function linkDesktop(link) {
  const desktop = createSoftAuthenticator({ origin: ORIGIN });
  const options = await app.inject({
    method: 'POST',
    url: '/api/link-requests/current/options',
    headers: { ...CSRF, cookie: link },
    payload: {},
  });
  return app.inject({
    method: 'POST',
    url: '/api/link-requests/current/complete',
    headers: { ...CSRF, cookie: link },
    payload: { response: desktop.register(options.json()) },
  });
}

/** Opens an event stream and returns helpers to wait for text and parse events. */
async function openStream(path, cookie) {
  const controller = new AbortController();
  const res = await fetch(`${base}${path}`, {
    headers: cookie ? { cookie } : {},
    signal: controller.signal,
  });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  const stream = {
    res,
    abort: () => controller.abort(),
    get text() {
      return text;
    },
    async waitFor(predicate, ms = 2000) {
      const deadline = Date.now() + ms;
      while (!predicate(text)) {
        if (Date.now() > deadline) throw new Error(`timed out; stream so far: ${text}`);
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream ended; got: ${text}`);
        text += value;
      }
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
  return stream;
}

const statusStream = async (link) => {
  const stream = await openStream('/api/link-requests/current/events', link);
  await stream.waitFor((t) => t.includes('event: status'));
  return stream;
};

describe('GET /api/link-requests/current/events', () => {
  it('404s without a link cookie', async () => {
    await setup();
    const res = await fetch(`${base}/api/link-requests/current/events`);
    expect(res.status).toBe(404);
  });

  it('sends the current status at once, with headers nginx will not buffer', async () => {
    await setup();
    const { link } = await newDevice();
    const stream = await statusStream(link);
    expect(stream.res.headers.get('content-type')).toBe('text/event-stream');
    expect(stream.res.headers.get('x-accel-buffering')).toBe('no');
    expect(stream.events()).toEqual([
      { event: 'status', data: { status: 'pending', expiresAt: clock.t + 5 * MINUTE } },
    ]);
  });

  it('sends claimed when a scanner claims, then completed', async () => {
    await setup();
    const creator = await createGroup('Plans');
    const { token, link } = await newDevice();
    const stream = await statusStream(link);

    await claim(creator, token);
    await stream.waitFor((t) => t.includes('"claimed"'));
    await linkDesktop(link);
    await stream.waitFor((t) => t.includes('"completed"'));

    expect(stream.events().map((e) => e.data)).toEqual([
      { status: 'pending', expiresAt: clock.t + 5 * MINUTE },
      { status: 'claimed', expiresAt: clock.t + 5 * MINUTE, groupName: 'Plans' },
      { status: 'completed', expiresAt: clock.t + 5 * MINUTE, groupName: 'Plans' },
    ]);
    expect(stream.text).not.toContain(token);
  });

  it('sends a heartbeat comment', async () => {
    await setup({ heartbeatMs: 20 });
    const { link } = await newDevice();
    const stream = await statusStream(link);
    await stream.waitFor((t) => t.includes(': heartbeat'));
  });

  it('keeps each request’s status to its own stream', async () => {
    await setup();
    const alice = await createGroup('Alice');
    const bob = await createGroup('Bob');
    const mine = await newDevice('Mine');
    const other = await newDevice('Other');
    const otherStream = await statusStream(other.link);
    const myStream = await statusStream(mine.link);

    await claim(alice, mine.token);
    await myStream.waitFor((t) => t.includes('"claimed"'));
    await claim(bob, other.token);
    await otherStream.waitFor((t) => t.includes('"Bob"'));

    expect(otherStream.events().map((e) => [e.data.status, e.data.groupName])).toEqual([
      ['pending', undefined],
      ['claimed', 'Bob'],
    ]);
  });
});

describe('group subscribers during linking', () => {
  it('never get link-request status events, only members-changed', async () => {
    await setup();
    const creator = await createGroup('Plans');
    const storeStream = await openStream('/api/events', creator);
    await storeStream.waitFor((t) => t.includes(': connected'));
    const { token, link } = await newDevice('Firefox on Windows');

    await claim(creator, token);
    const done = await linkDesktop(link);
    await storeStream.waitFor((t) => t.includes('event: members-changed'));

    expect(storeStream.events()).toEqual([
      {
        event: 'members-changed',
        data: { id: done.json().passkey.id, label: 'Firefox on Windows' },
      },
    ]);
    expect(storeStream.text).not.toContain(token);
  });
});
