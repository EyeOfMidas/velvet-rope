import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInvite } from '../../src/server/invites.js';
import { addMember, createSession } from '../../src/testing/members.js';
import { saveChallenge } from '../../src/server/challenges.js';
import { startSweeper, sweepExpired } from '../../src/server/sweep.js';
import { openDb } from './harness.js';
import { SESSION_TTL_MS } from '../../src/domain/index.js';

const T = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

function seed() {
  const db = openDb(':memory:');
  const groupId = randomUUID();
  db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(groupId, 'S', T);
  const { deviceId } = addMember(db, { groupId, role: 'admin', now: T });
  db.prepare('DELETE FROM sessions').run(); // each test makes the sessions it sweeps
  return { db, deviceId };
}

describe('sweepExpired', () => {
  it('deletes expired sessions and keeps live ones', () => {
    const { db, deviceId } = seed();
    createSession(db, deviceId, T); // expires at T + 30 days
    createSession(db, deviceId, T + 10 * DAY);

    const swept = sweepExpired(db, T + SESSION_TTL_MS);
    expect(swept.sessions).toBe(1);
    expect(count(db, 'sessions')).toBe(1);
  });

  it('also deletes expired challenges, link requests and invites', () => {
    const { db } = seed();
    saveChallenge(db, { challenge: 'old', purpose: 'sign-in', data: {}, now: T });
    db.prepare(
      `INSERT INTO link_requests (id, token_hash, label, status, created_at, expires_at)
       VALUES (?, 'h', 'Desktop', 'pending', ?, ?)`,
    ).run(randomUUID(), T, T + 5 * 60 * 1000);
    createInvite(db, T);
    createInvite(db, T + 7 * DAY);

    expect(sweepExpired(db, T + 7 * DAY)).toEqual({
      sessions: 0,
      challenges: 1,
      linkRequests: 1,
      invites: 1,
    });
    expect(count(db, 'challenges')).toBe(0);
    expect(count(db, 'link_requests')).toBe(0);
    expect(count(db, 'invites')).toBe(1);
  });
});

describe('startSweeper', () => {
  afterEach(() => vi.useRealTimers());

  it('sweeps at once and then on every interval until stopped', () => {
    vi.useFakeTimers();
    const { db, deviceId } = seed();
    const clock = { t: T };
    createSession(db, deviceId, T - SESSION_TTL_MS); // already expired
    const stop = startSweeper(db, { now: () => clock.t, intervalMs: 1000 });
    expect(count(db, 'sessions')).toBe(0);

    createSession(db, deviceId, T - SESSION_TTL_MS + 500);
    clock.t += 1000;
    vi.advanceTimersByTime(1000);
    expect(count(db, 'sessions')).toBe(0);

    stop();
    createSession(db, deviceId, T - SESSION_TTL_MS + 500);
    vi.advanceTimersByTime(5000);
    expect(count(db, 'sessions')).toBe(1);
  });
});
