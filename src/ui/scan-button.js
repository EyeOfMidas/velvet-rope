// A "Scan to link a device" button for a signed-in device: opens the scanner, then a confirm dialog
// for the code it reads. Show it only to roles that can link.
import { openClaimDialog } from './claim-dialog.js';
import { createElement } from './create-element.js';

// The scanner (and jsQR) only load once someone scans.
const openScannerLazily = (options) => import('./scanner.js').then((m) => m.openScanner(options));

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
 * linkPath). `claimDialog`: options passed through to openClaimDialog (renderProfile, text, classes).
 */
export function createScanButton({
  client,
  onLinked,
  onError = () => {},
  onScan = () => {},
  text: textOverrides = {},
  className,
  scanner = {},
  claimDialog = {},
  openScanner = openScannerLazily,
}) {
  const text = { ...SCAN_BUTTON_TEXT, ...textOverrides };
  const button = createElement('button', { type: 'button', ...(className ? { className } : {}) }, text.button);

  // The scan only opens the confirm dialog; nothing is approved until the member confirms.
  function claim(token) {
    const host = createElement('div');
    document.body.append(host);
    const finish = () => {
      dialog.close();
      host.remove();
      button.focus();
    };
    const dialog = openClaimDialog(host, {
      ...claimDialog,
      client,
      token,
      onClaimed: (result) => {
        finish();
        onLinked(result);
      },
      onCancel: finish,
      onError: (message) => {
        finish();
        onError(message);
      },
    });
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
