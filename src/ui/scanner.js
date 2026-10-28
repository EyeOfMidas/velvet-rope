// The in-app QR scanner dialog: a camera view over the page, with Torch and Cancel. The first
// join link on this origin it sees is handed to onToken; the camera stops whenever it closes.
import { startScanner } from '../client/camera.js';
import { parseLinkUrl } from '../client/link-url.js';
import { h } from './h.js';

export const SCANNER_TEXT = Object.freeze({
  label: 'Scan a join QR code',
  hint: 'Point the camera at the join QR code.',
  notAJoinCode: 'That QR code isn’t a join code for this site.',
  torchOn: 'Torch on',
  torchOff: 'Torch off',
  cancel: 'Cancel',
  blocked:
    'Camera access was blocked. Allow the camera for this site, or open the link with your camera app.',
  'no-camera': 'No camera was found. Open the link on this device instead.',
  failed: 'Could not open the camera. Open the link with your camera app instead.',
});

export const SCANNER_CLASSES = Object.freeze({
  root: 'vr-scanner',
  view: 'vr-scanner-view',
  hint: 'vr-scanner-hint',
  error: 'vr-error',
  actions: 'vr-actions',
});

/** Opens the scanner over the page. Returns { close }. */
export function openScanner({
  origin = location.origin,
  linkPath = '/link',
  onToken,
  onClose = () => {},
  text: textOverrides = {},
  classes: classOverrides = {},
  mediaDevices = navigator.mediaDevices,
  grabFrame,
  decode,
}) {
  const text = { ...SCANNER_TEXT, ...textOverrides };
  const classes = { ...SCANNER_CLASSES, ...classOverrides };
  const video = h('video', { muted: true, playsInline: true, autoplay: true });
  video.setAttribute('playsinline', '');
  const hint = h('p', { className: classes.hint }, text.hint);
  const error = h('p', { className: classes.error, hidden: true });
  error.setAttribute('role', 'alert');
  const torch = h('button', { type: 'button', hidden: true }, text.torchOn);
  const cancel = h('button', { type: 'button' }, text.cancel);
  const dialog = h(
    'div',
    { className: classes.root },
    h('div', { className: classes.view }, video),
    hint,
    error,
    h('div', { className: classes.actions }, torch, cancel),
  );
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', text.label);

  let closed = false;
  let stopCamera = () => {};

  function close() {
    if (closed) return;
    closed = true;
    stopCamera();
    dialog.remove();
  }

  function offerTorch(track) {
    let on = false;
    torch.hidden = false;
    torch.setAttribute('aria-pressed', 'false');
    torch.addEventListener('click', async () => {
      try {
        await track.applyConstraints({ advanced: [{ torch: !on }] });
        on = !on;
        torch.textContent = on ? text.torchOff : text.torchOn;
        torch.setAttribute('aria-pressed', String(on));
      } catch {
        torch.hidden = true; // The capability lied; don't keep offering it.
      }
    });
  }

  cancel.addEventListener('click', () => {
    close();
    onClose();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    close();
    onClose();
  });

  document.body.append(dialog);
  cancel.focus();
  stopCamera = startScanner({
    video,
    mediaDevices,
    ...(grabFrame ? { grabFrame } : {}),
    ...(decode ? { decode } : {}),
    onText: (scanned) => {
      const token = parseLinkUrl(scanned, origin, linkPath);
      if (!token) {
        hint.textContent = text.notAJoinCode;
        return false;
      }
      close();
      onToken(token);
      return true;
    },
    onTorch: offerTorch,
    onError: (code) => {
      hint.hidden = true;
      error.textContent = text[code];
      error.hidden = false;
    },
  });
  return { close };
}
