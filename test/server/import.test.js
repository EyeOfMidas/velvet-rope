// Proof of docs/importing.md: builds a small book-club database, runs the exact SQL from the guide
// (read from the doc, so the two can't drift), and checks that a phone carrying its old cookie is
// still signed in as the same person, with nothing new on the wire.
import { describe, it, expect, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildApp } from './harness.js';
import { migrate, openDatabase } from '../../src/server/index.js';

const NOW = 1_700_000_000_000;
const COOKIE_NAME = 'club_device';
const KEY_TTL_MS = 400 * 24 * 60 * 60 * 1000;

const guide = readFileSync(new URL('../../docs/importing.md', import.meta.url), 'utf8');
const recipe = /```sql\n([\s\S]*?)```/.exec(guide)?.[1];

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const cookies = { ada: randomBytes(32).toString('base64url'), bo: randomBytes(32).toString('base64url') };
cookies.adaPhone = randomBytes(32).toString('base64url');
cookies.dee = randomBytes(32).toString('base64url');

let app;
let db;
afterEach(() => app?.close());

/** The old app's tables, in the shape the guide's worked example assumes. */
function createOldApp(db) {
  db.exec(`
    CREATE TABLE clubs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE readers (
      id TEXT PRIMARY KEY, club_id TEXT NOT NULL REFERENCES clubs(id), name TEXT NOT NULL,
      role TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'member', 'former')),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE reader_devices (
      id TEXT PRIMARY KEY, reader_id TEXT NOT NULL REFERENCES readers(id), name TEXT NOT NULL,
      cookie_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
    );
  `);
  const club = db.prepare('INSERT INTO clubs VALUES (?, ?, ?)');
  club.run('c1', 'Tuesday Readers', 1000);
  club.run('c2', 'Sci-Fi Circle', 2000);
  const reader = db.prepare('INSERT INTO readers VALUES (?, ?, ?, ?, ?, ?)');
  reader.run('r1', 'c1', 'Ada', 'admin', 'member', 1100);
  reader.run('r2', 'c1', 'Bo', 'viewer', 'member', 1200);
  reader.run('r3', 'c1', 'Cy', 'viewer', 'former', 1300);
  reader.run('r4', 'c1', 'Eve', 'viewer', 'pending', 1400);
  reader.run('r5', 'c2', 'Dee', 'admin', 'member', 2100);
  const device = db.prepare('INSERT INTO reader_devices VALUES (?, ?, ?, ?, ?)');
  device.run('d1', 'r1', 'Ada laptop', sha256(cookies.ada), 1150);
  device.run('d2', 'r1', 'Ada phone', sha256(cookies.adaPhone), 1160);
  device.run('d3', 'r2', 'Bo phone', sha256(cookies.bo), 1250);
  device.run('d4', 'r3', 'Cy phone', sha256('cy-old-cookie'), 1350);
  device.run('d5', 'r5', 'Dee phone', sha256(cookies.dee), 2150);
}

function importAndStart() {
  db = openDatabase(':memory:', { driver: process.env.VELVET_ROPE_DRIVER || undefined });
  db.pragma('foreign_keys = ON');
  createOldApp(db);
  migrate(db);
  db.exec(recipe);
  app = buildApp({
    db,
    now: () => NOW,
    sessionCookieName: COOKIE_NAME,
    credentials: ['passkey', 'key'],
  });
}

const get = (url, cookie) =>
  app.inject({ method: 'GET', url: `/api${url}`, headers: cookie ? { cookie: `${COOKIE_NAME}=${cookie}` } : {} });

describe('importing from an existing app', () => {
  it('has a SQL recipe in the guide', () => {
    expect(recipe).toBeTruthy();
  });

  it('keeps a phone signed in as the same member, role and group', async () => {
    importAndStart();
    const res = await get('/me', cookies.bo);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.member).toMatchObject({ id: 'r2', name: 'Bo', role: 'viewer' });
    expect(body.group).toMatchObject({ id: 'c1', name: 'Tuesday Readers' });
    expect(body.device).toMatchObject({ id: 'd3', label: 'Bo phone', kind: 'key' });

    const other = (await get('/me', cookies.dee)).json();
    expect(other.member).toMatchObject({ id: 'r5', role: 'admin' });
    expect(other.group.id).toBe('c2');
  });

  it('keeps every device of a member signed in, and expires them after the key lifetime', async () => {
    importAndStart();
    expect((await get('/me', cookies.ada)).json().device.id).toBe('d1');
    expect((await get('/me', cookies.adaPhone)).json().device.id).toBe('d2');
    const expiry = db.prepare('SELECT expires_at FROM sessions WHERE device_id = ?').pluck().get('d3');
    expect(expiry).toBeGreaterThanOrEqual(KEY_TTL_MS + NOW - 60_000);
  });

  it('imports former readers as ended members, so their ids stay taken, and they cannot sign in', async () => {
    importAndStart();
    const cy = db.prepare('SELECT * FROM members WHERE id = ?').get('r3');
    expect(cy).toMatchObject({ group_id: 'c1', name: 'Cy', ended_reason: 'removed' });
    expect(cy.ended_at).toBeGreaterThan(0);
    expect((await get('/me', 'cy-old-cookie')).statusCode).toBe(401);
    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(4);
  });

  it('does not import pending readers', () => {
    importAndStart();
    expect(db.prepare('SELECT * FROM members WHERE id = ?').get('r4')).toBeUndefined();
  });

  it('preserves group, member and device ids', () => {
    importAndStart();
    const ids = (sql) => db.prepare(sql).pluck().all();
    expect(ids('SELECT id FROM groups ORDER BY id')).toEqual(['c1', 'c2']);
    expect(ids('SELECT id FROM members ORDER BY id')).toEqual(['r1', 'r2', 'r3', 'r5']);
    expect(ids('SELECT id FROM devices ORDER BY id')).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
  });

  it('lists the right people on the members route', async () => {
    importAndStart();
    const list = (await get('/members', cookies.ada)).json();
    expect(list.map((m) => m.name)).toEqual(['Ada', 'Bo']);
    expect(list.find((m) => m.name === 'Ada').devices).toHaveLength(2);
  });
});
