// Join a group, the new device's side: label → join request → QR code of `<origin>/link#<token>`
// → wait for a signed-in device to scan it (the scan is the approval) → create this device's own
// passkey → signed in with the linked role.
import { labelFromUserAgent } from '../client/device-label.js';
import { linkUrl } from '../client/link-url.js';
import { renderQr, renderQrSvg as defaultRenderQrSvg } from '../client/qr.js';
import { watchJoin } from '../client/watch-join.js';
import { announced, h } from './h.js';

export const JOIN_TEXT = Object.freeze({
  title: 'Join a group',
  intro: 'Show a QR code here, then scan it with a device that’s already signed in to the group.',
  labelField: 'Name this passkey',
  showCode: 'Show QR code',
  scanThis: 'Scan this on a signed-in device.',
  qrLabel: 'QR code to join a group',
  expiresIn: 'Expires in',
  linkField: 'Can’t scan? Open this link on a signed-in device',
  copy: 'Copy link',
  copied: 'Copied',
  waiting: 'Waiting for a signed-in device…',
  expired: 'This code expired.',
  newCode: 'Get a new code',
  approved: 'Approved — creating your passkey…',
  approvedShort: 'Approved.',
  createPasskey: 'Create passkey',
  back: 'Back',
  needsTap: 'Your browser needs a tap to create the passkey.',
  failed: 'Something went wrong. Check your connection and try again.',
});

export const JOIN_CLASSES = Object.freeze({
  root: 'vr-join',
  body: 'vr-join-body',
  qr: 'vr-join-qr',
  countdown: 'vr-countdown',
  status: 'vr-join-status',
  field: 'vr-field',
  copyRow: 'vr-copy-row',
  hint: 'vr-hint',
  error: 'vr-error',
  primary: 'vr-primary',
});

function formatRemaining(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Renders the join flow into `container`. Calls onJoined(me) once signed in, onCancel() on Back.
 * `client` comes from createClient(). Returns { stop } to tear down the status stream and timers.
 */
export function mountJoin(
  container,
  {
    client,
    onJoined,
    onCancel = () => {},
    text: textOverrides = {},
    classes: classOverrides = {},
    userAgent = globalThis.navigator?.userAgent ?? '',
    origin = location.origin,
    linkPath = '/link',
    EventSource = globalThis.EventSource,
    // Returns the QR as an SVG string; swap it out in tests.
    renderQrSvg = defaultRenderQrSvg,
  },
) {
  const text = { ...JOIN_TEXT, ...textOverrides };
  const classes = { ...JOIN_CLASSES, ...classOverrides };
  const label = h('input', {
    id: 'passkey-label',
    name: 'label',
    required: true,
    maxLength: 60,
    value: labelFromUserAgent(userAgent),
  });
  const error = announced('p', 'alert', classes.error);
  const back = h('button', { type: 'button' }, text.back);
  const body = h('div', { className: classes.body });
  container.replaceChildren(h('section', { className: classes.root }, h('h2', {}, text.title), error, body, back));

  // Everything that runs in the background while a code is showing.
  let stopWatching = () => {};
  let tickTimer = null;
  let phase = 'form';

  function stopBackground() {
    stopWatching();
    stopWatching = () => {};
    clearInterval(tickTimer);
    tickTimer = null;
  }

  function stop() {
    stopBackground();
    phase = 'stopped';
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  function describeError(e) {
    if (e?.name === 'NotAllowedError' || e?.name === 'AbortError') return text.needsTap;
    return e?.status ? e.message : text.failed;
  }

  function showForm() {
    phase = 'form';
    const submit = h('button', { type: 'submit', className: classes.primary }, text.showCode);
    const form = h(
      'form',
      {},
      h('p', {}, text.intro),
      h('div', { className: classes.field }, h('label', { htmlFor: 'passkey-label' }, text.labelField), label),
      submit,
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      const started = await requestCode();
      if (!started) submit.disabled = false;
    });
    body.replaceChildren(form);
    label.focus();
  }

  async function requestCode() {
    error.hidden = true;
    try {
      const request = await client.requestJoin(label.value);
      if (phase === 'stopped') return true;
      await showCode(request);
      return true;
    } catch (e) {
      showError(describeError(e));
      return false;
    }
  }

  async function showCode({ token, expiresAt }) {
    const url = linkUrl(origin, token, linkPath);
    const qr = await renderQr(url, { label: text.qrLabel, render: renderQrSvg });
    if (phase === 'stopped') return;
    phase = 'waiting';
    const expires = new Date(expiresAt).getTime();
    qr.setAttribute('class', classes.qr);
    qr.dataset.url = url;
    const countdown = h('p', { className: classes.countdown });
    const tick = () => {
      const left = expires - Date.now();
      if (left <= 0) return showExpired();
      countdown.textContent = `${text.expiresIn} ${formatRemaining(left)}`;
    };
    const link = h('input', {
      id: 'link-url',
      readOnly: true,
      value: url,
      dataset: { testid: 'link-url' },
    });
    link.addEventListener('focus', () => link.select());
    const copy = h('button', { type: 'button' }, text.copy);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = text.copied;
      } catch {
        link.select();
      }
    });
    copy.hidden = !globalThis.navigator?.clipboard?.writeText;

    body.replaceChildren(
      h('p', {}, text.scanThis),
      qr,
      countdown,
      h(
        'div',
        { className: classes.field },
        h('label', { htmlFor: 'link-url' }, text.linkField),
        h('div', { className: classes.copyRow }, link, copy),
      ),
      h('p', { className: classes.hint }, text.waiting),
    );
    tick();
    tickTimer = setInterval(tick, 1000);
    stopWatching = watchJoin({ client, EventSource, onStatus });
  }

  function onStatus(data) {
    if (phase !== 'waiting') return;
    if (data.status === 'claimed') createPasskey();
    else if (data.status === 'expired') showExpired();
  }

  function showExpired() {
    stopBackground();
    phase = 'expired';
    const again = h('button', { type: 'button', className: classes.primary }, text.newCode);
    again.addEventListener('click', async () => {
      again.disabled = true;
      if (!(await requestCode())) again.disabled = false;
    });
    body.replaceChildren(h('p', { className: classes.status }, text.expired), again);
    again.focus();
  }

  async function createPasskey() {
    stopBackground();
    phase = 'creating';
    error.hidden = true;
    const status = h('p', { className: classes.status }, text.approved);
    status.setAttribute('role', 'status');
    body.replaceChildren(status);
    try {
      const me = await client.completeJoin();
      if (phase === 'stopped') return;
      stop();
      await onJoined(me);
    } catch (e) {
      if (phase === 'stopped') return;
      // 409: the request is no longer claimed (expired or used); 404: it was pruned.
      if ([404, 409, 410].includes(e?.status)) return showExpired();
      // Firefox may refuse create() without a fresh user gesture; a button press provides one.
      const retry = h('button', { type: 'button', className: classes.primary }, text.createPasskey);
      retry.addEventListener('click', createPasskey);
      status.textContent = text.approvedShort;
      showError(describeError(e));
      body.append(retry);
      retry.focus();
    }
  }

  back.addEventListener('click', () => {
    stop();
    onCancel();
  });

  showForm();
  return { stop };
}
