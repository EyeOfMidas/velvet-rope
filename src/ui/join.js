// Join a group, the new device's side: label → join request → QR code of `<origin>/link#<token>`
// → wait for a signed-in device to scan it (the scan is the approval) → create this device's own
// passkey → signed in with the linked role.
import { labelFromUserAgent } from '../client/device-label.js';
import { linkUrl } from '../client/link-url.js';
import { renderQr, renderQrSvg as defaultRenderQrSvg } from '../client/qr.js';
import { watchJoin } from '../client/watch-join.js';
import { createLiveRegion, createElement } from './create-element.js';

// Server codes meaning the join request is gone, used, or no longer claimed.
const REQUEST_GONE = ['link_not_found', 'link_expired', 'link_taken', 'link_incomplete', 'link_not_claimed'];

export const JOIN_TEXT = Object.freeze({
  title: 'Join a group',
  intro: 'Show a QR code here, then scan it with a device that’s already signed in to the group.',
  labelField: 'Name this passkey',
  nameField: 'Your name',
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
  useKey: 'Use this device without a passkey',
  welcome: 'Welcome to {group}.',
  addedTo: 'Added to {member}’s devices.',
  failed: 'Something went wrong. Check your connection and try again.',
});

export const JOIN_CLASSES = Object.freeze({
  root: 'vr-join',
  body: 'vr-join-body',
  qr: 'vr-join-qr',
  countdown: 'vr-countdown',
  status: 'vr-join-status',
  field: 'vr-field',
  profile: 'vr-join-profile',
  copyRow: 'vr-copy-row',
  hint: 'vr-hint',
  error: 'vr-error',
  primary: 'vr-primary',
});

function formatRemaining(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// localStorage can throw (private mode, blocked storage); a lost draft is never worth an error.
function readDraft(key) {
  if (!key) return undefined;
  try {
    const draft = JSON.parse(localStorage.getItem(key));
    return draft && typeof draft === 'object' ? draft : undefined;
  } catch {
    return undefined;
  }
}

function writeDraft(key, draft) {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // ignored
  }
}

function clearDraft(key) {
  if (!key) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignored
  }
}

