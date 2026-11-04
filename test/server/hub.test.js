import { describe, it, expect, vi } from 'vitest';
import { createHub } from '../../src/server/hub.js';

describe('SSE hub', () => {
  it('delivers a published event to a subscriber of the group', () => {
    const hub = createHub();
    const send = vi.fn();
    hub.subscribe('group-a', send);
    hub.publish('group-a', 'file-changed', { path: 'plan.md' });
    expect(send).toHaveBeenCalledWith('file-changed', { path: 'plan.md' });
  });

  it('never delivers an event to a subscriber of another group', () => {
    const hub = createHub();
    const mine = vi.fn();
    const theirs = vi.fn();
    hub.subscribe('group-a', mine);
    hub.subscribe('group-b', theirs);
    hub.publish('group-a', 'file-changed', { path: 'plan.md' });
    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const hub = createHub();
    const send = vi.fn();
    const unsubscribe = hub.subscribe('group-a', send);
    unsubscribe();
    hub.publish('group-a', 'file-changed', { path: 'plan.md' });
    expect(send).not.toHaveBeenCalled();
    expect(hub.subscriberCount('group-a')).toBe(0);
  });

  it('keeps delivering to other subscribers when one throws', () => {
    const hub = createHub();
    const broken = vi.fn(() => {
      throw new Error('socket gone');
    });
    const fine = vi.fn();
    hub.subscribe('group-a', broken);
    hub.subscribe('group-a', fine);
    hub.publish('group-a', 'file-changed', { path: 'plan.md' });
    expect(fine).toHaveBeenCalledTimes(1);
  });

  describe('per-device targeting', () => {
    it('delivers publishTo only to that device’s subscribers', () => {
      const hub = createHub();
      const mine = vi.fn();
      const sameStore = vi.fn();
      hub.subscribe('group-a', mine, { deviceId: 'dev-1' });
      hub.subscribe('group-a', sameStore, { deviceId: 'dev-2' });
      hub.publishTo('dev-1', 'session-revoked', {});
      expect(mine).toHaveBeenCalledWith('session-revoked', {});
      expect(sameStore).not.toHaveBeenCalled();
    });

    it('still delivers group events to device-tagged subscribers', () => {
      const hub = createHub();
      const send = vi.fn();
      hub.subscribe('group-a', send, { deviceId: 'dev-1' });
      hub.publish('group-a', 'members-changed', {});
      expect(send).toHaveBeenCalledWith('members-changed', {});
    });

    it('disconnect ends only that device’s streams and drops them', () => {
      const hub = createHub();
      const ends = { mine: vi.fn(), other: vi.fn() };
      let unsubMine;
      ends.mine.mockImplementation(() => unsubMine());
      unsubMine = hub.subscribe('group-a', vi.fn(), { deviceId: 'dev-1', end: ends.mine });
      hub.subscribe('group-a', vi.fn(), { deviceId: 'dev-2', end: ends.other });
      hub.disconnect('dev-1');
      expect(ends.mine).toHaveBeenCalledTimes(1);
      expect(ends.other).not.toHaveBeenCalled();
      expect(hub.subscriberCount('group-a')).toBe(1);
    });

    it('stops targeting a device subscriber after unsubscribe', () => {
      const hub = createHub();
      const send = vi.fn();
      const unsubscribe = hub.subscribe('group-a', send, { deviceId: 'dev-1' });
      unsubscribe();
      hub.publishTo('dev-1', 'role-changed', { role: 'admin' });
      expect(send).not.toHaveBeenCalled();
    });
  });
});
