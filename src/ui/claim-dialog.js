// The confirm screen after a signed-in device scans a join code: shows who is asking to join (label,
// name, the app's own rendering of the profile) and the ways this member may add the device. The
// scan alone never approves anything; the confirm button does. Only the outcomes the server
// allowed for this member's role are offered, so the choice here is a convenience, not a gate.
import { createElement, createLiveRegion } from './create-element.js';

export const CLAIM_TEXT = Object.freeze({
  title: 'Add this device?',
  deviceLabel: 'Device',
  nameLabel: 'Name',
  newMember: 'New member',
  ownDevice: 'Add to my devices',
  member: 'This is someone’s device',
  signOutHere: 'Sign out this device',
  signOutOthers: 'Sign out their other devices',
  pickMember: 'Whose device is it?',
  confirm: 'Add device',
  cancel: 'Cancel',
  none: 'You can’t add this device.',
  failed: 'Could not add the device. Check your connection.',
});

export const CLAIM_CLASSES = Object.freeze({
  root: 'vr-claim',
  profile: 'vr-claim-profile',
  choice: 'vr-claim-choice',
  actions: 'vr-actions',
  error: 'vr-error',
  primary: 'vr-primary',
});

/**
 * Renders the claim dialog into `container`: peeks at `token`, then lets the member confirm.
 * - `client`: from createClient().
 * - `renderProfile(profile)`: optional; returns a DOM node for the app's profile (never HTML).
 * - `onClaimed(result)`: after a successful claim. `onCancel()`: on Cancel.
 * - `onError(message)`: when the preview itself is refused or fails (a failed claim stays in the
 *   dialog, with its message shown, so the member can retry or cancel).
 * - `text`, `classes`: overrides for CLAIM_TEXT and CLAIM_CLASSES.
 * Returns { close }, which empties the container.
 */
export function openClaimDialog(
  container,
  {
    client,
    token,
    renderProfile,
    text: textOverrides = {},
    classes: classOverrides = {},
    onClaimed,
    onCancel = () => {},
    onError = () => {},
  },
) {
  const text = { ...CLAIM_TEXT, ...textOverrides };
  const classes = { ...CLAIM_CLASSES, ...classOverrides };
  let closed = false;
  const describe = (e) => (e?.status ? e.message : text.failed);

  let onKey = null;
  function close() {
    closed = true;
    if (onKey) document.removeEventListener('keydown', onKey);
    container.replaceChildren();
  }

  // Modal behaviour by hand: Escape cancels, Tab wraps inside the dialog. Removed again on close.
  function show(parts, first) {
    const dialog = createElement('section', {
      className: classes.root,
      role: 'dialog',
    });
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'vr-claim-title');
    parts[0].id = 'vr-claim-title';
    dialog.append(...parts);
    container.replaceChildren(dialog);
    onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        onCancel();
      } else if (e.key === 'Tab') {
        const items = [...dialog.querySelectorAll('input, select, button')].filter((x) => !x.disabled);
        const edge = e.shiftKey ? items[0] : items.at(-1);
        if (items.length && (document.activeElement === edge || !dialog.contains(document.activeElement))) {
          e.preventDefault();
          (e.shiftKey ? items.at(-1) : items[0]).focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    first.focus();
  }

  const checkbox = (name, label) => {
    const input = createElement('input', { type: 'checkbox', name });
    return { input, row: createElement('label', {}, input, ' ', label) };
  };

  function render(peek, others) {
    const error = createLiveRegion('p', 'alert', classes.error);
    const cancel = createElement('button', { type: 'button' }, text.cancel);
    cancel.addEventListener('click', () => {
      close();
      onCancel();
    });
    // A relink needs someone to relink to.
    const outcomes = peek.outcomes.filter((o) => o !== 'member' || others.length > 0);
    const parts = [createElement('h2', {}, text.title), createElement('p', {}, `${text.deviceLabel}: ${peek.label}`)];
    if (peek.name) parts.push(createElement('p', {}, `${text.nameLabel}: ${peek.name}`));
    if (renderProfile && peek.profile != null) {
      parts.push(createElement('div', { className: classes.profile }, renderProfile(peek.profile)));
    }
    if (outcomes.length === 0) {
      parts.push(createElement('p', {}, text.none), createElement('div', { className: classes.actions }, cancel));
      show(parts, cancel);
      return;
    }

    // Each outcome reads its own controls when chosen.
    const choices = {};
    const optionsFor = {
      'new-member': { label: text.newMember },
      'own-device': { label: text.ownDevice },
      member: { label: text.member },
    };
    const own = checkbox('signOut-own-device', text.signOutHere);
    const theirs = checkbox('signOut-member', text.signOutOthers);
    const picker = createElement('select', { name: 'memberId' });
    picker.setAttribute('aria-label', text.pickMember);
    picker.append(...others.map((m) => createElement('option', { value: m.id }, m.name)));
    const extras = {
      'new-member': [],
      'own-device': [own.row],
      member: [createElement('label', {}, text.pickMember, ' ', picker), theirs.row],
    };
    const single = outcomes.length === 1;
    if (!(single && outcomes[0] === 'new-member')) {
      for (const outcome of outcomes) {
        const radio = createElement('input', { type: 'radio', name: 'outcome', value: outcome });
        radio.checked = outcome === outcomes[0];
        choices[outcome] = radio;
        const label = createElement('label', {}, ...(single ? [] : [radio, ' ']), optionsFor[outcome].label);
        parts.push(createElement('div', { className: classes.choice }, label, ...extras[outcome]));
      }
    }
    const selected = () => (single ? outcomes[0] : (outcomes.find((o) => choices[o]?.checked) ?? outcomes[0]));

    const confirm = createElement('button', { type: 'button', className: classes.primary }, text.confirm);
    confirm.dataset.role = 'confirm';
    confirm.addEventListener('click', async () => {
      const outcome = selected();
      const options = { outcome };
      if (outcome === 'own-device') options.signOut = own.input.checked ? 'scanner' : 'none';
      if (outcome === 'member') {
        options.memberId = picker.value;
        options.signOut = theirs.input.checked ? 'others' : 'none';
      }
      error.hidden = true;
      confirm.disabled = true;
      try {
        const result = await client.claimLink(token, options);
        if (!closed) close();
        onClaimed(result);
      } catch (e) {
        if (closed) return;
        error.textContent = describe(e);
        error.hidden = false;
        confirm.disabled = false;
      }
    });
    parts.push(error, createElement('div', { className: classes.actions }, confirm, cancel));
    show(parts, confirm);
  }

  (async () => {
    try {
      const peek = await client.peekLink(token);
      const others = peek.outcomes.includes('member') ? (await client.listMembers()).filter((m) => !m.current) : [];
      if (!closed) render(peek, others);
    } catch (e) {
      if (!closed) onError(describe(e));
    }
  })();

  return { close };
}
