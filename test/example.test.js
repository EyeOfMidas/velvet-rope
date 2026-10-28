// The example app's notes routes: view, edit and delete follow the roles, and every query stays
// in the session's group.
import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, openDb } from '../example/app.js';
import { addMember } from '../src/testing/members.js';

const HEADERS = { 'content-type': 'application/json', 'x-notes': '1' };

let app;
let db;
afterEach(() => app?.close());

function setup() {
  db = openDb();
  app = buildApp({ db });
  const group = (id) => db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, 0)').run(id, id);
  group('home');
  group('work');
  const member = (role, groupId = 'home') => {
    const { id, token } = addMember(db, { groupId, role });
    return { id, cookie: `notes_session=${token}` };
  };
  return { member };
}

const send = (method, url, cookie, payload) =>
  app.inject({
    method,
    url,
    headers: { ...HEADERS, cookie },
    ...(method === 'GET' ? {} : { payload: payload ?? {} }),
  });

describe('example notes', () => {
  it('lets anyone in the group read, and nobody outside it', async () => {
    const { member } = setup();
    const writer = member('contributor');
    await send('POST', '/api/notes', writer.cookie, { text: 'Milk' });

    const viewer = member('viewer');
    expect((await send('GET', '/api/notes', viewer.cookie)).json()).toMatchObject([{ text: 'Milk' }]);
    const outsider = member('admin', 'work');
    expect((await send('GET', '/api/notes', outsider.cookie)).json()).toEqual([]);
    expect((await send('GET', '/api/notes', '')).statusCode).toBe(401);
  });

  it('lets viewers read but not write', async () => {
    const { member } = setup();
    const res = await send('POST', '/api/notes', member('viewer').cookie, { text: 'Eggs' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
  });

  it('lets a contributor edit only their own notes', async () => {
    const { member } = setup();
    const alice = member('contributor');
    const bob = member('contributor');
    const { id } = (await send('POST', '/api/notes', alice.cookie, { text: 'Milk' })).json();

    expect((await send('PUT', `/api/notes/${id}`, bob.cookie, { text: 'Beer' })).statusCode).toBe(403);
    expect((await send('PUT', `/api/notes/${id}`, alice.cookie, { text: 'Oat milk' })).statusCode).toBe(200);
    expect((await send('PUT', `/api/notes/${id}`, member('collaborator').cookie, { text: 'Milk' })).statusCode).toBe(
      200,
    );
  });

  it('lets collaborators and admins delete, and contributors not', async () => {
    const { member } = setup();
    const author = member('contributor');
    const note = async () => (await send('POST', '/api/notes', author.cookie, { text: 'x' })).json().id;

    expect((await send('DELETE', `/api/notes/${await note()}`, author.cookie)).statusCode).toBe(403);
    expect((await send('DELETE', `/api/notes/${await note()}`, member('collaborator').cookie)).statusCode).toBe(204);
    expect((await send('DELETE', `/api/notes/${await note()}`, member('admin').cookie)).statusCode).toBe(204);
  });

  it('can’t touch another group’s note, even with the right role', async () => {
    const { member } = setup();
    const { id } = (await send('POST', '/api/notes', member('admin').cookie, { text: 'Home' })).json();
    const other = member('admin', 'work');
    expect((await send('PUT', `/api/notes/${id}`, other.cookie, { text: 'Mine' })).statusCode).toBe(404);
    expect((await send('DELETE', `/api/notes/${id}`, other.cookie)).statusCode).toBe(404);
  });
});
