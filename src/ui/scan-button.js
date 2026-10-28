// A "Scan to link a device" button for a signed-in device: opens the scanner and claims the code
// it reads. The scan is the approval, so there's no prompt. Show it only to roles that can link.
import { createElement } from './create-element.js';

// The scanner (and jsQR) only load once someone scans.
const loadScanner = (options) => import('./scanner.js').then((m) => m.openScanner(options));

export const SCAN_BUTTON_TEXT = Object.freeze({
  button: 'Scan to link a device',
  failed: 'Could not link the device. Check your connection.',
});

/** Appends a scan button (see createScanButton) to `container` and returns it. */
export function mountScanButton(container, options) {
  const button = createScanButton(options);
  container.append(button);
  return button;
}

/**
 * The button on its own, for the app to place. onLinked({ label }) after a claim; onError(message)
 * when one fails. `scanner`: options passed through to openScanner (text, classes, origin,
 * linkPath).
 */
export function createScanButton({
  client,
  onLinked,
  onError = () => {},
  onScan = () => {},
  text: textOverrides = {},
  className,
  scanner = {},
  openScanner = loadScanner,
}) {
  const text = { ...SCAN_BUTTON_TEXT, ...textOverrides };
  const button = createElement('button', { type: 'button', ...(className ? { className } : {}) }, text.button);

  async function claim(token) {
    try {
      onLinked(await client.claimLink(token));
    } catch (e) {
      onError(e?.status ? e.message : text.failed);
    }
  }

  button.addEventListener('click', () => {
    onScan();
    openScanner({
      ...scanner,
      onToken: (token) => {
        claim(token);
        button.focus();
      },
      onClose: () => button.focus(),
    });
  });
  return button;
}
