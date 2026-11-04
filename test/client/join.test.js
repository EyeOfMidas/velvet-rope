// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VelvetRopeError } from '../../src/client/api.js';
import { createClient } from '../../src/client/client.js';
import { mountJoin } from '../../src/ui/join.js';

// The app's transport and passkey function are faked in `deps`, the way an app injects them.
const renderJoin = (container, deps) =>
  mountJoin(container, {
    ...deps,
    client: createClient(deps),
    renderQrSvg: deps.renderQr,
  });

const ORIGIN = 'https://app.test';
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789';
const ME = {
  passkey: { id: 'p2', label: 'Desktop', role: 'viewer' },
  group: { id: 's1', name: 'Plans' },
};
const FIVE_MINUTES = 5 * 60 * 1000;

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.close = vi.fn();
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type, data) {
    for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data) });
  }
}
const lastSource = () => FakeEventSource.instances.at(-1);

function setup(overrides = {}) {
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  let requests = 0;
  const deps = {
    origin: ORIGIN,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
    EventSource: FakeEventSource,
    renderQr: vi.fn(async (text) => `<svg data-text="${text}"></svg>`),
    getJson: vi.fn(async () => ({ status: 'pending', expiresAt: Date.now() + FIVE_MINUTES })),
    postJson: vi.fn(async (path) => {
      if (path === '/api/link-requests') {
        requests += 1;
        return {
          id: `r${requests}`,
          token: `${TOKEN}${requests}`,
          expiresAt: Date.now() + FIVE_MINUTES,
        };
      }
      if (path === '/api/link-requests/current/options') return { challenge: 'c' };
      if (path === '/api/link-requests/current/complete') return ME;
      throw new Error(`unexpected ${path}`);
    }),
    startRegistration: vi.fn(async () => ({ id: 'cred' })),
    onJoined: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const view = renderJoin(container, deps);
  return { container, deps, view };
}

const button = (root, name) => [...root.querySelectorAll('button')].find((b) => b.textContent === name && !b.hidden);
const text = (root) => root.textContent.replace(/\s+/g, ' ');

async function showCode(container) {
  container.querySelector('form').requestSubmit();
  await vi.waitFor(() => expect(container.querySelector('[data-testid=link-url]')).toBeTruthy());
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe('join a group', () => {
  it('asks for a label, pre-filled from the browser', () => {
    const { container } = setup();
    const input = container.querySelector('#passkey-label');
    expect(container.querySelector('label[for="passkey-label"]').textContent).toBe('Name this passkey');
    expect(input.value).toBe('Firefox on Windows');
    expect(button(container, 'Show QR code').type).toBe('submit');
  });

  it('starts a link request and shows its QR code, link and countdown', async () => {
    const { container, deps } = setup();
    container.querySelector('#passkey-label').value = 'Desktop';
    await showCode(container);
    expect(deps.postJson).toHaveBeenCalledWith('/api/link-requests', { label: 'Desktop' });
    const url = `${ORIGIN}/link#${TOKEN}1`;
    expect(deps.renderQr).toHaveBeenCalledWith(url);
    // Inline SVG, since the CSP's `img-src 'self'` blocks data: URLs.
    expect(container.querySelector('img')).toBeNull();
    const qr = container.querySelector('svg.vr-join-qr');
    expect(qr.getAttribute('role')).toBe('img');
    expect(qr.getAttribute('aria-label')).toBe('QR code to join a group');
    expect(qr.dataset.url).toBe(url);
    expect(qr.getAttribute('data-text')).toBe(url);
    const link = container.querySelector('[data-testid=link-url]');
    expect(link.value).toBe(url);
    expect(link.readOnly).toBe(true);
    expect(container.querySelector(`label[for="${link.id}"]`).textContent).toBe(
      'Can’t scan? Open this link on a signed-in device',
    );
    expect(text(container)).toContain('Expires in 5:00');
    expect(lastSource().url).toBe('/api/link-requests/current/events');
  });

  it('counts down to expiry', async () => {
    const { container } = setup();
    await showCode(container);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(text(container)).toContain('Expires in 3:59');
  });

  it('creates the passkey as soon as a signed-in device claims the code', async () => {
    const { container, deps } = setup();
    await showCode(container);
    let finish;
    deps.startRegistration.mockImplementation(() => new Promise((r) => (finish = r)));
    lastSource().emit('status', { status: 'claimed', groupName: 'Plans' });
    await vi.waitFor(() => expect(text(container)).toContain('Approved — creating your passkey…'));
    expect(deps.postJson).toHaveBeenCalledWith('/api/link-requests/current/options', {});
    finish({ id: 'cred' });
    await vi.waitFor(() => expect(deps.onJoined).toHaveBeenCalledWith(ME));
    expect(deps.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'c' } });
    expect(deps.postJson).toHaveBeenCalledWith('/api/link-requests/current/complete', {
      response: { id: 'cred' },
    });
    expect(lastSource().close).toHaveBeenCalled();
  });

  it('offers a Create passkey button when the browser wants a tap first', async () => {
    const { container, deps } = setup();
    await showCode(container);
    deps.startRegistration.mockRejectedValueOnce(
      Object.assign(new Error('needs activation'), { name: 'NotAllowedError' }),
    );
    lastSource().emit('status', { status: 'claimed' });
    await vi.waitFor(() => expect(button(container, 'Create passkey')).toBeTruthy());
    expect(deps.onJoined).not.toHaveBeenCalled();
    button(container, 'Create passkey').click();
    await vi.waitFor(() => expect(deps.onJoined).toHaveBeenCalledWith(ME));
    expect(deps.startRegistration).toHaveBeenCalledTimes(2);
  });

  it('says the code expired and gets a new one', async () => {
    const { container, deps } = setup();
    await showCode(container);
    lastSource().emit('status', { status: 'expired' });
    await vi.waitFor(() => expect(text(container)).toContain('This code expired'));
    expect(container.querySelector('img')).toBeNull();
    expect(lastSource().close).toHaveBeenCalled();
    button(container, 'Get a new code').click();
    await vi.waitFor(() =>
      expect(container.querySelector('[data-testid=link-url]').value).toBe(`${ORIGIN}/link#${TOKEN}2`),
    );
    expect(deps.postJson).toHaveBeenLastCalledWith('/api/link-requests', {
      label: 'Firefox on Windows',
    });
  });

  it('says the code expired when the server no longer accepts the claimed request', async () => {
    const { container, deps } = setup();
    await showCode(container);
    deps.postJson.mockRejectedValueOnce(new VelvetRopeError(409, 'link_not_claimed', 'Join request is not claimed'));
    lastSource().emit('status', { status: 'claimed' });
    await vi.waitFor(() => expect(text(container)).toContain('This code expired'));
    expect(button(container, 'Get a new code')).toBeTruthy();
    expect(deps.startRegistration).not.toHaveBeenCalled();
  });

  it('shows an app’s refusal at completion with a retry, not the expired screen', async () => {
    const { container, deps } = setup();
    await showCode(container);
    deps.postJson.mockRejectedValueOnce(new VelvetRopeError(409, 'not_today', 'Not today'));
    lastSource().emit('status', { status: 'claimed' });
    await vi.waitFor(() => expect(container.querySelector('[role=alert]').textContent).toBe('Not today'));
    expect(text(container)).not.toContain('This code expired');
    expect(button(container, 'Create passkey')).toBeTruthy();
  });

  it.each([
    [409, 'link_taken'],
    [410, 'link_expired'],
  ])('still says the code expired for %i %s', async (status, code) => {
    const { container, deps } = setup();
    await showCode(container);
    deps.postJson.mockRejectedValueOnce(new VelvetRopeError(status, code, 'gone'));
    lastSource().emit('status', { status: 'claimed' });
    await vi.waitFor(() => expect(text(container)).toContain('This code expired'));
  });

  it('expires on its own when the countdown runs out', async () => {
    const { container } = setup();
    await showCode(container);
    await vi.advanceTimersByTimeAsync(FIVE_MINUTES + 1000);
    expect(text(container)).toContain('This code expired');
    expect(button(container, 'Get a new code')).toBeTruthy();
  });

  it('falls back to polling when the status stream fails', async () => {
    const { container, deps } = setup();
    await showCode(container);
    lastSource().emit('error', {});
    expect(lastSource().close).toHaveBeenCalled();
    deps.getJson.mockResolvedValue({ status: 'claimed', groupName: 'Plans' });
    await vi.advanceTimersByTimeAsync(2500);
    expect(deps.getJson).toHaveBeenCalledWith('/api/link-requests/current');
    await vi.waitFor(() => expect(deps.onJoined).toHaveBeenCalledWith(ME));
  });

  it('shows the server’s message when the request can’t be started', async () => {
    const { container, deps } = setup();
    deps.postJson.mockRejectedValueOnce(new VelvetRopeError(429, 'too_many_requests', 'Too many requests'));
    container.querySelector('form').requestSubmit();
    await vi.waitFor(() => expect(container.querySelector('[role=alert]').textContent).toBe('Too many requests'));
    expect(button(container, 'Show QR code').disabled).toBe(false);
  });

  it('stops listening and counting when the user goes back', async () => {
    const { container, deps } = setup();
    await showCode(container);
    button(container, 'Back').click();
    expect(deps.onCancel).toHaveBeenCalled();
    expect(lastSource().close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('renewal, device keys and the outcome message', () => {
    const KEY_ME = { ...ME, member: { id: 'm1', name: 'Sam' } };
    afterEach(() => vi.unstubAllGlobals());
    const routes = (deps, extra = {}) => {
      const base = deps.postJson.getMockImplementation();
      deps.postJson.mockImplementation(async (path, body) => {
        if (path in extra) return extra[path](body);
        return base(path, body);
      });
    };

    it('renews the code while it is showing and stops after a claim', async () => {
      const { container, deps } = setup();
      routes(deps, { '/api/link-requests/current/renew': async () => ({ expiresAt: Date.now() + FIVE_MINUTES }) });
      await showCode(container);
      await vi.advanceTimersByTimeAsync(FIVE_MINUTES / 2 + 1000);
      expect(deps.postJson).toHaveBeenCalledWith('/api/link-requests/current/renew', {});
      expect(text(container)).toContain('Expires in');
      lastSource().emit('status', { status: 'claimed' });
      await vi.waitFor(() => expect(deps.onJoined).toHaveBeenCalled());
      const calls = () => deps.postJson.mock.calls.filter(([p]) => p.endsWith('/renew')).length;
      const before = calls();
      await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
      expect(calls()).toBe(before);
    });

    it('treats a refused renewal like an expiry', async () => {
      const { container, deps } = setup();
      routes(deps, {
        '/api/link-requests/current/renew': async () => {
          throw new VelvetRopeError(409, 'link_expired', 'Expired');
        },
      });
      await showCode(container);
      await vi.advanceTimersByTimeAsync(FIVE_MINUTES / 2 + 1000);
      expect(text(container)).toContain('This code expired');
    });

    it('offers the device key after the passkey step is not supported', async () => {
      const { container, deps } = setup();
      routes(deps, { '/api/link-requests/current/complete-key': async () => KEY_ME });
      await showCode(container);
      deps.startRegistration.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
      lastSource().emit('status', { status: 'claimed', credentials: ['passkey', 'key'] });
      await vi.waitFor(() => expect(button(container, 'Use this device without a passkey')).toBeTruthy());
      button(container, 'Use this device without a passkey').click();
      await vi.waitFor(() => expect(deps.onJoined).toHaveBeenCalledWith(KEY_ME));
      expect(deps.postJson).toHaveBeenCalledWith('/api/link-requests/current/complete-key', {});
    });

    it('offers the device key when no platform authenticator is available', async () => {
      vi.stubGlobal('PublicKeyCredential', { isUserVerifyingPlatformAuthenticatorAvailable: async () => false });
      const { container, deps } = setup();
      await showCode(container);
      lastSource().emit('status', { status: 'claimed', credentials: ['passkey', 'key'] });
      await vi.waitFor(() => expect(button(container, 'Use this device without a passkey')).toBeTruthy());
      expect(deps.startRegistration).not.toHaveBeenCalled();
    });

    it('offers no device key when the policy is passkey only', async () => {
      const { container, deps } = setup();
      await showCode(container);
      deps.startRegistration.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'NotSupportedError' }));
      lastSource().emit('status', { status: 'claimed', credentials: ['passkey'] });
      await vi.waitFor(() => expect(button(container, 'Create passkey')).toBeTruthy());
      expect(button(container, 'Use this device without a passkey')).toBeUndefined();
    });

    it('joins with a key straight away under a keys-only policy', async () => {
      const { container, deps } = setup();
      routes(deps, { '/api/link-requests/current/complete-key': async () => KEY_ME });
      await showCode(container);
      lastSource().emit('status', { status: 'claimed', credentials: ['key'] });
      await vi.waitFor(() => expect(deps.onJoined).toHaveBeenCalledWith(KEY_ME));
      expect(deps.startRegistration).not.toHaveBeenCalled();
    });

    it('welcomes a new member', async () => {
      const { container, deps } = setup();
      await showCode(container);
      lastSource().emit('status', { status: 'claimed', outcome: 'new-member' });
      await vi.waitFor(() => expect(deps.onJoined).toHaveBeenCalled());
      expect(text(container)).toContain('Welcome to Plans.');
    });

    it('says the device was added to a member', async () => {
      const { container, deps } = setup();
      routes(deps, { '/api/link-requests/current/complete': async () => KEY_ME });
      await showCode(container);
      lastSource().emit('status', { status: 'claimed', outcome: 'own-device' });
      await vi.waitFor(() => expect(deps.onJoined).toHaveBeenCalled());
      expect(text(container)).toContain('Added to Sam’s devices.');
    });

    it('retries a refused passkey completion from the options step', async () => {
      const { container, deps } = setup();
      await showCode(container);
      const complete = deps.postJson.getMockImplementation();
      deps.postJson.mockImplementation(async (path, body) => {
        if (path.endsWith('/complete')) {
          deps.postJson.mockImplementation(complete);
          throw new VelvetRopeError(403, 'vetoed', 'No');
        }
        return complete(path, body);
      });
      lastSource().emit('status', { status: 'claimed' });
      await vi.waitFor(() => expect(button(container, 'Create passkey')).toBeTruthy());
      button(container, 'Create passkey').click();
      await vi.waitFor(() => expect(deps.onJoined).toHaveBeenCalled());
      expect(deps.postJson.mock.calls.filter(([p]) => p.endsWith('/options')).length).toBe(2);
    });
  });

  describe('name and profile fields', () => {
    const KEY = 'join-draft';
    const fields = () =>
      vi.fn((box, saved) => {
        const input = document.createElement('input');
        input.id = 'app-nick';
        input.value = saved?.nick ?? '';
        box.append(input);
        return () => ({ nick: input.value });
      });

    beforeEach(() => localStorage.clear());
    afterEach(() => vi.unstubAllGlobals());

    it('sends the name and the app profile with the join request', async () => {
      const renderProfileFields = fields();
      const { container, deps } = setup({ renderProfileFields });
      expect(renderProfileFields).toHaveBeenCalledWith(expect.any(HTMLElement), undefined);
      expect(container.contains(renderProfileFields.mock.calls[0][0])).toBe(true);
      container.querySelector('#join-name').value = 'Sam';
      container.querySelector('#app-nick').value = 'sammy';
      await showCode(container);
      expect(deps.postJson).toHaveBeenCalledWith('/api/link-requests', {
        label: 'Firefox on Windows',
        name: 'Sam',
        profile: { nick: 'sammy' },
      });
    });

    it('shows a name field for askName alone', async () => {
      const { container, deps } = setup({ askName: true });
      container.querySelector('#join-name').value = 'Sam';
      await showCode(container);
      expect(deps.postJson).toHaveBeenCalledWith('/api/link-requests', { label: 'Firefox on Windows', name: 'Sam' });
    });

    it('sends only the label without the new options', async () => {
      const { container, deps } = setup();
      expect(container.querySelector('#join-name')).toBeNull();
      await showCode(container);
      expect(deps.postJson).toHaveBeenCalledWith('/api/link-requests', { label: 'Firefox on Windows' });
    });

    it('saves a draft as you type and restores it on a fresh mount', () => {
      const first = setup({ renderProfileFields: fields(), draftKey: KEY });
      const name = first.container.querySelector('#join-name');
      name.value = 'Sam';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const nick = first.container.querySelector('#app-nick');
      nick.value = 'sammy';
      nick.dispatchEvent(new Event('input', { bubbles: true }));
      expect(JSON.parse(localStorage.getItem(KEY))).toEqual({ name: 'Sam', profile: { nick: 'sammy' } });
      first.view.stop();

      const renderProfileFields = fields();
      const second = setup({ renderProfileFields, draftKey: KEY });
      expect(second.container.querySelector('#join-name').value).toBe('Sam');
      expect(renderProfileFields).toHaveBeenCalledWith(expect.any(HTMLElement), { nick: 'sammy' });
      expect(second.container.querySelector('#app-nick').value).toBe('sammy');
    });

    it('keeps no draft without a draftKey', () => {
      const { container } = setup({ askName: true });
      container.querySelector('#join-name').dispatchEvent(new Event('input', { bubbles: true }));
      expect(localStorage.length).toBe(0);
    });

    it('clears the draft once the join completes', async () => {
      const { container, deps } = setup({ askName: true, draftKey: KEY });
      const name = container.querySelector('#join-name');
      name.value = 'Sam';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      expect(localStorage.getItem(KEY)).not.toBeNull();
      await showCode(container);
      expect(localStorage.getItem(KEY)).not.toBeNull();
      lastSource().emit('status', { status: 'claimed' });
      await vi.waitFor(() => expect(deps.onJoined).toHaveBeenCalledWith(ME));
      expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('ignores storage that throws', async () => {
      const boom = () => {
        throw new Error('blocked');
      };
      vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
      const { container, deps } = setup({ askName: true, draftKey: KEY });
      const name = container.querySelector('#join-name');
      name.value = 'Sam';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      await showCode(container);
      lastSource().emit('status', { status: 'claimed' });
      await vi.waitFor(() => expect(deps.onJoined).toHaveBeenCalledWith(ME));
    });
  });
});
