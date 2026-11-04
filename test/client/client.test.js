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

describe('createClient signOut', () => {
  it('resolves forgotDevice for both replies', async () => {
    const t = fakeTransport();
    const client = createClient({ ...t });
    t.postJson.mockResolvedValueOnce({ forgotDevice: true });
    expect(await client.signOut()).toEqual({ forgotDevice: true });
    t.postJson.mockResolvedValueOnce(null);
    expect(await client.signOut()).toEqual({ forgotDevice: false });
  });
});

describe('createClient', () => {
  it('calls the plugin’s routes under the prefix', async () => {
    const t = fakeTransport();
    const client = createClient({ prefix: '/v1', ...t });
    await client.claimLink('tok', { outcome: 'member', memberId: 'm1', signOut: 'others' });
    await client.peekLink('tok');
    await client.renewJoin();
    await client.listMembers();
    await client.updateMember('a/b', { role: 'viewer' });
    await client.updateMember('p1', { name: 'Sam' });
    await client.removeMember('p1');
    await client.updateDevice('d/1', { label: 'Tablet' });
    await client.removeDevice('d/1');
    await client.leaveGroup();
    await client.deleteGroup('Plans');
    expect(t.postJson).toHaveBeenCalledWith('/v1/link-requests/claim', {
      token: 'tok',
      outcome: 'member',
      memberId: 'm1',
      signOut: 'others',
    });
    expect(t.postJson).toHaveBeenCalledWith('/v1/link-requests/peek', { token: 'tok' });
    expect(t.postJson).toHaveBeenCalledWith('/v1/link-requests/current/renew', {});
    expect(t.getJson).toHaveBeenCalledWith('/v1/members');
    expect(t.patchJson).toHaveBeenCalledWith('/v1/members/a%2Fb', { role: 'viewer' });
    expect(t.patchJson).toHaveBeenCalledWith('/v1/members/p1', { name: 'Sam' });
    expect(t.deleteJson).toHaveBeenCalledWith('/v1/members/p1');
    expect(t.patchJson).toHaveBeenCalledWith('/v1/devices/d%2F1', { label: 'Tablet' });
    expect(t.deleteJson).toHaveBeenCalledWith('/v1/devices/d%2F1');
    expect(t.postJson).toHaveBeenCalledWith('/v1/members/leave', {});
    expect(t.deleteJson).toHaveBeenCalledWith('/v1/group', { name: 'Plans' });
    expect(client.eventsUrl).toBe('/v1/events');
  });

  it('sends a join request as an object, or from a plain label', async () => {
    const t = fakeTransport();
    const client = createClient(t);
    await client.requestJoin({ label: 'Phone', name: 'Sam', profile: { a: 1 } });
    expect(t.postJson).toHaveBeenLastCalledWith('/api/link-requests', {
      label: 'Phone',
      name: 'Sam',
      profile: { a: 1 },
    });
    await client.requestJoin('Laptop');
    expect(t.postJson).toHaveBeenLastCalledWith('/api/link-requests', { label: 'Laptop' });
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

  it('posts to complete-key to join with a device key, with no ceremony', async () => {
    const t = fakeTransport();
    await createClient(t).completeJoinWithKey();
    expect(t.postJson).toHaveBeenCalledWith('/api/link-requests/current/complete-key', {});
    expect(t.startRegistration).not.toHaveBeenCalled();
  });

  it('upgradeToPasskey asks for options, registers a passkey here, and posts it', async () => {
    const t = fakeTransport();
    await createClient(t).upgradeToPasskey();
    expect(t.postJson).toHaveBeenNthCalledWith(1, '/api/devices/current/passkey/options', {});
    expect(t.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } });
    expect(t.postJson).toHaveBeenNthCalledWith(2, '/api/devices/current/passkey', { response: { id: 'registered' } });
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

  it('createGroupWithKey posts the details in one step, leaving out what is missing', async () => {
    const t = fakeTransport();
    const client = createClient(t);
    await client.createGroupWithKey({ groupName: 'Plans', label: 'Kiosk' });
    expect(t.postJson).toHaveBeenLastCalledWith('/api/groups/key', { groupName: 'Plans', label: 'Kiosk' });
    await client.createGroupWithKey({
      groupName: 'Plans',
      label: 'Kiosk',
      name: 'Ada',
      profile: { colour: 'red' },
      invite: 'code',
    });
    expect(t.postJson).toHaveBeenLastCalledWith('/api/groups/key', {
      groupName: 'Plans',
      label: 'Kiosk',
      name: 'Ada',
      profile: { colour: 'red' },
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

describe('signIn when the passkey was removed', () => {
  const removed = () => new VelvetRopeError(401, 'removed', 'gone');
  const setup = () => {
    const t = fakeTransport();
    t.postJson = vi.fn(async (path) => {
      if (path === '/api/auth') throw removed();
      return { challenge: 'c', rpId: 'example.test' };
    });
    return t;
  };

  it('tells the browser to forget the passkey, and still rejects', async () => {
    const signal = vi.fn(async () => {});
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential: signal });
    try {
      await expect(createClient(setup()).signIn()).rejects.toMatchObject({ code: 'removed' });
      expect(signal).toHaveBeenCalledWith({ rpId: 'example.test', credentialId: 'asserted' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects the same way when the call is missing or throws', async () => {
    try {
      vi.stubGlobal('PublicKeyCredential', {});
      await expect(createClient(setup()).signIn()).rejects.toMatchObject({ code: 'removed' });
      vi.stubGlobal('PublicKeyCredential', {
        signalUnknownCredential: async () => {
          throw new Error('nope');
        },
      });
      await expect(createClient(setup()).signIn()).rejects.toMatchObject({ code: 'removed' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not signal for other refusals', async () => {
    const signal = vi.fn(async () => {});
    vi.stubGlobal('PublicKeyCredential', { signalUnknownCredential: signal });
    try {
      const t = setup();
      t.postJson = vi.fn(async (path) => {
        if (path === '/api/auth') throw new VelvetRopeError(401, 'verification_failed', 'x');
        return { challenge: 'c' };
      });
      await expect(createClient(t).signIn()).rejects.toMatchObject({ code: 'verification_failed' });
      expect(signal).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
