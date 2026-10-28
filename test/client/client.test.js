// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createApi, VelvetRopeError } from '../../src/client/api.js';
import { createClient } from '../../src/client/client.js';

function fakeTransport() {
  return {
    getJson: vi.fn(async () => ({})),
    postJson: vi.fn(async () => ({ challenge: 'c' })),
    patchJson: vi.fn(async () => ({})),
    deleteJson: vi.fn(async () => null),
    startRegistration: vi.fn(async () => ({ id: 'registered' })),
    startAuthentication: vi.fn(async () => ({ id: 'asserted' })),
  };
}

describe('createClient', () => {
  it('calls the plugin’s routes under the prefix', async () => {
    const t = fakeTransport();
    const client = createClient({ prefix: '/v1', ...t });
    await client.claimLink('tok');
    await client.listMembers();
    await client.updateMember('a/b', { role: 'viewer' });
    await client.removeMember('p1');
    await client.leaveGroup();
    await client.deleteGroup('Plans');
    expect(t.postJson).toHaveBeenCalledWith('/v1/link-requests/claim', { token: 'tok' });
    expect(t.getJson).toHaveBeenCalledWith('/v1/members');
    expect(t.patchJson).toHaveBeenCalledWith('/v1/members/a%2Fb', { role: 'viewer' });
    expect(t.deleteJson).toHaveBeenCalledWith('/v1/members/p1');
    expect(t.postJson).toHaveBeenCalledWith('/v1/members/leave', {});
    expect(t.deleteJson).toHaveBeenCalledWith('/v1/group', { name: 'Plans' });
    expect(client.eventsUrl).toBe('/v1/events');
  });

  it('runs the passkey ceremonies between the option and verify calls', async () => {
    const t = fakeTransport();
    const client = createClient(t);
    await client.signIn();
    expect(t.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } });
    expect(t.postJson).toHaveBeenLastCalledWith('/api/auth', { response: { id: 'asserted' } });

    await client.createGroup({ groupName: 'Plans', label: 'Phone' });
    expect(t.postJson).toHaveBeenCalledWith('/api/groups/options', {
      groupName: 'Plans',
      label: 'Phone',
    });
    expect(t.postJson).toHaveBeenLastCalledWith('/api/groups', { response: { id: 'registered' } });

    await client.completeJoin();
    expect(t.postJson).toHaveBeenLastCalledWith('/api/link-requests/current/complete', {
      response: { id: 'registered' },
    });
  });

  it('sends an invite code only when there is one', async () => {
    const t = fakeTransport();
    await createClient(t).createGroup({ groupName: 'Plans', label: 'Phone', invite: 'code' });
    expect(t.postJson).toHaveBeenCalledWith('/api/groups/options', {
      groupName: 'Plans',
      label: 'Phone',
      invite: 'code',
    });
  });

  it('getMe answers null when signed out and throws anything else', async () => {
    const t = fakeTransport();
    t.getJson.mockRejectedValueOnce(Object.assign(new Error('no'), { status: 401 }));
    expect(await createClient(t).getMe()).toBeNull();
    t.getJson.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 502 }));
    await expect(createClient(t).getMe()).rejects.toThrow('down');
  });
});

describe('createApi', () => {
  it('sends JSON and the CSRF header on writes', async () => {
    const fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const api = createApi({ csrfHeader: 'X-Notes', fetch });
    expect(await api.postJson('/api/x', { a: 1 })).toEqual({ ok: true });
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe('/api/x');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Notes']).toBe('1');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('throws the server’s code and message', async () => {
    const body = JSON.stringify({ error: 'link_expired', message: 'This join code has expired.' });
    const fetch = vi.fn(async () => new Response(body, { status: 410 }));
    const error = await createApi({ fetch })
      .postJson('/api/link-requests/claim', {})
      .catch((e) => e);
    expect(error).toBeInstanceOf(VelvetRopeError);
    expect(error).toMatchObject({
      status: 410,
      code: 'link_expired',
      message: 'This join code has expired.',
    });
  });
});
