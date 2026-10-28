// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { connectSessionEvents } from '../../src/client/session-events.js';

function fakeSource() {
  const listeners = {};
  return {
    close: vi.fn(),
    addEventListener: (type, fn) => (listeners[type] ??= new Set()).add(fn),
    removeEventListener: (type, fn) => listeners[type]?.delete(fn),
    emit: (type, data) => {
      for (const fn of listeners[type] ?? []) fn({ data: JSON.stringify(data) });
    },
  };
}

describe('connectSessionEvents', () => {
  it('passes each velvet-rope event to its handler', () => {
    const source = fakeSource();
    const handlers = {
      onMembersChanged: vi.fn(),
      onRoleChanged: vi.fn(),
      onRevoked: vi.fn(),
      onGroupDeleted: vi.fn(),
    };
    connectSessionEvents(source, handlers);
    source.emit('members-changed', {});
    source.emit('role-changed', { role: 'collaborator' });
    expect(handlers.onMembersChanged).toHaveBeenCalledOnce();
    expect(handlers.onRoleChanged).toHaveBeenCalledWith('collaborator');
    expect(source.close).not.toHaveBeenCalled();
  });

  it('closes the stream on session-revoked and group-deleted, so it doesn’t retry into a 401', () => {
    const revoked = fakeSource();
    const onRevoked = vi.fn();
    connectSessionEvents(revoked, { onRevoked });
    revoked.emit('session-revoked', {});
    expect(revoked.close).toHaveBeenCalled();
    expect(onRevoked).toHaveBeenCalled();

    const deleted = fakeSource();
    const onGroupDeleted = vi.fn();
    connectSessionEvents(deleted, { onGroupDeleted });
    deleted.emit('group-deleted', { name: 'Plans' });
    expect(deleted.close).toHaveBeenCalled();
    expect(onGroupDeleted).toHaveBeenCalledWith({ name: 'Plans' });
  });

  it('ignores a role-changed event without a role, and stops when asked', () => {
    const source = fakeSource();
    const onRoleChanged = vi.fn();
    const stop = connectSessionEvents(source, { onRoleChanged });
    source.emit('role-changed', {});
    stop();
    source.emit('role-changed', { role: 'admin' });
    expect(onRoleChanged).not.toHaveBeenCalled();
  });
});
