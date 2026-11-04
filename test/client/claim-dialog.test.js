// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { openClaimDialog } from '../../src/ui/claim-dialog.js';

const MEMBERS = [
  { id: 'm1', name: 'Me', role: 'admin', current: true, devices: [] },
  { id: 'm2', name: 'Sam', role: 'member', current: false, devices: [] },
];

function setup({ outcomes = ['new-member', 'own-device', 'member'], claimLink } = {}) {
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  const client = {
    peekLink: vi.fn(async () => ({ label: 'Tablet', name: 'Kai', profile: { room: 4 }, outcomes })),
    claimLink: claimLink ?? vi.fn(async () => ({ label: 'Tablet' })),
    listMembers: vi.fn(async () => MEMBERS),
  };
  const onClaimed = vi.fn();
  const onCancel = vi.fn();
  const renderProfile = (p) => Object.assign(document.createElement('em'), { textContent: `Room ${p.room}` });
  openClaimDialog(container, { client, token: 'tok', renderProfile, onClaimed, onCancel, onError: vi.fn() });
  return { container, client, onClaimed, onCancel };
}

const ready = (container) => vi.waitFor(() => expect(container.querySelector('button')).not.toBeNull());
const radio = (container, value) => container.querySelector(`input[type=radio][value=${value}]`);
const confirm = (container) => container.querySelector('button[data-role=confirm]');

describe('openClaimDialog', () => {
  it('previews the label, name and the app’s profile node', async () => {
    const { container, client } = setup();
    await ready(container);
    expect(client.peekLink).toHaveBeenCalledWith('tok');
    expect(container.textContent).toContain('Tablet');
    expect(container.textContent).toContain('Kai');
    expect(container.querySelector('em').textContent).toBe('Room 4');
  });

  it('sends scanner when adding to my devices with the box ticked', async () => {
    const { container, client, onClaimed } = setup();
    await ready(container);
    radio(container, 'own-device').click();
    container.querySelector('input[name=signOut-own-device]').click();
    confirm(container).click();
    await vi.waitFor(() => expect(onClaimed).toHaveBeenCalledWith({ label: 'Tablet' }));
    expect(client.claimLink).toHaveBeenCalledWith('tok', { outcome: 'own-device', signOut: 'scanner' });
  });

  it('sends the picked member and others when relinking, leaving out my own member', async () => {
    const { container, client } = setup();
    await ready(container);
    await vi.waitFor(() => expect(container.querySelector('select')).not.toBeNull());
    const select = container.querySelector('select');
    expect([...select.options].map((o) => o.value)).toEqual(['m2']);
    radio(container, 'member').click();
    select.value = 'm2';
    container.querySelector('input[name=signOut-member]').click();
    confirm(container).click();
    await vi.waitFor(() =>
      expect(client.claimLink).toHaveBeenCalledWith('tok', { outcome: 'member', memberId: 'm2', signOut: 'others' }),
    );
  });

  it('defaults to a new member', async () => {
    const { container, client } = setup();
    await ready(container);
    confirm(container).click();
    await vi.waitFor(() => expect(client.claimLink).toHaveBeenCalledWith('tok', { outcome: 'new-member' }));
  });

  it('shows one confirm button when only a new member is possible', async () => {
    const { container } = setup({ outcomes: ['new-member'] });
    await ready(container);
    expect(container.querySelectorAll('input[type=radio]')).toHaveLength(0);
    expect(container.querySelectorAll('button[data-role=confirm]')).toHaveLength(1);
  });

  it('shows only Cancel when nothing is allowed', async () => {
    const { container, onCancel } = setup({ outcomes: [] });
    await ready(container);
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    buttons[0].click();
    expect(onCancel).toHaveBeenCalled();
  });

  it('shows the refusal message and stays open', async () => {
    const failure = Object.assign(new Error('Already used.'), { status: 409 });
    const { container, onClaimed } = setup({
      outcomes: ['new-member'],
      claimLink: vi.fn(async () => Promise.reject(failure)),
    });
    await ready(container);
    confirm(container).click();
    await vi.waitFor(() => expect(container.querySelector('[role=alert]').textContent).toBe('Already used.'));
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it('reports a refused preview through onError', async () => {
    const failure = Object.assign(new Error('Expired.'), { status: 410 });
    const onError = vi.fn();
    openClaimDialog(document.createElement('div'), {
      client: { peekLink: vi.fn(async () => Promise.reject(failure)) },
      token: 't',
      onClaimed: vi.fn(),
      onCancel: vi.fn(),
      onError,
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Expired.'));
  });
});

describe('openClaimDialog keyboard', () => {
  const press = (key, opts = {}) =>
    document.activeElement.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }),
    );
  const focusable = (container) => [...container.querySelectorAll('input, select, button')].filter((e) => !e.disabled);

  it('is a labelled modal dialog', async () => {
    const { container } = setup();
    await ready(container);
    const dialog = container.querySelector('[role=dialog]');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.querySelector(`#${dialog.getAttribute('aria-labelledby')}`).textContent).toBe('Add this device?');
  });

  it('cancels on Escape and empties the container', async () => {
    const { container, onCancel } = setup();
    await ready(container);
    press('Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(container.children).toHaveLength(0);
    press('Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('wraps Tab from the last control and Shift+Tab from the first', async () => {
    const { container } = setup();
    await ready(container);
    const items = focusable(container);
    items.at(-1).focus();
    expect(press('Tab')).toBe(false);
    expect(document.activeElement).toBe(items[0]);
    expect(press('Tab', { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(items.at(-1));
  });
});

describe('openClaimDialog member picker', () => {
  it('has an accessible name', async () => {
    const { container } = setup();
    await ready(container);
    expect(container.querySelector('select[name=memberId]').getAttribute('aria-label')).toBe('Whose device is it?');
  });
});