/**
 * Renders the join flow into `container`. Calls onJoined(me) once signed in, onCancel() on Back.
 * `client` comes from createClient(). Returns { stop } to tear down the status stream and timers.
 *
 * Optional, for apps that collect a profile when someone joins:
 * - `renderProfileFields(box, savedProfile)` renders the app's own fields into `box` and returns a
 *   `getProfile()` function. `savedProfile` is the profile from the saved draft, or undefined.
 * - `askName` shows a name field; one is also shown whenever `renderProfileFields` is given.
 * - `draftKey` is the localStorage key the name and profile are saved under as they change, and
 *   restored from on mount. The draft is cleared when the join completes. No key, no draft.
 * The name and profile are sent with the join request, only when present.
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
    renderProfileFields,
    askName = false,
    draftKey,
  },
) {
  const text = { ...JOIN_TEXT, ...textOverrides };
  const classes = { ...JOIN_CLASSES, ...classOverrides };
  const label = createElement('input', {
    id: 'passkey-label',
    name: 'label',
    required: true,
    maxLength: 60,
    value: labelFromUserAgent(userAgent),
  });
  const draft = readDraft(draftKey);
  const name = createElement('input', {
    id: 'join-name',
    name: 'name',
    maxLength: 60,
    value: typeof draft?.name === 'string' ? draft.name : '',
  });
  const showName = askName || Boolean(renderProfileFields);
  const profileBox = createElement('div', { className: classes.profile });
  const getProfile = renderProfileFields?.(profileBox, draft?.profile);
  const error = createLiveRegion('p', 'alert', classes.error);
  const back = createElement('button', { type: 'button' }, text.back);
  const body = createElement('div', { className: classes.body });
  container.replaceChildren(
    createElement('section', { className: classes.root }, createElement('h2', {}, text.title), error, body, back),
  );

  // Everything that runs in the background while a code is showing.
  let stopWatching = () => {};
  let tickTimer = null;
  let renewTimer = null;
  let phase = 'form';
  // The server's latest word on this request: which credentials it allows, and how it was claimed.
  let credentials = ['passkey'];
  let outcome;

  function stopBackground() {
    stopWatching();
    stopWatching = () => {};
    clearInterval(tickTimer);
    tickTimer = null;
    clearTimeout(renewTimer);
    renewTimer = null;
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
    const submit = createElement('button', { type: 'submit', className: classes.primary }, text.showCode);
    const form = createElement(
      'form',
      {},
      createElement('p', {}, text.intro),
      ...(showName
        ? [
            createElement(
              'div',
              { className: classes.field },
              createElement('label', { htmlFor: 'join-name' }, text.nameField),
              name,
            ),
          ]
        : []),
      ...(getProfile ? [profileBox] : []),
      createElement(
        'div',
        { className: classes.field },
        createElement('label', { htmlFor: 'passkey-label' }, text.labelField),
        label,
      ),
      submit,
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      submit.disabled = true;
      const started = await requestCode();
      if (!started) submit.disabled = false;
    });
    if (draftKey) {
      const save = () => writeDraft(draftKey, { name: name.value, profile: getProfile?.() });
      form.addEventListener('input', save);
      form.addEventListener('change', save);
    }
    body.replaceChildren(form);
    (showName ? name : label).focus();
  }

  async function requestCode() {
    error.hidden = true;
    try {
      const join = { label: label.value };
      if (showName && name.value.trim()) join.name = name.value.trim();
      const profile = getProfile?.();
      if (profile !== undefined) join.profile = profile;
      const request = await client.requestJoin(join);
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
    let expires = new Date(expiresAt).getTime();
    qr.setAttribute('class', classes.qr);
    qr.dataset.url = url;
    const countdown = createElement('p', { className: classes.countdown });
    const tick = () => {
      const left = expires - Date.now();
      if (left <= 0) return showExpired();
      countdown.textContent = `${text.expiresIn} ${formatRemaining(left)}`;
    };
    const link = createElement('input', {
      id: 'link-url',
      readOnly: true,
      value: url,
      dataset: { testid: 'link-url' },
    });
    link.addEventListener('focus', () => link.select());
    const copy = createElement('button', { type: 'button' }, text.copy);
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
      createElement('p', {}, text.scanThis),
      qr,
      countdown,
      createElement(
        'div',
        { className: classes.field },
        createElement('label', { htmlFor: 'link-url' }, text.linkField),
        createElement('div', { className: classes.copyRow }, link, copy),
      ),
      createElement('p', { className: classes.hint }, text.waiting),
    );
    tick();
    tickTimer = setInterval(tick, 1000);
    // Renew when half of the remaining time is left, so a slow fetch of a parent never loses the code;
    // each renewal pushes `expiresAt` out and the next one is scheduled from the new time.
    const scheduleRenew = () => {
      const wait = Math.max(1000, (expires - Date.now()) / 2);
      renewTimer = setTimeout(async () => {
        try {
          const renewed = await client.renewJoin();
          if (phase !== 'waiting') return;
          expires = new Date(renewed.expiresAt).getTime();
          tick();
        } catch (e) {
          // A refusal (expired, claimed, pruned) ends the code; a network blip is retried next time.
          if (phase === 'waiting' && e?.status) showExpired();
          else if (phase !== 'waiting') return;
        }
        if (phase === 'waiting') scheduleRenew();
      }, wait);
    };
    scheduleRenew();
    stopWatching = watchJoin({ client, EventSource, onStatus });
  }

  function onStatus(data) {
    if (phase !== 'waiting') return;
    if (Array.isArray(data.credentials)) credentials = data.credentials;
    if (data.outcome) outcome = data.outcome;
    if (data.status === 'claimed') completeJoin(false);
    else if (data.status === 'expired') showExpired();
  }

  function showExpired() {
    stopBackground();
    phase = 'expired';
    const again = createElement('button', { type: 'button', className: classes.primary }, text.newCode);
    again.addEventListener('click', async () => {
      again.disabled = true;
      if (!(await requestCode())) again.disabled = false;
    });
    body.replaceChildren(createElement('p', { className: classes.status }, text.expired), again);
    again.focus();
  }

  function showJoined(me) {
    const message =
      outcome === 'own-device' || outcome === 'member'
        ? text.addedTo.replace('{member}', me?.member?.name ?? '')
        : text.welcome.replace('{group}', me?.group?.name ?? '');
    const done = createElement('p', { className: classes.status }, message);
    done.setAttribute('role', 'status');
    body.replaceChildren(done);
  }

  async function finish(join) {
    const me = await join();
    if (phase === 'stopped') return;
    stop();
    clearDraft(draftKey);
    showJoined(me);
    await onJoined(me);
  }

  // `useKey` joins with a device key; otherwise a passkey, unless the policy is keys only.
  async function completeJoin(useKey = false) {
    stopBackground();
    phase = 'creating';
    error.hidden = true;
    const canKey = credentials.includes('key');
    const keyOnly = canKey && !credentials.includes('passkey');
    const key = keyOnly || useKey === true;
    const status = createElement('p', { className: classes.status }, key ? text.approvedShort : text.approved);
    status.setAttribute('role', 'status');
    body.replaceChildren(status);
    const keyButton = () => {
      const b = createElement('button', { type: 'button' }, text.useKey);
      b.addEventListener('click', () => completeJoin(true));
      return b;
    };
    try {
      // Without a platform authenticator, a passkey is unlikely: offer the key and let them choose.
      if (!key && canKey) {
        const available = await globalThis.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.();
        if (available === false) {
          status.textContent = text.approvedShort;
          const passkey = createElement('button', { type: 'button', className: classes.primary }, text.createPasskey);
          passkey.addEventListener('click', () => completeJoin(false));
          const use = keyButton();
          body.append(use, passkey);
          use.focus();
          return;
        }
      }
      await finish(key ? () => client.completeJoinWithKey() : () => client.completeJoin());
    } catch (e) {
      if (phase === 'stopped') return;
      // Only the library's own codes mean the request is gone or used. Any other refusal (an app's
      // hook veto) leaves it claimed, so show its message and let them retry.
      if (REQUEST_GONE.includes(e?.code)) return showExpired();
      status.textContent = text.approvedShort;
      showError(describeError(e));
      if (key) {
        const retry = createElement('button', { type: 'button', className: classes.primary }, text.useKey);
        retry.addEventListener('click', () => completeJoin(true));
        body.append(retry);
        retry.focus();
        return;
      }
      // Firefox may refuse create() without a fresh user gesture; a button press provides one. The
      // retry starts from the options step, since a refused completion has spent its challenge.
      const retry = createElement('button', { type: 'button', className: classes.primary }, text.createPasskey);
      retry.addEventListener('click', () => completeJoin(false));
      body.append(retry);
      if (canKey && e?.name === 'NotSupportedError') body.append(keyButton());
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
