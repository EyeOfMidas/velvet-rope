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

const button = (root, name) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === name && !b.hidden);
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
    expect(container.querySelector('label[for="passkey-label"]').textContent).toBe(
      'Name this passkey',
    );
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
      expect(container.querySelector('[data-testid=link-url]').value).toBe(
        `${ORIGIN}/link#${TOKEN}2`,
      ),
    );
    expect(deps.postJson).toHaveBeenLastCalledWith('/api/link-requests', {
      label: 'Firefox on Windows',
    });
  });

  it('says the code expired when the server no longer accepts the claimed request', async () => {
    const { container, deps } = setup();
    await showCode(container);
    deps.postJson.mockRejectedValueOnce(
      new VelvetRopeError(409, 'link_not_claimed', 'Join request is not claimed'),
    );
    lastSource().emit('status', { status: 'claimed' });
    await vi.waitFor(() => expect(text(container)).toContain('This code expired'));
    expect(button(container, 'Get a new code')).toBeTruthy();
    expect(deps.startRegistration).not.toHaveBeenCalled();
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
    deps.postJson.mockRejectedValueOnce(
      new VelvetRopeError(429, 'too_many_requests', 'Too many requests'),
    );
    container.querySelector('form').requestSubmit();
    await vi.waitFor(() =>
      expect(container.querySelector('[role=alert]').textContent).toBe('Too many requests'),
    );
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
});
